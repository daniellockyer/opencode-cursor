import { Cursor, type ModelListItem, type ModelParameterValue } from "@cursor/sdk"
import { Model, Provider, type Plugin } from "@opencode/plugin"
import { apiKey } from "./auth.ts"
import { PACKAGE, PROVIDER_ID } from "./constants.ts"

// Cursor's catalog barely differs between accounts, so the saved list stays visible across connection changes
// until the refreshed one replaces it.
interface Catalog {
  models: ModelListItem[]
}

const STORAGE_KEY = "catalog"
const EFFORT_PARAMS = ["effort", "reasoning_effort", "reasoning"]
const DEFAULT_CONTEXT = 200_000

// Shown before the first catalog fetch, so a fresh connection has something to pick.
const FALLBACK: ModelListItem[] = [
  { id: "auto", displayName: "Auto" },
  {
    id: "composer-2.5",
    displayName: "Composer 2.5",
    parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }],
    variants: [
      { displayName: "Composer 2.5", params: [{ id: "fast", value: "false" }] },
      { displayName: "Composer 2.5 Fast", params: [{ id: "fast", value: "true" }], isDefault: true },
    ],
  },
]

export async function register(ctx: Plugin.Context) {
  const saved = (await ctx.storage.get(STORAGE_KEY)) as Catalog | undefined
  const current: { catalog: Catalog } = {
    catalog: saved && Array.isArray(saved.models) && saved.models.length > 0 ? saved : { models: FALLBACK },
  }

  await ctx.provider.transform((editor) => {
    const { catalog } = current
    editor.add({
      info: {
        ...Provider.Info.empty(Provider.ID.make(PROVIDER_ID)),
        name: "Cursor",
        activation: "auto",
        package: `aisdk:${PACKAGE}`,
      },
      models: catalog.models.map(toModel),
    })
  })

  let refreshing: Promise<void> | undefined
  const refresh = () => {
    refreshing ??= (async () => {
      const key = await apiKey(ctx)
      if (!key) return
      const models = await Cursor.models.list({ apiKey: key })
      const next: Catalog = { models: models.map(normalize) }
      if (JSON.stringify(next) === JSON.stringify(current.catalog)) return
      current.catalog = next
      await ctx.storage.set(STORAGE_KEY, next as never)
      await ctx.provider.reload()
    })()
      .catch((error) => console.warn("[opencode-cursor] could not load the Cursor model list:", error))
      .finally(() => {
        refreshing = undefined
      })
    return refreshing
  }

  void refresh()
  const controller = new AbortController()
  void (async () => {
    for await (const event of ctx.event.subscribe({
      types: ["credential.switched", "credential.updated"],
      signal: controller.signal,
    })) {
      if (event.type === "credential.switched" && event.data.integrationID !== PROVIDER_ID) continue
      void refresh()
    }
  })().catch(() => {})
  return () => controller.abort()
}

// "default" is Cursor's Auto; OpenCode reserves "default" for variant IDs, so use the alias.
function normalize(model: ModelListItem): ModelListItem {
  const id = model.id === "default" ? "auto" : model.id
  return {
    id,
    displayName: model.displayName,
    ...(model.parameters ? { parameters: model.parameters } : {}),
    ...(model.variants ? { variants: model.variants } : {}),
  }
}

export function toModel(model: ModelListItem): Model.Info {
  const providerID = Provider.ID.make(PROVIDER_ID)
  const base = Model.Info.default(providerID, Model.ID.make(model.id))
  const defaults = defaultParams(model)
  return {
    ...base,
    name: model.displayName,
    ...(defaults.length > 0 ? { settings: { params: defaults } } : {}),
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    variants: variants(model, defaults),
    // Usage is billed to the Cursor plan, so OpenCode shows no cost.
    cost: [],
    limit: { context: contextSize(defaults), output: 0 },
  }
}

function defaultParams(model: ModelListItem): ModelParameterValue[] {
  const variant = model.variants?.find((item) => item.isDefault) ?? model.variants?.[0]
  return variant?.params.map(({ id, value }) => ({ id, value })) ?? []
}

/** One OpenCode variant per reasoning effort (and Fast mode), each mapped to a preset Cursor offers. */
function variants(model: ModelListItem, defaults: ModelParameterValue[]): Model.Info["variants"] {
  const effort = model.parameters?.find((param) => EFFORT_PARAMS.includes(param.id))
  const fast = model.parameters?.find((param) => param.id === "fast")
  if (!effort && !fast) return []
  const efforts = effort ? effort.values.map((item) => item.value) : [undefined]
  const speeds = fast ? ["false", "true"] : [undefined]
  const result: Model.Info["variants"][number][] = []
  const seen = new Set<string>()
  for (const level of efforts) {
    for (const speed of speeds) {
      const wanted: ModelParameterValue[] = []
      if (effort && level) wanted.push({ id: effort.id, value: level })
      if (fast && speed) wanted.push({ id: fast.id, value: speed })
      const params = preset(model, wanted, defaults)
      if (!params) continue
      const id = [level, speed === "true" ? "fast" : !level && speed === "false" ? "standard" : undefined]
        .filter(Boolean)
        .join("-")
      if (!id || seen.has(id)) continue
      seen.add(id)
      result.push({ id: Model.VariantID.make(id), settings: { params } })
    }
  }
  return result
}

// Cursor only accepts some parameter combinations, so pick the listed preset closest to the model's default.
function preset(model: ModelListItem, wanted: ModelParameterValue[], defaults: ModelParameterValue[]) {
  const presets = model.variants?.length ? model.variants.map((item) => item.params) : [defaults]
  let best: { params: ModelParameterValue[]; score: number } | undefined
  for (const params of presets) {
    const value = (id: string) => params.find((param) => param.id === id)?.value
    if (!wanted.every((param) => value(param.id) === param.value)) continue
    const score = defaults.filter((param) => value(param.id) === param.value).length
    if (!best || score > best.score) best = { params, score }
  }
  if (best) return best.params.map(({ id, value }) => ({ id, value }))
  if (!model.variants?.length) return wanted
  return undefined
}

function contextSize(params: ModelParameterValue[]) {
  const value = params.find((param) => param.id === "context")?.value?.toLowerCase()
  const match = value?.match(/^(\d+(?:\.\d+)?)([km])$/)
  if (!match) return DEFAULT_CONTEXT
  const size = Number(match[1]) * (match[2] === "m" ? 1_000_000 : 1_000)
  return Number.isFinite(size) && size > 0 ? Math.round(size) : DEFAULT_CONTEXT
}

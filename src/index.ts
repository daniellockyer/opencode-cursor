import { Plugin } from "@opencode/plugin"
import * as Auth from "./auth.ts"
import * as Catalog from "./catalog.ts"
import {
  AGENT_OPTION,
  INSTRUCTIONS_OPTION,
  KIND_HEADER,
  PACKAGE,
  PLUGIN_ID,
  PROVIDER_ID,
  SYSTEM_OPTION,
} from "./constants.ts"
import { CursorLanguageModel, parseParams } from "./model.ts"
import * as Options from "./options.ts"
import { Sessions } from "./sessions.ts"

// Cursor writes its own date and environment details, so OpenCode's would repeat them.
const SUPPLIED_BY_CURSOR = new Set(["core/date", "core/environment"])

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const options = Options.parse(ctx.options)
    const sessions = new Sessions({
      directory: ctx.location.directory,
      options,
      storage: ctx.storage,
      authFailed: () => void markNeedsAuth(ctx),
    })

    await Auth.register(ctx)
    const stopCatalog = await Catalog.register(ctx)

    await ctx.aisdk.hook(
      "sdk",
      (event) => {
        if (event.package !== PACKAGE) return
        // OpenCode spreads the connection's API key and the model's settings into these options.
        const apiKey = typeof event.options.apiKey === "string" ? event.options.apiKey : undefined
        const params = parseParams(event.options.params)
        event.sdk = {
          languageModel: (modelID: string) =>
            new CursorLanguageModel(modelID, sessions, {
              ...(apiKey ? { apiKey } : {}),
              ...(params ? { params } : {}),
            }),
        }
      },
      { providerID: PROVIDER_ID },
    )

    await ctx.session.hook(
      "model.request",
      (event) => {
        event.headers[KIND_HEADER] = event.kind
      },
      { providerID: PROVIDER_ID },
    )

    for (const kind of ["context", "generate", "compaction"] as const) {
      await ctx.session.hook(
        kind,
        async (event) => {
          const agent = await ctx.agent.get({ agentID: event.agent }).catch(() => undefined)
          event.options[AGENT_OPTION] = agent?.data.system ?? ""
          event.options[INSTRUCTIONS_OPTION] = instructions(event.system)
          event.options[SYSTEM_OPTION] = event.system.map((part) => part.text).join("\n\n")
          // Cursor picks its own output budget.
          delete event.options.maxTokens
        },
        { providerID: PROVIDER_ID },
      )
    }

    // The Cursor SDK retries transient failures itself; replaying a whole turn could run tools twice.
    await ctx.session.hook(
      "retry",
      (event) => {
        event.decision = { retry: false }
      },
      { providerID: PROVIDER_ID },
    )

    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({
        types: ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"],
        signal: controller.signal,
      })) {
        await sessions.interrupt(event.data.sessionID).catch(() => {})
      }
    })().catch(() => {})

    return async () => {
      controller.abort()
      await stopCatalog()
      await sessions.close()
    }
  },
})

// The first part is OpenCode's own base prompt, which Cursor's harness prompt replaces.
function instructions(system: ReadonlyArray<{ text: string; metadata?: unknown }>) {
  const texts: string[] = []
  for (const part of system.slice(1)) {
    const sources = (part.metadata as { experimental?: { instructions?: unknown } } | undefined)?.experimental
      ?.instructions
    if (!Array.isArray(sources)) {
      texts.push(part.text)
      continue
    }
    for (const source of sources) {
      if (!source || typeof source.text !== "string") continue
      if (typeof source.key === "string" && SUPPLIED_BY_CURSOR.has(source.key)) continue
      texts.push(source.text)
    }
  }
  return texts.filter(Boolean).join("\n\n")
}

async function markNeedsAuth(ctx: Plugin.Context) {
  const connection = await ctx.integration.connection.active(PROVIDER_ID)
  if (!connection) return
  await ctx.integration.connection.status({
    integrationID: PROVIDER_ID,
    connection,
    status: { status: "needs_auth", message: "Cursor rejected the credentials. Log in to Cursor again." },
  })
}

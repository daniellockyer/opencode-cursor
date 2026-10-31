import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3FunctionTool,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider"
import type { ModelParameterValue } from "@cursor/sdk"
import { AGENT_OPTION, INSTRUCTIONS_OPTION, KIND_HEADER, PROVIDER_ID, SESSION_HEADER, SYSTEM_OPTION } from "./constants.ts"
import type { Sessions } from "./sessions.ts"
import { Step } from "./turn.ts"

export interface Settings {
  readonly apiKey?: string
  readonly params?: readonly ModelParameterValue[]
}

/** An OpenCode language model backed by a local Cursor SDK agent. */
export class CursorLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3"
  readonly provider = PROVIDER_ID
  readonly supportedUrls = {}

  constructor(
    readonly modelId: string,
    private readonly sessions: Sessions,
    private readonly settings: Settings,
  ) {}

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const headers = options.headers ?? {}
    const kind = headers[KIND_HEADER]
    const provider = options.providerOptions?.[PROVIDER_ID] ?? {}
    const tools =
      options.toolChoice?.type === "none"
        ? []
        : (options.tools ?? []).filter((tool): tool is LanguageModelV3FunctionTool => tool.type === "function")
    const params = parseParams(provider.params) ?? this.settings.params
    const step = new Step()
    if (options.abortSignal?.aborted) step.abort(options.abortSignal.reason)
    options.abortSignal?.addEventListener("abort", () => step.abort(options.abortSignal?.reason), { once: true })

    // Only the agent loop keeps a Cursor conversation. Titles, summaries and plugin calls run standalone.
    const sessionID = kind === "primary" ? headers[SESSION_HEADER] : undefined
    void this.sessions
      .run({
        ...(sessionID ? { sessionID } : {}),
        model: { id: this.modelId, ...(params && params.length > 0 ? { params: [...params] } : {}) },
        ...(this.settings.apiKey ? { apiKey: this.settings.apiKey } : {}),
        prompt: options.prompt,
        tools: sessionID ? tools : [],
        context: {
          ...text(provider[AGENT_OPTION], "agent"),
          ...text(provider[INSTRUCTIONS_OPTION], "instructions"),
          ...text(provider[SYSTEM_OPTION], "system"),
        },
        step,
      })
      .catch((error) => step.fail(error))
    return { stream: step.stream, request: { body: undefined } }
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const { stream } = await this.doStream(options)
    const content: LanguageModelV3Content[] = []
    let finishReason: LanguageModelV3FinishReason = { unified: "other", raw: undefined }
    let usage: LanguageModelV3Usage | undefined
    const reader = stream.getReader()
    const texts = new Map<string, { type: "text" | "reasoning"; text: string }>()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const part = value as LanguageModelV3StreamPart
      if (part.type === "text-start" || part.type === "reasoning-start") {
        const item = { type: part.type === "text-start" ? ("text" as const) : ("reasoning" as const), text: "" }
        texts.set(part.id, item)
        content.push(item)
      } else if (part.type === "text-delta" || part.type === "reasoning-delta") {
        const item = texts.get(part.id)
        if (item) item.text += part.delta
      } else if (part.type === "tool-call") {
        content.push(part)
      } else if (part.type === "finish") {
        finishReason = part.finishReason
        usage = part.usage
      } else if (part.type === "error") {
        throw part.error
      }
    }
    return {
      content,
      finishReason,
      usage: usage ?? {
        inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: undefined, text: undefined, reasoning: undefined },
      },
      warnings: [],
    }
  }
}

function text<Key extends string>(value: unknown, key: Key): { [K in Key]?: string } {
  return (typeof value === "string" ? { [key]: value } : {}) as { [K in Key]?: string }
}

export function parseParams(value: unknown): ModelParameterValue[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((item) =>
    item && typeof item === "object" && typeof item.id === "string" && typeof item.value === "string"
      ? [{ id: item.id, value: item.value }]
      : [],
  )
}

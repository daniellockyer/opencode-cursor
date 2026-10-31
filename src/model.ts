import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FunctionTool,
  LanguageModelV3Prompt,
  LanguageModelV3StreamResult,
} from "@ai-sdk/provider"
import type { ModelParameterValue } from "@cursor/sdk"
import { KIND_HEADER, PREAMBLE_OPTION, PROVIDER_ID, SESSION_HEADER } from "./constants.ts"
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

  async doGenerate(): Promise<never> {
    throw new Error("Cursor models only support streaming")
  }

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
    const preamble = typeof provider[PREAMBLE_OPTION] === "string" ? provider[PREAMBLE_OPTION] : systemText(options.prompt)
    void this.sessions
      .run({
        ...(sessionID ? { sessionID } : {}),
        model: { id: this.modelId, ...(params && params.length > 0 ? { params: [...params] } : {}) },
        ...(this.settings.apiKey ? { apiKey: this.settings.apiKey } : {}),
        prompt: options.prompt,
        tools: sessionID ? tools : [],
        ...(sessionID && preamble ? { preamble } : {}),
        step,
      })
      .catch((error) => step.fail(error))
    return { stream: step.stream, request: { body: undefined } }
  }
}

function systemText(prompt: LanguageModelV3Prompt) {
  const text = prompt
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n")
  return text || undefined
}

export function parseParams(value: unknown): ModelParameterValue[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((item) =>
    item && typeof item === "object" && typeof item.id === "string" && typeof item.value === "string"
      ? [{ id: item.id, value: item.value }]
      : [],
  )
}

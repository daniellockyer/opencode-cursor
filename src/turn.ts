import type {
  LanguageModelV3FinishReason,
  LanguageModelV3FunctionTool,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider"
import type {
  InteractionUpdate,
  Run,
  RunResult,
  SDKCustomTool,
  SDKCustomToolResult,
  SDKJsonValue,
  TokenUsage,
} from "@cursor/sdk"
import { createHash } from "node:crypto"
import { appendSteer, type Continuation } from "./convert.ts"
import { friendly } from "./errors.ts"

type Part = LanguageModelV3StreamPart

// Cursor starts parallel tool calls together; wait this long for the rest of a batch before ending OpenCode's step.
const BATCH_MS = 150

/** One OpenCode model request: the stream a single `doStream` call returns. */
export class Step {
  readonly stream: ReadableStream<Part>
  readonly done: Promise<void>
  private controller!: ReadableStreamDefaultController<Part>
  private settle!: () => void
  private closed = false
  private cancelled?: () => void

  constructor() {
    this.done = new Promise((resolve) => (this.settle = resolve))
    this.stream = new ReadableStream<Part>({
      start: (controller) => {
        this.controller = controller
        controller.enqueue({ type: "stream-start", warnings: [] })
      },
      cancel: () => {
        if (this.closed) return
        this.closed = true
        this.settle()
        this.cancelled?.()
      },
    })
  }

  get open() {
    return !this.closed
  }

  onCancel(callback: () => void) {
    this.cancelled = callback
  }

  push(part: Part) {
    if (!this.closed) this.controller.enqueue(part)
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.controller.close()
    this.settle()
  }

  fail(error: unknown) {
    if (this.closed) return
    this.closed = true
    this.controller.error(friendly(error))
    this.settle()
  }

  /** OpenCode aborted the request: end the stream and stop what it was waiting for. */
  abort(reason: unknown) {
    if (this.closed) return
    this.closed = true
    this.controller.error(reason instanceof Error ? reason : new DOMException("The request was aborted", "AbortError"))
    this.settle()
    this.cancelled?.()
  }
}

/**
 * One Cursor run. It can span several OpenCode steps: when Cursor calls an OpenCode tool, the step ends with the tool
 * calls and the run waits, holding the tool handlers, until OpenCode sends the results in its next request.
 */
export class Turn {
  run?: Run
  agentId?: string
  instructions?: string
  prompt: LanguageModelV3Prompt = []
  finished = false
  /** Tool calls OpenCode received in a finished step and is running now. */
  waiting: string[] = []

  private step?: Step
  private buffer: Part[] = []
  private current: string[] = []
  private handlers = new Map<string, (result: SDKCustomToolResult) => void>()
  private timer?: ReturnType<typeof setTimeout>
  private endRequested = false
  private text?: string
  private reasoning?: string
  private counter = 0
  private steps = 1
  private usage?: TokenUsage | Omit<TokenUsage, "totalTokens">
  private readonly done = Promise.withResolvers<void>()

  get settled() {
    return this.done.promise
  }

  /** OpenCode's tools as Cursor custom tools whose handlers park until OpenCode returns the results. */
  tools(tools: readonly LanguageModelV3FunctionTool[]): Record<string, SDKCustomTool> {
    const result: Record<string, SDKCustomTool> = {}
    for (const tool of tools) {
      result[cursorName(tool.name)] = {
        description: tool.description ?? "",
        inputSchema: tool.inputSchema as Record<string, SDKJsonValue>,
        execute: (args, context) => this.call(tool.name, args, context.toolCallId),
      }
    }
    return result
  }

  attach(step: Step) {
    this.step = step
    const buffered = this.buffer
    this.buffer = []
    for (const part of buffered) step.push(part)
    if (this.finished) return step.close()
    if (this.endRequested) this.endStep()
  }

  /** Releases the parked tool handlers with OpenCode's results. */
  resume(input: Continuation) {
    const last = this.waiting.at(-1)
    for (const id of this.waiting) {
      let result = input.results.get(id) as SDKCustomToolResult
      if (id === last && input.steer) result = appendSteer(result, input.steer)
      this.handlers.get(id)?.(result)
      this.handlers.delete(id)
    }
    this.waiting = []
  }

  delta(update: InteractionUpdate) {
    switch (update.type) {
      case "text-delta":
        if (!update.text) return
        this.closeReasoning()
        if (!this.text) {
          this.text = this.nextID("text")
          this.push({ type: "text-start", id: this.text })
        }
        this.push({ type: "text-delta", id: this.text, delta: update.text })
        return
      case "thinking-delta":
        if (!update.text) return
        this.closeText()
        if (!this.reasoning) {
          this.reasoning = this.nextID("reasoning")
          this.push({ type: "reasoning-start", id: this.reasoning })
        }
        this.push({ type: "reasoning-delta", id: this.reasoning, delta: update.text })
        return
      case "thinking-completed":
        this.closeReasoning()
        return
      case "turn-ended":
        if (update.usage) this.usage = update.usage
        return
    }
  }

  finish(result: RunResult) {
    if (this.finished) return
    this.closeText()
    this.closeReasoning()
    this.finished = true
    if (result.usage) this.usage = result.usage
    if (result.status === "error") {
      const id = result.requestId ? ` (request ${result.requestId})` : ""
      this.push({ type: "error", error: new Error(`Cursor: ${result.error?.message ?? "the run failed"}${id}`) })
    } else {
      const reason: LanguageModelV3FinishReason =
        result.status === "cancelled" ? { unified: "other", raw: "cancelled" } : { unified: "stop", raw: "finished" }
      this.push({ type: "finish", finishReason: reason, usage: this.usageSnapshot() })
    }
    this.release("The Cursor run ended before OpenCode returned the tool result.")
    this.step?.close()
    this.step = undefined
    this.done.resolve()
  }

  fail(error: unknown) {
    if (this.finished) return
    this.finished = true
    this.release("The Cursor run failed.")
    if (this.step) this.step.fail(error)
    else this.buffer.push({ type: "error", error: friendly(error) })
    this.step = undefined
    this.done.resolve()
  }

  /** Stops the run, for example after the user interrupted OpenCode. */
  async cancel() {
    if (this.finished) return
    this.finished = true
    clearTimeout(this.timer)
    this.release("Cancelled by the user.")
    this.step?.close()
    this.step = undefined
    await this.run?.cancel().catch(() => {})
    this.done.resolve()
  }

  /** Whether an OpenCode request is currently streaming this run. */
  get attached() {
    return this.step?.open === true
  }

  private call(name: string, args: Record<string, SDKJsonValue>, callID: string | undefined) {
    const id = callID ?? `call_${crypto.randomUUID()}`
    this.closeText()
    this.closeReasoning()
    this.push({ type: "tool-call", toolCallId: id, toolName: name, input: JSON.stringify(args ?? {}) })
    this.current.push(id)
    const result = new Promise<SDKCustomToolResult>((resolve) => this.handlers.set(id, resolve))
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.endStep(), BATCH_MS)
    return result
  }

  private endStep() {
    if (this.finished) return
    if (!this.step) {
      this.endRequested = true
      return
    }
    this.endRequested = false
    this.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage: emptyUsage() })
    this.waiting = this.current
    this.current = []
    this.steps++
    this.step.close()
    this.step = undefined
  }

  private release(message: string) {
    for (const handler of this.handlers.values()) handler({ content: [{ type: "text", text: message }], isError: true })
    this.handlers.clear()
  }

  private push(part: Part) {
    if (this.step) this.step.push(part)
    else this.buffer.push(part)
  }

  private nextID(kind: string) {
    return `${kind}-${++this.counter}`
  }

  private closeText() {
    if (!this.text) return
    this.push({ type: "text-end", id: this.text })
    this.text = undefined
  }

  private closeReasoning() {
    if (!this.reasoning) return
    this.push({ type: "reasoning-end", id: this.reasoning })
    this.reasoning = undefined
  }

  // Cursor reports one total for the whole run. OpenCode reads the last step's input as the context size, so spread
  // the input over the model calls instead of reporting the sum of every call's context.
  private usageSnapshot(): LanguageModelV3Usage {
    const usage = this.usage
    if (!usage) return emptyUsage()
    const calls = Math.max(1, this.steps)
    const share = (value: number) => Math.round(value / calls)
    const noCache = share(usage.inputTokens)
    const cacheRead = share(usage.cacheReadTokens)
    const cacheWrite = share(usage.cacheWriteTokens)
    const reasoning = usage.reasoningTokens
    return {
      inputTokens: { total: noCache + cacheRead + cacheWrite, noCache, cacheRead, cacheWrite },
      outputTokens: {
        total: usage.outputTokens,
        reasoning,
        text: reasoning === undefined ? usage.outputTokens : Math.max(0, usage.outputTokens - reasoning),
      },
    }
  }
}

function emptyUsage(): LanguageModelV3Usage {
  return {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  }
}

// MCP tool names allow letters, digits, `_` and `-`, up to 64 characters.
function cursorName(name: string) {
  if (name.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(name)) return name
  const suffix = createHash("sha256").update(name).digest("hex").slice(0, 8)
  return `${name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 55)}_${suffix}`
}

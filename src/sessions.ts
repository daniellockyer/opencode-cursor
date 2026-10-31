import type { LanguageModelV3FunctionTool, LanguageModelV3Prompt } from "@ai-sdk/provider"
import { Agent, type AgentOptions, type ModelSelection, type SDKAgent } from "@cursor/sdk"
import { createHash } from "node:crypto"
import { continuation, history, standaloneMessage, toCursor, unseen, unseenMessage } from "./convert.ts"
import { isAuthError } from "./errors.ts"
import { Step, Turn } from "./turn.ts"

export interface Request {
  /** Only the agent loop has one; titles, summaries and other side calls run as standalone agents. */
  readonly sessionID?: string
  readonly model: ModelSelection
  readonly apiKey?: string
  readonly prompt: LanguageModelV3Prompt
  readonly tools: readonly LanguageModelV3FunctionTool[]
  /** OpenCode's role and instructions. Sent with the first message and again when they change. */
  readonly preamble?: string
  readonly step: Step
}

interface Record {
  readonly agentId: string
  /** Fingerprints of the OpenCode history the agent has seen. */
  readonly history: readonly string[]
  /** Fingerprint of the preamble the agent was given. */
  readonly instructions?: string
}

interface Entry {
  queue: Promise<void>
  agent?: SDKAgent
  /** The API key the live handle was opened with. */
  apiKey?: string
  record?: Record
  loaded: boolean
  turn?: Turn
}

interface Storage {
  get(key: string): Promise<unknown>
  set(key: string, value: never): Promise<void>
}

export class Sessions {
  private readonly entries = new Map<string, Entry>()

  constructor(
    private readonly deps: {
      readonly directory: string
      readonly storage: Storage
      readonly authFailed: () => void
    },
  ) {}

  run(request: Request): Promise<void> {
    if (!request.sessionID) return this.standalone(request)
    const sessionID = request.sessionID
    const entry = this.entry(sessionID)
    return this.lock(entry, async () => {
      if (!entry.loaded) {
        entry.record = await this.load(sessionID)
        entry.loaded = true
      }
      const parked = entry.turn
      if (parked && !parked.finished) {
        const next = parked.waiting.length > 0 ? continuation(request.prompt, parked.waiting) : undefined
        if (next) {
          parked.prompt = request.prompt
          this.watch(sessionID, entry, parked, request.step)
          parked.attach(request.step)
          parked.resume(next)
          await request.step.done
          return
        }
        // OpenCode moved on without the results Cursor is waiting for, such as after an undo or interruption.
        await this.cancel(sessionID, entry, parked)
      }
      await this.start(sessionID, entry, request)
    })
  }

  /**
   * The session stopped. A run still waiting for tool results is cancelled, which drops the Cursor agent. Otherwise
   * the live handle is released; the conversation stays on disk and the next message resumes it.
   */
  async settle(sessionID: string) {
    const entry = this.entries.get(sessionID)
    if (!entry) return
    const turn = entry.turn
    if (turn && !turn.finished) {
      if (!turn.attached) await this.cancel(sessionID, entry, turn)
      return
    }
    entry.agent?.close()
    entry.agent = undefined
  }

  async close() {
    for (const [sessionID, entry] of this.entries) {
      if (entry.turn && !entry.turn.finished) await this.cancel(sessionID, entry, entry.turn).catch(() => {})
      entry.agent?.close()
    }
    this.entries.clear()
  }

  private async start(sessionID: string, entry: Entry, request: Request) {
    const preamble = request.preamble
    const instructions = fingerprint(preamble ?? "")

    let start = entry.record ? unseen(request.prompt, entry.record.history) : undefined
    if (start === undefined) await this.forget(sessionID, entry)

    const agentOptions: AgentOptions = {
      ...(request.apiKey ? { apiKey: request.apiKey } : {}),
      model: request.model,
      name: `OpenCode ${sessionID}`,
      // Only MCP tools: OpenCode's tools arrive as custom tools, which Cursor serves through MCP.
      tools: ["mcp"],
      local: { cwd: this.deps.directory },
    }
    // The API key is fixed when a handle opens, so a change reopens the same conversation.
    if (entry.agent && entry.apiKey !== request.apiKey) {
      entry.agent.close()
      entry.agent = undefined
    }
    let agent = entry.record ? entry.agent : undefined
    if (!agent && entry.record) {
      agent = await Agent.resume(entry.record.agentId, agentOptions).catch(() => undefined)
      if (!agent) await this.forget(sessionID, entry)
    }
    if (!entry.record) start = 0
    try {
      agent ??= await Agent.create(agentOptions)
    } catch (error) {
      if (isAuthError(error)) this.deps.authFailed()
      return request.step.fail(error)
    }
    entry.agent = agent
    entry.apiKey = request.apiKey

    const intro = start === 0 || entry.record?.instructions !== instructions ? preamble : undefined
    const message = unseenMessage(request.prompt, start ?? 0, intro)
    const turn = new Turn()
    turn.prompt = request.prompt
    entry.turn = turn
    this.watch(sessionID, entry, turn, request.step)
    turn.attach(request.step)

    const agentId = agent.agentId
    turn.agentId = agentId
    try {
      turn.run = await agent.send(toCursor(message), {
        model: request.model,
        onDelta: ({ update }) => turn.delta(update),
        local: { customTools: turn.tools(request.tools), force: true },
      })
    } catch (error) {
      if (isAuthError(error)) this.deps.authFailed()
      turn.fail(error)
      entry.turn = undefined
      return
    }
    void turn.run.wait().then(
      (result) => this.complete(sessionID, entry, turn, agentId, instructions, result),
      (error) => {
        if (isAuthError(error)) this.deps.authFailed()
        this.complete(sessionID, entry, turn, agentId, instructions, error)
      },
    )
    await request.step.done
  }

  private complete(
    sessionID: string,
    entry: Entry,
    turn: Turn,
    agentId: string,
    instructions: string,
    outcome: Awaited<ReturnType<NonNullable<Turn["run"]>["wait"]>> | unknown,
  ) {
    if (turn.finished) return
    // Record what Cursor saw before OpenCode can see the finish and send its next request.
    this.remember(sessionID, entry, { agentId, history: history(turn.prompt), instructions })
    if (entry.turn === turn) entry.turn = undefined
    if (isRunResult(outcome)) turn.finish(outcome)
    else turn.fail(outcome)
  }

  private async standalone(request: Request) {
    const { step } = request
    let agent: SDKAgent | undefined
    const turn = new Turn()
    turn.attach(step)
    step.onCancel(() => void turn.cancel())
    try {
      agent = await Agent.create({
        ...(request.apiKey ? { apiKey: request.apiKey } : {}),
        model: request.model,
        name: "OpenCode (side request)",
        tools: [],
        local: { cwd: this.deps.directory },
      })
      turn.run = await agent.send(toCursor(standaloneMessage(request.prompt)), {
        model: request.model,
        onDelta: ({ update }) => turn.delta(update),
      })
      turn.finish(await turn.run.wait())
    } catch (error) {
      if (isAuthError(error)) this.deps.authFailed()
      turn.fail(error)
    } finally {
      if (agent) {
        const id = agent.agentId
        await agent[Symbol.asyncDispose]().catch(() => {})
        await Agent.delete(id, { cwd: this.deps.directory }).catch(() => {})
      }
    }
  }

  // Stopping OpenCode's stream (Esc) stops the Cursor run too.
  private watch(sessionID: string, entry: Entry, turn: Turn, step: Step) {
    step.onCancel(() => {
      if (!turn.finished && entry.turn === turn) void this.cancel(sessionID, entry, turn)
    })
  }

  // A cancelled Cursor run loses the agent's earlier conversation, so the next turn rebuilds it from OpenCode's history.
  private async cancel(sessionID: string, entry: Entry, turn: Turn) {
    if (entry.turn === turn) entry.turn = undefined
    const recorded = entry.record?.agentId
    // Forget first, synchronously, so a request arriving during the cancel already starts fresh.
    await this.forget(sessionID, entry, turn.cancel())
    if (turn.agentId && turn.agentId !== recorded)
      await Agent.delete(turn.agentId, { cwd: this.deps.directory }).catch(() => {})
  }

  /** Drops the conversation: the next request starts a new Cursor agent with the whole history. */
  private async forget(sessionID: string, entry: Entry, before?: Promise<void>) {
    const previous = entry.record
    const agent = entry.agent
    entry.agent = undefined
    entry.apiKey = undefined
    entry.record = undefined
    const cleared = this.deps.storage.set(key(sessionID), null as never).catch(() => {})
    await before
    agent?.close()
    await cleared
    if (previous) await Agent.delete(previous.agentId, { cwd: this.deps.directory }).catch(() => {})
  }

  private remember(sessionID: string, entry: Entry, record: Record) {
    entry.record = record
    void this.deps.storage.set(key(sessionID), record as never).catch(() => {})
  }

  private async load(sessionID: string): Promise<Record | undefined> {
    const saved = (await this.deps.storage.get(key(sessionID)).catch(() => undefined)) as Partial<Record> | null
    if (!saved || typeof saved.agentId !== "string" || !Array.isArray(saved.history)) return undefined
    return {
      agentId: saved.agentId,
      history: saved.history.filter((item): item is string => typeof item === "string"),
      ...(typeof saved.instructions === "string" ? { instructions: saved.instructions } : {}),
    }
  }

  private entry(sessionID: string) {
    let entry = this.entries.get(sessionID)
    if (!entry) {
      entry = { queue: Promise.resolve(), loaded: false }
      this.entries.set(sessionID, entry)
    }
    return entry
  }

  private lock(entry: Entry, task: () => Promise<void>) {
    const result = entry.queue.then(task)
    entry.queue = result.catch(() => {})
    return result
  }
}

function isRunResult(value: unknown): value is Awaited<ReturnType<NonNullable<Turn["run"]>["wait"]>> {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    (value.status === "finished" || value.status === "error" || value.status === "cancelled")
  )
}

function key(sessionID: string) {
  return `sessions/${sessionID}`
}

function fingerprint(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32)
}

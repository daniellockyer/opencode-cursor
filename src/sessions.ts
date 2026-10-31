import type { LanguageModelV3FunctionTool, LanguageModelV3Prompt } from "@ai-sdk/provider"
import { Agent, type AgentOptions, type ModelSelection, type SDKAgent } from "@cursor/sdk"
import { createHash } from "node:crypto"
import { continuation, history, standaloneMessage, toCursor, unseen, unseenMessage } from "./convert.ts"
import { isAuthError } from "./errors.ts"
import type { Options } from "./options.ts"
import { Step, Turn } from "./turn.ts"

export interface Context {
  /** The selected OpenCode agent's own prompt. */
  readonly agent?: string
  /** OpenCode's instructions (AGENTS.md, skills, references…) without its base prompt. */
  readonly instructions?: string
  /** OpenCode's complete system prompt. */
  readonly system?: string
}

export interface Request {
  /** Only the agent loop has one; titles, summaries and other side calls run as standalone agents. */
  readonly sessionID?: string
  readonly model: ModelSelection
  readonly apiKey?: string
  readonly prompt: LanguageModelV3Prompt
  readonly tools: readonly LanguageModelV3FunctionTool[]
  readonly context: Context
  readonly step: Step
}

interface Record {
  readonly agentId: string
  /** Fingerprints of the OpenCode history the agent has seen. */
  readonly history: readonly string[]
  /** Fingerprint of the OpenCode instructions the agent was given. */
  readonly instructions?: string
}

interface Entry {
  queue: Promise<void>
  agent?: SDKAgent
  /** The settings the live handle was opened with. */
  handle?: string
  record?: Record
  loaded: boolean
  turn?: Turn
  idle?: ReturnType<typeof setTimeout>
}

interface Storage {
  get(key: string): Promise<unknown>
  set(key: string, value: never): Promise<void>
}

const RUNTIME = [
  "You are running inside OpenCode, connected through the Cursor SDK.",
  "Cursor's built-in tools are turned off. OpenCode's tools are available through the `custom-user-tools` MCP server: use them for all file, search, shell and other work.",
  "OpenCode shows tool calls to the user and asks for permission when needed. Mention this setup only if asked.",
].join(" ")

export class Sessions {
  private readonly entries = new Map<string, Entry>()

  constructor(
    private readonly deps: {
      readonly directory: string
      readonly options: Options
      readonly storage: Storage
      readonly authFailed: () => void
    },
  ) {}

  run(request: Request): Promise<void> {
    if (!request.sessionID) return this.standalone(request)
    const sessionID = request.sessionID
    const entry = this.entry(sessionID)
    return this.lock(entry, async () => {
      clearTimeout(entry.idle)
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

  /** OpenCode stopped the session, so a run waiting for tool results will not get them. */
  async interrupt(sessionID: string) {
    const entry = this.entries.get(sessionID)
    const turn = entry?.turn
    if (!entry || !turn || turn.finished || turn.attached) return
    await this.cancel(sessionID, entry, turn)
  }

  async close() {
    for (const [sessionID, entry] of this.entries) {
      clearTimeout(entry.idle)
      if (entry.turn && !entry.turn.finished) await this.cancel(sessionID, entry, entry.turn).catch(() => {})
      clearTimeout(entry.idle)
      entry.agent?.close()
    }
    this.entries.clear()
  }

  private async start(sessionID: string, entry: Entry, request: Request) {
    const { options } = this.deps
    const context = resolveContext(request)
    const preamble = options.systemPrompt === "cursor" ? cursorPreamble(context) : undefined
    const system = options.systemPrompt === "opencode" ? [context.system, RUNTIME].filter(Boolean).join("\n\n") : undefined
    const instructions = fingerprint(preamble ?? system ?? "")

    let start = entry.record ? unseen(request.prompt, entry.record.history) : undefined
    if (start === undefined) await this.forget(sessionID, entry)

    const agentOptions: AgentOptions = {
      ...(request.apiKey ? { apiKey: request.apiKey } : {}),
      model: request.model,
      name: `OpenCode ${sessionID}`,
      // Only MCP tools: OpenCode's tools arrive as custom tools, which Cursor serves through MCP.
      tools: ["mcp"],
      local: {
        cwd: this.deps.directory,
        ...(options.settingSources.length > 0 ? { settingSources: options.settingSources } : {}),
      },
      ...(system ? { systemPrompt: system } : {}),
    }
    // The API key and system prompt are fixed when a handle opens, so a change reopens the same conversation.
    const handle = fingerprint(JSON.stringify([request.apiKey, system]))
    if (entry.agent && entry.handle !== handle) {
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
    entry.handle = handle

    const intro = start === 0 || entry.record?.instructions !== instructions ? preamble : undefined
    const message = unseenMessage(request.prompt, start ?? 0, intro)
    const turn = new Turn()
    turn.prompt = request.prompt
    entry.turn = turn
    this.watch(sessionID, entry, turn, request.step)
    turn.attach(request.step)

    const agentId = agent.agentId
    turn.agentId = agentId
    turn.instructions = instructions
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
    turn.run.wait().then(
      (result) => {
        if (turn.finished) return
        // Record what Cursor saw before OpenCode can see the finish and send its next request.
        this.remember(sessionID, entry, { agentId, history: history(turn.prompt), instructions })
        if (entry.turn === turn) entry.turn = undefined
        turn.finish(result)
        this.armIdle(entry)
      },
      (error) => {
        if (turn.finished) return
        if (isAuthError(error)) this.deps.authFailed()
        this.remember(sessionID, entry, { agentId, history: history(turn.prompt), instructions })
        if (entry.turn === turn) entry.turn = undefined
        turn.fail(error)
        this.armIdle(entry)
      },
    )
    await request.step.done
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
    entry.handle = undefined
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

  // The conversation stays in Cursor's local store; only the live handle is released.
  private armIdle(entry: Entry) {
    clearTimeout(entry.idle)
    entry.idle = setTimeout(() => {
      if (entry.turn && !entry.turn.finished) return
      entry.agent?.close()
      entry.agent = undefined
    }, this.deps.options.idleMinutes * 60_000)
    entry.idle.unref?.()
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

function key(sessionID: string) {
  return `sessions/${sessionID}`
}

function fingerprint(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32)
}

function resolveContext(request: Request): Context {
  if (request.context.system !== undefined || request.context.instructions !== undefined) return request.context
  // Without the session hooks, fall back to the system messages OpenCode put in the prompt.
  const system = request.prompt
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n")
  return { ...request.context, system, instructions: system }
}

function cursorPreamble(context: Context) {
  const blocks = [`<runtime>\n${RUNTIME}\n</runtime>`]
  if (context.agent) blocks.push(`<agent-role>\n${context.agent}\n</agent-role>`)
  if (context.instructions) blocks.push(`<instructions>\n${context.instructions}\n</instructions>`)
  return `<opencode-context>\n${blocks.join("\n\n")}\n</opencode-context>`
}

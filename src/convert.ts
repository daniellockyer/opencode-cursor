import { createHash } from "node:crypto"
import type {
  LanguageModelV3FilePart,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3ToolResultOutput,
} from "@ai-sdk/provider"
import type { SDKCustomToolContent, SDKCustomToolResult, SDKImage, SDKUserMessage } from "@cursor/sdk"

// ---------------------------------------------------------------------------------------------------------------------
// Fingerprints: which part of OpenCode's history the Cursor agent has already seen.

export interface Group {
  readonly hash: string
  readonly role: "user" | "assistant" | "tool"
  readonly start: number
  readonly end: number
}

/** Stands for the reply Cursor wrote at the end of a turn, however OpenCode stored it. */
export const REPLY = "reply"

const MEDIA_HEADER = "Attached media from tool result:"

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>
    const fields: string[] = []
    for (const key of Object.keys(object).sort()) {
      if (object[key] !== undefined) fields.push(`${JSON.stringify(key)}:${canonical(object[key])}`)
    }
    return `{${fields.join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

function hash(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex")
}

function fileData(data: LanguageModelV3FilePart["data"]) {
  if (data instanceof URL) return data.href
  if (typeof data === "string") return data
  return Buffer.from(data).toString("base64")
}

// Reasoning and provider options depend on which model OpenCode is sending to, so they are not part of the identity.
function visible(message: Exclude<LanguageModelV3Message, { role: "system" }>) {
  const parts: unknown[] = []
  let text = ""
  for (const part of message.content) {
    if (part.type === "reasoning") continue
    if (part.type === "text") {
      text += part.text
      continue
    }
    if (text) parts.push({ type: "text", text })
    text = ""
    if (part.type === "file") {
      parts.push({ type: "file", mediaType: part.mediaType, data: fileData(part.data) })
      continue
    }
    if (part.type === "tool-call") {
      parts.push({ type: "tool-call", id: part.toolCallId, name: part.toolName, input: part.input })
      continue
    }
    if (part.type === "tool-result") {
      const { providerOptions: _, ...output } = part.output as LanguageModelV3ToolResultOutput & {
        providerOptions?: unknown
      }
      if (output.type === "content") {
        output.value = output.value.map(({ providerOptions: _, ...item }) => item as typeof item & { type: never })
      }
      parts.push({ type: "tool-result", id: part.toolCallId, name: part.toolName, output })
    }
  }
  if (text) parts.push({ type: "text", text })
  return parts
}

function isToolMedia(message: LanguageModelV3Message | undefined) {
  return (
    message?.role === "user" &&
    message.content.length > 1 &&
    message.content[0]?.type === "text" &&
    message.content[0].text === MEDIA_HEADER &&
    message.content.slice(1).every((part) => part.type === "file")
  )
}

export function groups(prompt: LanguageModelV3Prompt): Group[] {
  const result: Group[] = []
  let i = 0
  while (i < prompt.length) {
    const message = prompt[i]!
    const start = i
    i++
    if (message.role === "system") continue
    const parts = visible(message)
    if (parts.length === 0) continue
    const members = [hash(parts)]
    // OpenCode lowers a tool result's media into the user message that follows it.
    if (message.role === "tool" && isToolMedia(prompt[i])) {
      members.push(hash(visible(prompt[i] as Exclude<LanguageModelV3Message, { role: "system" }>)))
      i++
    }
    result.push({ hash: hash({ role: message.role, members }), role: message.role, start, end: i })
  }
  return result
}

/**
 * Where the unseen part of the prompt starts, when the agent's history is a prefix of it. Undefined means the agent
 * cannot continue (an edit, undo, compaction or another client changed the history) and must be rebuilt.
 */
export function unseen(prompt: LanguageModelV3Prompt, history: readonly string[]) {
  const all = groups(prompt)
  let index = 0
  for (const entry of history) {
    if (entry === REPLY) {
      while (all[index]?.role === "assistant") index++
      continue
    }
    if (all[index]?.hash !== entry) return undefined
    index++
  }
  if (index === 0) return undefined
  const start = all[index]?.start
  // Nothing new to answer: OpenCode is asking again for input the agent already replied to.
  if (start === undefined) return undefined
  return start
}

export function history(prompt: LanguageModelV3Prompt) {
  return [...groups(prompt).map((group) => group.hash), REPLY]
}

// ---------------------------------------------------------------------------------------------------------------------
// OpenCode prompt → Cursor user message.

export interface Message {
  text: string
  images: SDKImage[]
}

function attachment(part: LanguageModelV3FilePart, message: Message) {
  if (part.mediaType.startsWith("image/")) {
    if (part.data instanceof URL) {
      if (part.data.protocol === "data:") {
        const [, meta, data] = part.data.href.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/) ?? []
        if (data) message.images.push({ data, mimeType: meta ?? part.mediaType })
        return ""
      }
      message.images.push({ url: part.data.href })
      return ""
    }
    message.images.push({ data: fileData(part.data), mimeType: part.mediaType })
    return ""
  }
  const name = part.filename ? ` ${part.filename}` : ""
  if (part.mediaType.startsWith("text/") || part.mediaType === "application/json") {
    if (part.data instanceof URL) return `<attachment${name} url="${part.data.href}" />`
    const text = typeof part.data === "string" ? Buffer.from(part.data, "base64").toString("utf8") : Buffer.from(part.data).toString("utf8")
    return `<attachment${name} type="${part.mediaType}">\n${text}\n</attachment>`
  }
  return `<attachment${name} type="${part.mediaType}">(Cursor cannot read this attachment type.)</attachment>`
}

function render(messages: LanguageModelV3Prompt, message: Message, tagged: boolean) {
  const blocks: string[] = []
  for (const item of messages) {
    if (item.role === "system") continue
    if (isToolMedia(item)) continue
    const parts: string[] = []
    for (const part of item.content) {
      if (part.type === "text") parts.push(part.text)
      else if (part.type === "file") {
        const text = attachment(part, message)
        if (text) parts.push(text)
      } else if (part.type === "tool-call")
        parts.push(`<tool-call>\n${JSON.stringify({ id: part.toolCallId, name: part.toolName, input: part.input })}\n</tool-call>`)
      else if (part.type === "tool-result")
        parts.push(
          `<tool-result>\n${JSON.stringify({ id: part.toolCallId, name: part.toolName, output: resultText(part.output) })}\n</tool-result>`,
        )
    }
    if (parts.length === 0) continue
    blocks.push(tagged ? `<${item.role}>\n${parts.join("\n")}\n</${item.role}>` : parts.join("\n"))
  }
  return blocks.join("\n\n")
}

/** The part of the prompt Cursor has not seen. Earlier turns are framed as history; trailing user input stays plain. */
export function unseenMessage(prompt: LanguageModelV3Prompt, start: number, preamble?: string): Message {
  const missed = prompt.slice(start)
  const all = groups(missed)
  const end = all.findLast((group) => group.role !== "user")?.end ?? 0
  const message: Message = { text: "", images: [] }
  const blocks: string[] = []
  if (preamble) blocks.push(preamble)
  if (end > 0) {
    blocks.push(
      "<conversation-checkpoint>\nThe following is conversation history from OpenCode that you have not seen. Treat it as prior conversation, not a new request. Continue with the user messages after this checkpoint.\n\n" +
        render(missed.slice(0, end), message, true) +
        "\n</conversation-checkpoint>",
    )
  }
  const latest = render(missed.slice(end), message, false)
  if (latest) blocks.push(latest)
  message.text = blocks.join("\n\n")
  return message
}

/** A complete prompt as one standalone request, for titles, summaries and other side calls. */
export function standaloneMessage(prompt: LanguageModelV3Prompt): Message {
  const message: Message = { text: "", images: [] }
  const system = prompt
    .filter((item) => item.role === "system")
    .map((item) => item.content)
    .join("\n\n")
  const conversation = prompt.filter((item) => item.role !== "system")
  const tagged = conversation.length > 1 || conversation.some((item) => item.role !== "user")
  const blocks: string[] = [
    "This is a standalone text request from OpenCode, not a coding task. Do not inspect the workspace, use tools or narrate your work. Reply with only the requested output.",
  ]
  if (system) blocks.push(`<instructions>\n${system}\n</instructions>`)
  blocks.push(render(conversation, message, tagged))
  message.text = blocks.join("\n\n")
  return message
}

export function toCursor(message: Message): string | SDKUserMessage {
  return message.images.length > 0 ? { text: message.text, images: message.images } : message.text
}

// ---------------------------------------------------------------------------------------------------------------------
// OpenCode tool results → Cursor custom tool results.

function resultText(output: LanguageModelV3ToolResultOutput): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value
    case "json":
    case "error-json":
      return JSON.stringify(output.value)
    case "execution-denied":
      return output.reason ?? "The user denied this tool call."
    case "content":
      return output.value
        .map((part) => {
          if (part.type === "text") return part.text
          if ("url" in part) return `[${part.type}: ${part.url}]`
          return `[${part.type}]`
        })
        .join("\n")
  }
}

function toolResult(output: LanguageModelV3ToolResultOutput, media: LanguageModelV3FilePart[]): SDKCustomToolResult {
  const content: SDKCustomToolContent[] = []
  const isError = output.type === "error-text" || output.type === "error-json" || output.type === "execution-denied"
  if (output.type === "content") {
    for (const part of output.value) {
      if (part.type === "text") content.push({ type: "text", text: part.text })
      else if ((part.type === "image-data" || part.type === "file-data") && part.mediaType.startsWith("image/"))
        content.push({ type: "image", data: part.data, mimeType: part.mediaType })
      else content.push({ type: "text", text: resultText({ type: "content", value: [part] }) })
    }
  } else {
    content.push({ type: "text", text: resultText(output) })
  }
  for (const file of media) {
    if (!file.mediaType.startsWith("image/") || file.data instanceof URL) continue
    content.push({ type: "image", data: fileData(file.data), mimeType: file.mediaType })
  }
  if (content.length === 0) content.push({ type: "text", text: "(no output)" })
  return { content, isError }
}

export interface Continuation {
  readonly results: Map<string, SDKCustomToolResult>
  /** User input OpenCode delivered while the tools ran. */
  readonly steer?: string
}

/** Results for every waiting tool call, or undefined when any is missing. */
export function continuation(prompt: LanguageModelV3Prompt, waiting: readonly string[]): Continuation | undefined {
  const wanted = new Set(waiting)
  const results = new Map<string, SDKCustomToolResult>()
  let last = -1
  for (let i = 0; i < prompt.length; i++) {
    const message = prompt[i]!
    if (message.role !== "tool") continue
    const next = prompt[i + 1]
    const media = isToolMedia(next) && next?.role === "user" ? next.content.filter((part) => part.type === "file") : []
    const parts = message.content.filter((part) => part.type === "tool-result" && wanted.has(part.toolCallId))
    parts.forEach((part, index) => {
      if (part.type !== "tool-result") return
      results.set(part.toolCallId, toolResult(part.output, index === parts.length - 1 ? media : []))
      last = Math.max(last, media.length > 0 ? i + 1 : i)
    })
  }
  if (waiting.some((id) => !results.has(id))) return undefined
  const after = prompt.slice(last + 1).filter((message) => message.role === "user")
  const steer = render(after, { text: "", images: [] }, false)
  return { results, ...(steer ? { steer } : {}) }
}

export function appendSteer(result: SDKCustomToolResult, steer: string): SDKCustomToolResult {
  const note: SDKCustomToolContent = {
    type: "text",
    text: `<user-message>\nThe user sent this message while the tool ran. Take it into account before continuing:\n${steer}\n</user-message>`,
  }
  if (typeof result === "object" && result !== null && "content" in result && Array.isArray(result.content)) {
    return { ...result, content: [...result.content, note] }
  }
  return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }, note] }
}

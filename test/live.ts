// Drives the provider the way OpenCode does, against the real Cursor API.
// Run with: bun test/live.ts (needs CURSOR_API_KEY or a stored `Cursor.auth.login()`).
import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KIND_HEADER, SESSION_HEADER } from "../src/constants.ts"
import { CursorLanguageModel } from "../src/model.ts"
import { parse } from "../src/options.ts"
import { Sessions } from "../src/sessions.ts"

const dir = mkdtempSync(join(tmpdir(), "cursor-live-"))
writeFileSync(join(dir, "notes.txt"), "The secret word is PELICAN.\n")
writeFileSync(join(dir, "todo.txt"), "buy milk\n")

const memory = new Map<string, unknown>()
const storage = {
  get: async (key: string) => memory.get(key),
  set: async (key: string, value: never) => void memory.set(key, value),
}
const sessions = () => new Sessions({ directory: dir, options: parse({}), storage, authFailed: () => console.log("AUTH FAILED") })

const tools: LanguageModelV3FunctionTool[] = [
  {
    type: "function",
    name: "list",
    description: "List the files in the working directory.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "read",
    description: "Read a file from the working directory.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
]

function execute(name: string, input: any) {
  if (name === "list") return readdirSync(dir).join("\n")
  if (name === "read") return readFileSync(join(dir, input.path), "utf8")
  throw new Error(`unknown tool ${name}`)
}

async function step(model: CursorLanguageModel, prompt: LanguageModelV3Prompt, sessionID: string, abortAfterText = false) {
  const abort = new AbortController()
  const { stream } = await model.doStream({
    prompt,
    tools,
    headers: { [KIND_HEADER]: "primary", [SESSION_HEADER]: sessionID },
    abortSignal: abort.signal,
  })
  const parts: LanguageModelV3StreamPart[] = []
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
      if (value.type === "text-delta") {
        process.stdout.write(value.delta)
        if (abortAfterText) abort.abort()
      }
      if (value.type === "tool-call") console.log(`\n[tool-call ${value.toolName} ${value.input}]`)
      if (value.type === "finish") console.log(`\n[finish ${value.finishReason.unified} ${JSON.stringify(value.usage)}]`)
      if (value.type === "error") throw value.error
    }
  } catch (error) {
    if (!abortAfterText) throw error
    console.log("\n[aborted]")
  }
  return parts
}

async function turn(model: CursorLanguageModel, prompt: LanguageModelV3Prompt, sessionID: string) {
  for (let i = 0; i < 10; i++) {
    const parts = await step(model, prompt, sessionID)
    const text = parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("")
    const calls = parts.filter((part) => part.type === "tool-call")
    const content: Extract<LanguageModelV3Message, { role: "assistant" }>["content"] = []
    if (text) content.push({ type: "text", text })
    for (const call of calls) content.push({ type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, input: JSON.parse(call.input) })
    if (content.length) prompt.push({ role: "assistant", content })
    if (calls.length === 0) return text
    prompt.push({
      role: "tool",
      content: calls.map((call) => ({
        type: "tool-result" as const,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "text" as const, value: execute(call.toolName, JSON.parse(call.input)) },
      })),
    })
  }
  throw new Error("too many steps")
}

const user = (text: string): LanguageModelV3Message => ({ role: "user", content: [{ type: "text", text }] })
const system: LanguageModelV3Message = { role: "system", content: "You are a helpful assistant. Keep answers short." }

const live = sessions()
const model = new CursorLanguageModel("composer-2.5", live, { params: [{ id: "fast", value: "true" }] })
const prompt: LanguageModelV3Prompt = [system, user("List the files, then read every file in parallel and tell me the secret word.")]
console.log("== turn 1 (tools)")
const first = await turn(model, prompt, "ses_live")
if (!first.includes("PELICAN")) throw new Error("turn 1 did not find the secret word")

console.log("\n== turn 2 (continues the same Cursor agent)")
prompt.push(user("What was in todo.txt? Answer from memory, without tools."))
const second = await turn(model, prompt, "ses_live")
if (!second.toLowerCase().includes("milk")) throw new Error("turn 2 lost the conversation")

console.log("\n== turn 3 (after a restart: resumes the stored agent)")
await live.close()
const restarted = sessions()
const model2 = new CursorLanguageModel("composer-2.5", restarted, { params: [{ id: "fast", value: "true" }] })
prompt.push(user("Repeat the secret word in lowercase, nothing else."))
const third = await turn(model2, prompt, "ses_live")
if (!third.toLowerCase().includes("pelican")) throw new Error("turn 3 lost the conversation")

console.log("\n== turn 4 (edited history: rebuilds a fresh agent)")
const edited: LanguageModelV3Prompt = [system, user("My favourite colour is teal. What is my favourite colour? One word.")]
const fourth = await turn(model2, edited, "ses_live")
if (!fourth.toLowerCase().includes("teal")) throw new Error("turn 4 failed")

console.log("\n== turn 5 (abort mid-stream, then continue)")
edited.push(user("Write a 300 word story about a pelican."))
await step(model2, edited, "ses_live", true)
edited.push(user("Ignore that. What is my favourite colour? One word."))
const fifth = await turn(model2, edited, "ses_live")
if (!fifth.toLowerCase().includes("teal")) throw new Error("turn 5 failed")

console.log("\n== standalone (title)")
const { stream } = await model2.doStream({
  prompt: [{ role: "system", content: "Generate a 3-5 word title for the conversation. Output only the title." }, user("help me fix the login bug")],
  headers: { [KIND_HEADER]: "title", [SESSION_HEADER]: "ses_live" },
})
for await (const part of stream as unknown as AsyncIterable<LanguageModelV3StreamPart>) {
  if (part.type === "text-delta") process.stdout.write(part.delta)
  if (part.type === "error") throw part.error
}
await restarted.close()
console.log("\n\nALL LIVE CHECKS PASSED")

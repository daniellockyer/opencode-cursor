import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import { describe, expect, test } from "bun:test"
import { continuation, history, standaloneMessage, unseen, unseenMessage } from "../src/convert.ts"
import { toModel } from "../src/catalog.ts"

const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }] })
const assistant = (text: string) => ({ role: "assistant" as const, content: [{ type: "text" as const, text }] })
const call = (id: string, input: unknown) => ({
  role: "assistant" as const,
  content: [{ type: "tool-call" as const, toolCallId: id, toolName: "read", input }],
})
const result = (id: string, value: string) => ({
  role: "tool" as const,
  content: [{ type: "tool-result" as const, toolCallId: id, toolName: "read", output: { type: "text" as const, value } }],
})

describe("history sync", () => {
  const first: LanguageModelV3Prompt = [{ role: "system", content: "sys" }, user("hello")]

  test("a new turn after a reply only sends the new input", () => {
    const seen = history(first)
    const next: LanguageModelV3Prompt = [...first, assistant("hi there"), user("next question")]
    expect(unseen(next, seen)).toBe(3)
    expect(unseenMessage(next, 3).text).toBe("next question")
  })

  test("the reply may span tool steps", () => {
    const step: LanguageModelV3Prompt = [...first, call("c1", { path: "a" }), result("c1", "A")]
    const seen = history(step)
    const next: LanguageModelV3Prompt = [...step, assistant("done"), user("thanks")]
    expect(unseen(next, seen)).toBe(next.length - 1)
  })

  test("a reply with no text still matches", () => {
    const seen = history(first)
    expect(unseen([...first, user("again")], seen)).toBe(2)
  })

  test("an edited history forces a rebuild", () => {
    const seen = history([...first, assistant("x"), user("one")])
    expect(unseen([...first, assistant("x"), user("two"), assistant("y"), user("three")], seen)).toBeUndefined()
  })

  test("the same input asked again forces a rebuild", () => {
    expect(unseen(first, history(first))).toBeUndefined()
  })

  test("missed history is wrapped as a checkpoint", () => {
    const seen = history(first)
    const next: LanguageModelV3Prompt = [...first, assistant("a"), user("q"), call("c", {}), result("c", "R"), user("now")]
    const start = unseen(next, seen)!
    const message = unseenMessage(next, start, "PRE")
    expect(message.text.startsWith("PRE\n\n<conversation-checkpoint>")).toBe(true)
    expect(message.text).toContain("<tool-result>")
    expect(message.text.endsWith("</conversation-checkpoint>\n\nnow")).toBe(true)
  })

  test("standalone requests carry the system prompt", () => {
    const message = standaloneMessage([{ role: "system", content: "Make a title" }, user("fix the bug")])
    expect(message.text.endsWith("<instructions>\nMake a title\n</instructions>\n\nfix the bug")).toBe(true)
  })
})

describe("tool continuation", () => {
  test("collects results, media and steering input", () => {
    const prompt: LanguageModelV3Prompt = [
      user("go"),
      call("c1", {}),
      result("c1", "one"),
      {
        role: "user",
        content: [
          { type: "text", text: "Attached media from tool result:" },
          { type: "file", mediaType: "image/png", data: "AAAA" },
        ],
      },
      user("also do X"),
    ]
    const next = continuation(prompt, ["c1"])!
    expect(next.steer).toBe("also do X")
    expect(next.results.get("c1")).toEqual({
      content: [
        { type: "text", text: "one" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
      isError: false,
    })
  })

  test("missing results mean no continuation", () => {
    expect(continuation([user("go"), call("c1", {})], ["c1"])).toBeUndefined()
  })

  test("denied tools are errors", () => {
    const prompt: LanguageModelV3Prompt = [
      user("go"),
      call("c1", {}),
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "c1", toolName: "read", output: { type: "execution-denied", reason: "no" } },
        ],
      },
    ]
    expect(continuation(prompt, ["c1"])!.results.get("c1")).toEqual({ content: [{ type: "text", text: "no" }], isError: true })
  })
})

describe("catalog", () => {
  test("maps efforts and fast mode to valid presets", () => {
    const model = toModel({
      id: "gpt-x",
      displayName: "GPT X",
      parameters: [
        { id: "context", values: [{ value: "272k" }, { value: "1m" }] },
        { id: "reasoning", values: [{ value: "low" }, { value: "high" }] },
        { id: "fast", values: [{ value: "false" }, { value: "true" }] },
      ],
      variants: [
        { displayName: "a", params: [{ id: "context", value: "1m" }, { id: "reasoning", value: "low" }, { id: "fast", value: "false" }], isDefault: true },
        { displayName: "b", params: [{ id: "context", value: "272k" }, { id: "reasoning", value: "high" }, { id: "fast", value: "true" }] },
        { displayName: "c", params: [{ id: "context", value: "1m" }, { id: "reasoning", value: "high" }, { id: "fast", value: "false" }] },
      ],
    })
    expect(model.limit.context).toBe(1_000_000)
    expect(model.settings).toEqual({ params: [{ id: "context", value: "1m" }, { id: "reasoning", value: "low" }, { id: "fast", value: "false" }] })
    expect(model.variants.map((variant) => String(variant.id))).toEqual(["low", "high", "high-fast"])
    expect(model.variants[2]!.settings).toEqual({
      params: [{ id: "context", value: "272k" }, { id: "reasoning", value: "high" }, { id: "fast", value: "true" }],
    })
  })

  test("fast-only models get fast and standard variants", () => {
    const model = toModel({
      id: "composer",
      displayName: "Composer",
      parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }],
      variants: [
        { displayName: "slow", params: [{ id: "fast", value: "false" }] },
        { displayName: "fast", params: [{ id: "fast", value: "true" }], isDefault: true },
      ],
    })
    expect(model.variants.map((variant) => String(variant.id))).toEqual(["standard", "fast"])
  })
})

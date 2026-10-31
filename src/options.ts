import type { SettingSource } from "@cursor/sdk"

export interface Options {
  /**
   * "cursor" keeps Cursor's own harness prompt and sends OpenCode's agent role and instructions with the conversation.
   * "opencode" replaces Cursor's prompt with OpenCode's full system prompt; Cursor enables this per account.
   */
  readonly systemPrompt: "cursor" | "opencode"
  /** Cursor settings layers (rules, `.cursor/` config) the local agent may load. None by default. */
  readonly settingSources: SettingSource[]
  /** Minutes before an idle Cursor agent handle is released. Its conversation stays on disk. */
  readonly idleMinutes: number
}

const SOURCES = new Set<SettingSource>(["project", "user", "team", "mdm", "plugins", "all"])

export function parse(input: Record<string, unknown> | undefined): Options {
  const sources = Array.isArray(input?.settingSources)
    ? input.settingSources.filter((value): value is SettingSource => SOURCES.has(value as SettingSource))
    : []
  const idle = typeof input?.idleMinutes === "number" && input.idleMinutes > 0 ? input.idleMinutes : 10
  return {
    systemPrompt: input?.systemPrompt === "opencode" ? "opencode" : "cursor",
    settingSources: sources,
    idleMinutes: idle,
  }
}

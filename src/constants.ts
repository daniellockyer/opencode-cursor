export const PLUGIN_ID = "cursor"
export const PROVIDER_ID = "cursor"
// OpenCode never imports this package: the plugin's `sdk` hook supplies the AI SDK provider for it.
export const PACKAGE = "@opencode-cursor/sdk"

export const OAUTH_METHOD_ID = "browser"
export const ENV_KEY = "CURSOR_API_KEY"

export const KIND_HEADER = "x-opencode-cursor-kind"
export const SESSION_HEADER = "x-opencode-session-id"

/** OpenCode's role and instructions for this turn. The session hook sets it; Cursor's own prompt stays in place. */
export const PREAMBLE_OPTION = "cursorPreamble"

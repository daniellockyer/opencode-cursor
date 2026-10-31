export const PLUGIN_ID = "cursor"
export const PROVIDER_ID = "cursor"
// OpenCode never imports this package: the plugin's `sdk` hook supplies the AI SDK provider for it.
export const PACKAGE = "@opencode-cursor/sdk"

export const OAUTH_METHOD_ID = "browser"
export const ENV_KEY = "CURSOR_API_KEY"

export const KIND_HEADER = "x-opencode-cursor-kind"
export const SESSION_HEADER = "x-opencode-session-id"

// Request options set by the session hooks; OpenCode forwards them as provider options under PROVIDER_ID.
export const AGENT_OPTION = "cursorAgentPrompt"
export const INSTRUCTIONS_OPTION = "cursorInstructions"
export const SYSTEM_OPTION = "cursorSystem"

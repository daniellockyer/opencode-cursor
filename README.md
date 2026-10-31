# opencode-cursor

Use your Cursor subscription in [OpenCode](https://opencode.ai) through the official
[Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript) (`@cursor/sdk`).

It adds a **Cursor** provider. Its models are your account's Cursor catalog (Composer, Claude, GPT, Gemini, Grok…),
billed to your Cursor plan like IDE usage. You can find the usage under the SDK tag at
[cursor.com/dashboard/usage](https://cursor.com/dashboard/usage).

Requires OpenCode 2.x.

## Install

Install it straight from GitHub:

```sh
opencode plugin add github:daniellockyer/opencode-cursor
```

This installs the plugin and its dependencies and adds it to your global OpenCode config. To pin a version, add a tag,
branch or commit: `github:daniellockyer/opencode-cursor#<ref>`. `opencode plugin update` picks up new commits on an
unpinned install.

To enable it for one project only, add the same entry to that project's `.opencode/opencode.jsonc` instead:

```jsonc
{
  "plugins": ["github:daniellockyer/opencode-cursor"]
}
```

### From a local checkout

For development, clone the repository and point OpenCode at the folder:

```sh
git clone https://github.com/daniellockyer/opencode-cursor ~/code/opencode-cursor
cd ~/code/opencode-cursor && bun install
```

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-cursor"]
}
```

OpenCode reloads the plugin when its files change.

## Log in

Run `/connect` in OpenCode (or `opencode auth login cursor`) and pick one:

- **Login with Cursor (browser)**: signs you in on cursor.com and mints a 90-day API key for OpenCode. The key is
  stored in OpenCode's credential store, not in `~/.cursor`. When it expires, log in again.
- **Cursor API key**: paste a user or service-account key from
  [cursor.com/dashboard → API Keys](https://cursor.com/dashboard/api).
- **`CURSOR_API_KEY`**: if the variable is set, it is used automatically.

Then pick a model, for example `cursor/composer-2.5`. Variants map to Cursor's presets: reasoning effort (`low`,
`high`, …) and Fast mode (`high-fast`, `fast`, `standard`). Without a variant, Cursor's default preset for the model is
used.

## How it works

Every OpenCode session gets a local Cursor agent (`Agent.create({ local })`), so inference runs on Cursor's backend
while the agent loop runs on your machine.

- **OpenCode stays in charge of tools.** Cursor's built-in tools are off. OpenCode's tools (read, edit, bash, MCP,
  subagents…) are given to Cursor as SDK custom tools. When Cursor calls one, the plugin holds the call, hands it to
  OpenCode to run (with its usual permission prompts and UI), and returns the result to Cursor. Parallel calls are
  batched into one OpenCode step.
- **History stays in sync.** The plugin fingerprints OpenCode's history. Normally only the new message is sent, because
  the Cursor agent already has the rest. After an edit, undo, compaction or a model switch, it starts a new Cursor agent
  and sends the missing history once as a checkpoint. Agent IDs are saved in plugin storage, so a restart resumes the
  same Cursor conversation.
- **Stopping works.** Esc cancels the Cursor run. A cancelled Cursor run loses its earlier context, so the next message
  rebuilds the agent from OpenCode's history.
- **Instructions.** Cursor keeps its own harness prompt. The plugin adds OpenCode's agent role and instructions
  (AGENTS.md, skills, references) to the conversation and resends them when they change.
- Titles, summaries and compaction run as one-off agents with no tools.
- When a session finishes, the live agent handle is released. The conversation stays on disk and the next message
  resumes it.

## Limitations

- Cursor reports one token total per run, so the context size OpenCode shows is an estimate, and cost shows as $0.
- Temperature, top-p, stop sequences and max output tokens are not supported.
- OpenCode retries are off for this provider, because the SDK already retries and replaying a turn could run tools twice.
- Cursor agents run locally, so this needs a machine where OpenCode can run the SDK (Node ≥ 22.13 or Bun).

## Development

```sh
bun run typecheck
bun test            # unit tests
bun test/live.ts    # drives the provider against the real Cursor API (needs CURSOR_API_KEY or a Cursor SDK login)
```

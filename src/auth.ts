import { Cursor } from "@cursor/sdk"
import type { Credential, Plugin } from "@opencode/plugin"
import { ENV_KEY, OAUTH_METHOD_ID, PROVIDER_ID } from "./constants.ts"

const LOGIN_TIMEOUT_MS = 10 * 60_000

export async function register(ctx: Plugin.Context) {
  await ctx.integration.transform((editor) => {
    editor.update(PROVIDER_ID, (integration) => {
      integration.name = "Cursor"
    })
    editor.method.update({
      integrationID: PROVIDER_ID,
      method: { id: OAUTH_METHOD_ID, type: "oauth", label: "Login with Cursor (browser)" },
      authorize: () => authorize(),
      // A browser login mints a plain API key that expires; there is nothing to refresh it with.
      refresh: async (credential) => {
        if (credential.expires > Date.now()) return credential
        throw new Error("Your Cursor login expired. Run /connect and log in with Cursor again.")
      },
      label: (credential) => {
        const email = credential.metadata?.email
        return typeof email === "string" ? `Cursor (${email})` : undefined
      },
    })
    editor.method.update({
      integrationID: PROVIDER_ID,
      method: { type: "key", label: "Cursor API key (cursor.com/dashboard → API Keys)" },
    })
    editor.method.update({ integrationID: PROVIDER_ID, method: { type: "env", names: [ENV_KEY] } })
  })
}

async function authorize() {
  const link = Promise.withResolvers<string>()
  const login = Cursor.auth.login({
    // OpenCode stores the credential; nothing is written to ~/.cursor.
    store: null,
    openBrowser: false,
    onLoginUrl: (url) => link.resolve(url),
    apiKeyName: "OpenCode",
    signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
  })
  login.catch((error) => link.reject(error))
  const url = await link.promise
  return {
    mode: "auto" as const,
    url,
    instructions: "Sign in to Cursor in your browser. OpenCode will receive a Cursor API key for your account.",
    expiresAt: Date.now() + LOGIN_TIMEOUT_MS,
    callback: login.then(
      (result) =>
        ({
          type: "oauth",
          methodID: OAUTH_METHOD_ID,
          access: result.apiKey,
          refresh: "",
          expires: result.apiKeyExpiresAtMs,
          ...(result.email ? { metadata: { email: result.email } } : {}),
        }) as Credential.OAuth,
    ),
  }
}

/** The API key of the active Cursor connection, if any. */
export async function apiKey(ctx: Plugin.Context) {
  const connection = await ctx.integration.connection.active(PROVIDER_ID)
  if (!connection) return undefined
  const credential = await ctx.integration.connection.resolve(connection)
  if (credential?.type === "key") return credential.key
  if (credential?.type === "oauth") return credential.access
  return undefined
}

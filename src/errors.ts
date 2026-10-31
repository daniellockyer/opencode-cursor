import { AuthenticationError, ConfigurationError, CursorSdkError, RateLimitError } from "@cursor/sdk"

export function isAuthError(error: unknown) {
  return error instanceof AuthenticationError
}

/** Cursor SDK errors with messages that tell an OpenCode user what to do. */
export function friendly(error: unknown): Error {
  if (error instanceof AuthenticationError)
    return new Error(`Cursor rejected the credentials (${error.message}). Run /connect to log in to Cursor again.`, {
      cause: error,
    })
  if (error instanceof RateLimitError)
    return new Error(`Cursor usage limit reached: ${error.message}. Check https://cursor.com/dashboard/usage.`, {
      cause: error,
    })
  if (error instanceof ConfigurationError) return new Error(`Cursor: ${error.message}`, { cause: error })
  if (error instanceof CursorSdkError) {
    const id = error.requestId ? ` (request ${error.requestId})` : ""
    return new Error(`Cursor: ${error.message}${id}`, { cause: error })
  }
  if (error instanceof Error) return error
  return new Error(String(error))
}

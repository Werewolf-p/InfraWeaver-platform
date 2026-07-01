// Positive allowlist for game-server console commands. Permits letters, digits,
// whitespace, and the punctuation real commands use (Minecraft selectors `@`,
// JSON `{}"[],:` and escaped quotes `\"` for tellraw, relative coords `~^`,
// paths `/`, negatives `-`). Backslash is allowed for JSON escapes but the
// command-separator and substitution metacharacters $ ` | & ; ( ) < > and
// newlines stay rejected — so a command can never introduce a second command or
// a subshell even if a downstream caller passed it to a shell unquoted (the
// stdin path already shell-quotes it, and RCON sends it as a raw payload).
const ALLOWED_CONSOLE_COMMAND_RE = /^[A-Za-z0-9 \t.,:'"_\-/@#!?=+*~^%\\[\]{}]+$/
const DEFAULT_API_BODY_LIMIT = 512 * 1024
const API_BODY_LIMIT_OVERRIDES = [
  { prefix: "/api/platform-editor", bytes: 2 * 1024 * 1024 },
  { prefix: "/api/config/platform", bytes: 2 * 1024 * 1024 },
  { prefix: "/api/cluster/settings", bytes: 2 * 1024 * 1024 },
  { prefix: "/api/cluster/nodes/settings", bytes: 2 * 1024 * 1024 },
  { prefix: "/api/users-config", bytes: 2 * 1024 * 1024 },
  { prefix: "/api/game-hub/servers/", bytes: 10 * 1024 * 1024 },
]

function matchesRequestHost(value: string, host: string) {
  try {
    return new URL(value).host === host
  } catch {
    return false
  }
}

// CSRF same-origin check. Only invoked for state-changing (mutation) methods —
// see proxy.ts — so it fails CLOSED: a request whose origin cannot be verified
// against the server host is rejected.
export function checkSameOrigin(req: Pick<Request, "headers">) {
  // Derive the host from the `host` header ONLY. `x-forwarded-host` is
  // client-settable and must never be trusted as the CSRF origin baseline.
  const host = req.headers.get("host")
  if (!host) return false

  const origin = req.headers.get("origin")
  if (origin) return matchesRequestHost(origin, host)

  const referer = req.headers.get("referer")
  if (referer) return matchesRequestHost(referer, host)

  // No Origin and no Referer on a mutating request: reject.
  return false
}

export function getRequestBodyLimit(pathname: string) {
  const override = API_BODY_LIMIT_OVERRIDES.find((entry) => pathname.startsWith(entry.prefix))
  return override?.bytes ?? DEFAULT_API_BODY_LIMIT
}

export function getRequestSizeViolation(req: Pick<Request, "headers">, pathname: string) {
  const rawLength = req.headers.get("content-length")
  if (!rawLength) return null

  const contentLength = Number(rawLength)
  if (!Number.isFinite(contentLength) || contentLength < 0) return null

  const limit = getRequestBodyLimit(pathname)
  if (contentLength <= limit) return null

  return `Request body too large (${contentLength} bytes > ${limit} bytes)`
}

export function sanitizeConsoleCommand(input: string) {
  const value = input.replace(/\0/g, "").trim()
  if (!value) {
    return { ok: false as const, error: "command is required" }
  }
  if (!ALLOWED_CONSOLE_COMMAND_RE.test(value)) {
    return { ok: false as const, error: "Command contains disallowed characters" }
  }
  return { ok: true as const, value }
}

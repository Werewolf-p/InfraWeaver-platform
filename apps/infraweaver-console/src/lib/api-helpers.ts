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

/**
 * Constant-time comparison of the internal cron token used by in-cluster
 * automation (e.g. the hourly WordPress health-sweep CronJob) to authenticate
 * without a session. Length is not secret, so a fast length check first; then
 * XOR-accumulate over the full length so a match and a same-length mismatch
 * take the same time. Pure JS (no node:crypto) so it is safe in the middleware
 * bundle. Fail-closed: a missing token or unset expected value returns false.
 */
export function internalCronTokenMatches(provided: string | null, expected: string | undefined): boolean {
  if (!expected || !provided) return false
  if (provided.length !== expected.length) return false
  let mismatch = 0
  for (let i = 0; i < expected.length; i++) {
    mismatch |= provided.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return mismatch === 0
}

// Header names for the fork↔canonical feedback HMAC. Mirror the constants in
// src/app/api/feedback/route.ts (UPSTREAM_TIMESTAMP_HEADER / _SIGNATURE_HEADER)
// and the canonical scheme in lib/hmac.ts.
const UPSTREAM_TIMESTAMP_HEADER = "x-iw-timestamp"
const UPSTREAM_SIGNATURE_HEADER = "x-iw-signature"

/**
 * True when a request carries BOTH feedback HMAC headers. The middleware uses
 * this to let a *signed* cross-deployment ("upstream") feedback POST past the
 * session gate AND the CSRF same-origin check — a genuine fork forward is
 * anonymous and, being a server-side fetch, carries no same-origin Origin. This
 * grants NO trust: it only defers auth to the HMAC verification in the
 * /api/feedback route handler, which fails closed on a forged/expired signature
 * (defence in depth, exactly like the health-sweep token bypass). Presence-only,
 * fail-closed: either header missing or empty → false. Pure (no node:crypto) so
 * it is safe in the middleware bundle.
 */
export function hasUpstreamFeedbackSignature(req: Pick<Request, "headers">): boolean {
  return !!req.headers.get(UPSTREAM_TIMESTAMP_HEADER) && !!req.headers.get(UPSTREAM_SIGNATURE_HEADER)
}

export function getRequestBodyLimit(pathname: string) {
  const override = API_BODY_LIMIT_OVERRIDES.find((entry) => pathname.startsWith(entry.prefix))
  return override?.bytes ?? DEFAULT_API_BODY_LIMIT
}

// Only invoked for mutating requests (see proxy.ts) — so it fails CLOSED:
// a body whose size cannot be established from Content-Length is rejected.
// A missing Content-Length is only benign when the request carries no body
// at all (e.g. a bare DELETE), which also means no Transfer-Encoding: with
// HTTP/1.1 framing a body cannot arrive without one of the two headers, and
// `Transfer-Encoding: chunked` was exactly the bypass that skipped this guard
// (unbounded chunked POST → memory-exhaustion DoS, including on the
// unauthenticated signed-feedback path).
export function getRequestSizeViolation(req: Pick<Request, "headers">, pathname: string) {
  const rawLength = req.headers.get("content-length")
  if (!rawLength) {
    if (req.headers.get("transfer-encoding")) {
      return "Request body too large (missing Content-Length with Transfer-Encoding present — body size cannot be verified)"
    }
    // No Content-Length and no Transfer-Encoding: no body is framed.
    return null
  }

  const contentLength = Number(rawLength)
  if (!Number.isFinite(contentLength) || contentLength < 0) {
    // Unparseable Content-Length on a size-guarded request: fail closed.
    return `Request body too large (unparseable Content-Length ${JSON.stringify(rawLength)})`
  }

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

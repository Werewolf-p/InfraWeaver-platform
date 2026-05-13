const SHELL_METACHARACTER_RE = /(^|\s)(?:&&|\|\||;|\|)(?=\s|$)/

function matchesRequestHost(value: string, host: string) {
  try {
    return new URL(value).host === host
  } catch {
    return false
  }
}

export function checkSameOrigin(req: Pick<Request, "headers">) {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host")
  if (!host) return true

  const origin = req.headers.get("origin")
  if (origin) return matchesRequestHost(origin, host)

  const referer = req.headers.get("referer")
  if (referer) return matchesRequestHost(referer, host)

  return true
}

export function sanitizeConsoleCommand(input: string) {
  const value = input.replace(/\0/g, "").trim()
  if (!value) {
    return { ok: false as const, error: "command is required" }
  }
  if (SHELL_METACHARACTER_RE.test(value)) {
    return { ok: false as const, error: "Command contains blocked shell metacharacters" }
  }
  return { ok: true as const, value }
}

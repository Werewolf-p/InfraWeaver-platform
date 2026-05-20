export function serializeEnvValue(value: string) {
  if (!value) return '""'
  return /[\n\r\t #"'=]/.test(value) ? JSON.stringify(value) : value
}

export function envPayloadToString(payload: Record<string, string>) {
  return Object.entries(payload)
    .map(([key, value]) => `${key}=${serializeEnvValue(value)}`)
    .join('\n')
}

function hasClosingQuote(value: string, quote: '"' | "'") {
  if (!value.startsWith(quote)) return false
  for (let index = value.length - 1; index > 0; index -= 1) {
    if (value[index] !== quote) continue
    let backslashes = 0
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
      backslashes += 1
    }
    if (backslashes % 2 === 0) return true
  }
  return false
}

function parseEnvValue(raw: string) {
  const value = raw.trim()
  if (!value) return ''
  if (value.startsWith('"') && hasClosingQuote(value, '"')) {
    try {
      return JSON.parse(value)
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.startsWith("'") && hasClosingQuote(value, "'")) {
    return value.slice(1, -1)
  }
  return value
}

export function parseEnvText(text: string) {
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const payload: Record<string, string> = {}
  let pendingKey: string | null = null
  let pendingValue = ''
  let pendingQuote: '"' | "'" | null = null

  for (const rawLine of lines) {
    if (pendingKey && pendingQuote) {
      pendingValue += `\n${rawLine}`
      if (hasClosingQuote(pendingValue.trim(), pendingQuote)) {
        payload[pendingKey] = parseEnvValue(pendingValue)
        pendingKey = null
        pendingValue = ''
        pendingQuote = null
      }
      continue
    }

    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = rawLine.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue
    const [, key, rawValue] = match
    const trimmedValue = rawValue.trim()
    const quote = trimmedValue.startsWith('"') ? '"' : trimmedValue.startsWith("'") ? "'" : null
    if (quote && !hasClosingQuote(trimmedValue, quote)) {
      pendingKey = key
      pendingValue = rawValue
      pendingQuote = quote
      continue
    }
    payload[key] = parseEnvValue(rawValue)
  }

  if (pendingKey) payload[pendingKey] = parseEnvValue(pendingValue)
  return payload
}

export function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export function downloadEnvFile(payload: Record<string, string>, filename = '.env') {
  downloadTextFile(filename, envPayloadToString(payload))
}

export async function readFileText(file: File) {
  return file.text()
}

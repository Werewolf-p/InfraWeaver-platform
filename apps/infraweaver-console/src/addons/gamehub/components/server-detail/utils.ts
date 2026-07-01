export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${response.status}`);
  return body as T;
}
// Minecraft renders colors/styles with section-sign codes (§ = U+00A7 followed by
// 0-9/a-f color or k-o/r style char, incl. the §x§r§r§g§g§b§b hex sequence). Those
// bytes are meaningless in a text console, so strip every §<char> pair for display.
const MINECRAFT_FORMAT_CODE = /§[0-9A-Za-z]/g;
export function stripMinecraftColors(text: string): string {
  return text.includes("§") ? text.replace(MINECRAFT_FORMAT_CODE, "") : text;
}
export function countryFlag(code: string | null) {
  if (!code || code.length !== 2) return "🌐";
  return code.toUpperCase().replace(/./g, (char) => String.fromCodePoint(127397 + char.charCodeAt(0)));
}

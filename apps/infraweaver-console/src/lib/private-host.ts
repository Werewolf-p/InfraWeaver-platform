/**
 * Private-network host detection — no I/O, no DNS resolution.
 *
 * Used by the SSRF allowlist to accept operator-supplied hostnames that are
 * unambiguously private (RFC1918 v4, loopback, link-local, IPv6 loopback/ULA/
 * link-local, or `.local`/single-label mDNS). This lets the wizard onboard a
 * new NAS box without a prior git edit while still failing closed against
 * public / attacker-controlled targets.
 *
 * A bare hostname is treated as private only when it has no dots (single-label
 * intranet name) or ends in `.local`. Multi-label DNS names are NOT considered
 * private here — the caller must additionally allow `.${INTERNAL_DOMAIN}` or
 * add the host explicitly.
 */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** True for a syntactically-valid IPv4 dotted-quad. */
function parseIpv4(host: string): [number, number, number, number] | null {
  const m = IPV4_RE.exec(host);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as const;
  if (parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) return null;
  return [parts[0], parts[1], parts[2], parts[3]];
}

/** IANA-private / loopback / link-local / CGNAT / benchmarking IPv4. */
export function isPrivateIpv4(host: string): boolean {
  const parsed = parseIpv4(host);
  if (!parsed) return false;
  const [a, b] = parsed;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  return false;
}

/**
 * Private IPv6: loopback (::1), unspecified (::), ULA (fc00::/7),
 * link-local (fe80::/10). Bracketed forms are unwrapped.
 */
export function isPrivateIpv6(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  // Drop IPv6 zone identifier ("fe80::1%eth0")
  const pct = h.indexOf("%");
  if (pct !== -1) h = h.slice(0, pct);
  if (!h.includes(":")) return false;
  if (h === "::1" || h === "::") return true;
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // fc00::/7
  if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) {
    return true; // fe80::/10
  }
  return false;
}

/**
 * Non-routable hostnames operators may reasonably use for a homelab NAS:
 * IPv4/IPv6 private ranges, `localhost`, `.local` (mDNS), and single-label
 * intranet names (no dots). Multi-label public-DNS names return false.
 */
export function isPrivateHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (!h) return false;
  if (h === "localhost") return true;
  if (isPrivateIpv4(h)) return true;
  if (isPrivateIpv6(h)) return true;
  if (h.endsWith(".local")) return true;
  if (!h.includes(".") && /^[a-z0-9-]+$/.test(h)) return true;
  return false;
}

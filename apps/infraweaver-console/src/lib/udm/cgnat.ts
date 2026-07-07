/**
 * CGNAT (carrier-grade NAT) detection.
 *
 * RFC 6598 reserves 100.64.0.0/10 for shared address space between the
 * subscriber and the ISP's NAT. A WAN IP inside that range means the router is
 * behind carrier NAT, so inbound port-forwards are unreachable from the public
 * internet — the console surfaces this so the operator knows a port-forward
 * alone will not expose a service.
 */

/** True when `ip` is a valid IPv4 address inside 100.64.0.0/10. */
export function isCgnatIp(ip: string): boolean {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return false;

  const octets = parts.map((p) => Number(p));
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false;
  // Reject non-canonical forms like "100.064" that Number() would still parse.
  if (parts.some((p) => p.length === 0 || !/^\d+$/.test(p))) return false;

  const [a, b] = octets;
  // 100.64.0.0/10 → first octet 100, second octet in [64, 127].
  return a === 100 && b >= 64 && b <= 127;
}

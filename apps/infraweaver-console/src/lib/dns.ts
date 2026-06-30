import { BASE_DOMAIN, INTERNAL_DOMAIN } from "@/lib/domain";

export const ROOT_DNS_DOMAIN = BASE_DOMAIN;
export const INTERNAL_DNS_DOMAIN = INTERNAL_DOMAIN;
export const MANAGED_RECORD_TYPES = ["A", "CNAME", "TXT"] as const;

export type ManagedRecordType = (typeof MANAGED_RECORD_TYPES)[number];

export interface ManagedDnsRecord {
  id: string;
  name: string;
  shortName: string;
  type: string;
  value: string;
  ttl: number;
  proxied: boolean;
  internal: boolean;
  createdAt?: string;
  updatedAt?: string;
}

const DNS_LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const DNS_NAME_REGEX = new RegExp(`^${DNS_LABEL}(?:\\.${DNS_LABEL})*$`);

export function isInternalDnsName(name: string) {
  return name.toLowerCase().endsWith(`.${INTERNAL_DNS_DOMAIN}`);
}

export function isManagedDnsName(name: string) {
  const normalized = name.trim().toLowerCase();
  return normalized.endsWith(`.${ROOT_DNS_DOMAIN}`) && normalized !== ROOT_DNS_DOMAIN;
}

export function relativeDnsName(name: string) {
  const normalized = name.trim().toLowerCase().replace(/\.+$/, "");
  if (normalized.endsWith(`.${INTERNAL_DNS_DOMAIN}`)) {
    return normalized.slice(0, -(`.${INTERNAL_DNS_DOMAIN}`.length));
  }
  if (normalized.endsWith(`.${ROOT_DNS_DOMAIN}`)) {
    return normalized.slice(0, -(`.${ROOT_DNS_DOMAIN}`.length));
  }
  return normalized;
}

export function normalizeRelativeDnsName(input: string) {
  const normalized = relativeDnsName(input)
    .replace(/^\.+|\.+$/g, "")
    .replace(/\.{2,}/g, ".");

  if (!normalized || !DNS_NAME_REGEX.test(normalized)) {
    throw new Error("Name must be a valid DNS-safe hostname or subdomain");
  }

  return normalized;
}

export function buildDnsName(input: string, internal: boolean) {
  const shortName = normalizeRelativeDnsName(input);
  return internal ? `${shortName}.${INTERNAL_DNS_DOMAIN}` : `${shortName}.${ROOT_DNS_DOMAIN}`;
}

// --- Arbitrary-zone helpers ---------------------------------------------
// The env zone (BASE_DOMAIN) splits into internal (`*.int.<domain>`) and public
// records. Any OTHER Cloudflare zone selected in the console has no such split,
// so these helpers operate relative to an explicit zone domain instead of the
// env constants. They keep the single-zone behavior above untouched.

/** Whether `name` is the apex of, or a subdomain under, `zoneDomain`. */
export function isManagedDnsNameForDomain(name: string, zoneDomain: string) {
  const normalized = name.trim().toLowerCase().replace(/\.+$/, "");
  const domain = zoneDomain.trim().toLowerCase();
  return normalized === domain || normalized.endsWith(`.${domain}`);
}

/** The label of `name` relative to `zoneDomain` (`@` for the apex record). */
export function relativeDnsNameForDomain(name: string, zoneDomain: string) {
  const normalized = name.trim().toLowerCase().replace(/\.+$/, "");
  const domain = zoneDomain.trim().toLowerCase();
  if (normalized === domain) return "@";
  if (normalized.endsWith(`.${domain}`)) return normalized.slice(0, -(domain.length + 1));
  return normalized;
}

/** Build a fully-qualified hostname for `input` under `zoneDomain`. */
export function buildDnsNameForDomain(input: string, zoneDomain: string) {
  const trimmed = input.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  const domain = zoneDomain.trim().toLowerCase();
  if (!trimmed || trimmed === "@") return domain;
  const shortName = normalizeRelativeDnsName(trimmed);
  return `${shortName}.${domain}`;
}

/**
 * The `?refresh=1` force-renew flag shared by the Manage overview + panel data
 * handlers. Pure and dependency-free (takes plain URLSearchParams, no Next
 * request) so both the server handlers and a unit test can call it directly.
 *
 * When set, the read path bypasses the durable snapshot + the per-replica SWR
 * cache and pulls the site's live current info, then refreshes the caches.
 */
export function isForceRefresh(params: URLSearchParams): boolean {
  const value = params.get("refresh");
  return value === "1" || value === "true";
}

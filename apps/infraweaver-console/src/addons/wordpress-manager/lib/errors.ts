/**
 * Typed domain errors carrying the HTTP status the API boundary should surface.
 * Their messages are deliberately safe to show to a caller (no vault paths or pod
 * names), so the handler can return them directly instead of a generic 500.
 */
export class AddonHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = new.target.name;
  }
}

/** The named site has not been provisioned (or was deleted). → 404 */
export class SiteNotFoundError extends AddonHttpError {
  constructor(site: string) {
    super(`WordPress site '${site}' does not exist`, 404);
  }
}

/** A dependency (pod, vault) is temporarily unavailable; the caller should retry. → 503 */
export class ServiceUnavailableError extends AddonHttpError {
  constructor(message: string) {
    super(message, 503);
  }
}

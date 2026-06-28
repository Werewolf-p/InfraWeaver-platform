/**
 * Typed errors for the SSO module. They carry an HTTP status so a route can map
 * them to a response without leaking Authentik internals or secrets.
 */

/** Authentik unreachable / timed out / 5xx — the caller may retry. */
export class SsoUnavailableError extends Error {
  readonly status = 503;
  constructor(message = "Authentik is temporarily unavailable") {
    super(message);
    this.name = "SsoUnavailableError";
  }
}

/** A misconfiguration the caller cannot recover from by retrying (bad token, missing flow). */
export class SsoConfigError extends Error {
  readonly status = 500;
  constructor(message: string) {
    super(message);
    this.name = "SsoConfigError";
  }
}

type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface CircuitBreakerOptions {
  failureThreshold?: number;
  windowMs?: number;
  cooldownMs?: number;
}

interface CircuitBreakerStatus {
  name: string;
  state: CircuitState;
  failures: number;
  lastFailureAt: number | null;
  nextAttemptAt: number | null;
}

class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failures = 0;
  private lastFailureAt: number | null = null;
  private openedAt: number | null = null;

  constructor(
    public readonly name: string,
    private readonly options: Required<CircuitBreakerOptions>,
  ) {}

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "OPEN") {
      const elapsed = Date.now() - (this.openedAt ?? 0);
      if (elapsed < this.options.cooldownMs) {
        const retryAfter = Math.ceil((this.options.cooldownMs - elapsed) / 1000);
        const error = Object.assign(new Error(`Circuit breaker OPEN for ${this.name}`), {
          status: 503,
          retryAfter,
        });
        throw error;
      }
      this.state = "HALF_OPEN";
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.lastFailureAt = null;
    this.openedAt = null;
    this.state = "CLOSED";
  }

  private onFailure() {
    const now = Date.now();
    if (this.lastFailureAt && now - this.lastFailureAt > this.options.windowMs) {
      this.failures = 0;
    }
    this.failures++;
    this.lastFailureAt = now;
    if (this.failures >= this.options.failureThreshold) {
      this.state = "OPEN";
      this.openedAt = now;
    }
  }

  getStatus(): CircuitBreakerStatus {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      lastFailureAt: this.lastFailureAt,
      nextAttemptAt:
        this.state === "OPEN" && this.openedAt
          ? this.openedAt + this.options.cooldownMs
          : null,
    };
  }
}

const DEFAULT_OPTIONS: Required<CircuitBreakerOptions> = {
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 30_000,
};

export const circuitBreakers = {
  argocd: new CircuitBreaker("argocd", DEFAULT_OPTIONS),
  prometheus: new CircuitBreaker("prometheus", DEFAULT_OPTIONS),
  authentik: new CircuitBreaker("authentik", DEFAULT_OPTIONS),
  longhorn: new CircuitBreaker("longhorn", DEFAULT_OPTIONS),
  gatus: new CircuitBreaker("gatus", DEFAULT_OPTIONS),
};

export function getAllCircuitBreakerStatuses(): CircuitBreakerStatus[] {
  return Object.values(circuitBreakers).map((cb) => cb.getStatus());
}

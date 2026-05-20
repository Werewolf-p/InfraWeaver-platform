interface InFlightEntry<T> {
  createdAt: number;
  promise: Promise<T>;
}

class RequestDedup {
  private inflight = new Map<string, InFlightEntry<unknown>>();

  dedupe<T>(key: string, factory: () => Promise<T>, reuseWindowMs = 100): Promise<T> {
    const now = Date.now();
    const existing = this.inflight.get(key) as InFlightEntry<T> | undefined;
    if (existing && now - existing.createdAt <= reuseWindowMs) {
      return existing.promise;
    }

    const entry: InFlightEntry<T> = {
      createdAt: now,
      promise: Promise.resolve()
        .then(factory)
        .finally(() => {
          const active = this.inflight.get(key);
          if (active === entry) {
            this.inflight.delete(key);
          }
        }),
    };

    this.inflight.set(key, entry);
    return entry.promise;
  }
}

export const requestDedup = new RequestDedup();

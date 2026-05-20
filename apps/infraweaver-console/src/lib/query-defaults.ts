export const queryStaleTimes = {
  live: 10_000,
  short: 30_000,
  minute: 60_000,
  long: 5 * 60_000,
} as const;

export const queryRefetchIntervals = {
  fast: 15_000,
  standard: 30_000,
  minute: 60_000,
} as const;

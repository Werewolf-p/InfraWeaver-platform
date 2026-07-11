function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function parseCronPart(part: string, min: number, max: number) {
  const values = new Set<number>();
  for (const section of part.split(",")) {
    const [rangePart, stepPart] = section.split("/");
    const step = Math.max(1, Number.parseInt(stepPart ?? "1", 10) || 1);
    if (rangePart === "*") {
      for (let value = min; value <= max; value += step) values.add(value);
      continue;
    }
    const [startRaw, endRaw] = rangePart.split("-");
    const start = clampNumber(Number.parseInt(startRaw, 10) || min, min, max);
    const end = clampNumber(Number.parseInt(endRaw ?? startRaw, 10) || start, min, max);
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

const MAX_PROBE_MINUTES = 525_600; // one year of minute-by-minute probing

interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

function parseCron(cronExpr: string): ParsedCron | null {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  return {
    minutes: parseCronPart(minute, 0, 59),
    hours: parseCronPart(hour, 0, 23),
    daysOfMonth: parseCronPart(dayOfMonth, 1, 31),
    months: parseCronPart(month, 1, 12),
    daysOfWeek: parseCronPart(dayOfWeek, 0, 6),
  };
}

function matchesParsedCron(date: Date, parsed: ParsedCron) {
  return (
    parsed.minutes.has(date.getMinutes()) &&
    parsed.hours.has(date.getHours()) &&
    parsed.daysOfMonth.has(date.getDate()) &&
    parsed.months.has(date.getMonth() + 1) &&
    parsed.daysOfWeek.has(date.getDay())
  );
}

export function matchesCronDate(date: Date, cronExpr: string) {
  const parsed = parseCron(cronExpr);
  return parsed ? matchesParsedCron(date, parsed) : false;
}

export function nextCronRuns(cronExpr: string, count = 1, fromDate = new Date()) {
  const runs: Date[] = [];
  const parsed = parseCron(cronExpr);
  if (!parsed) return runs;
  const cursor = new Date(fromDate);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  let attempts = 0;
  while (runs.length < count && attempts < MAX_PROBE_MINUTES) {
    if (matchesParsedCron(cursor, parsed)) {
      runs.push(new Date(cursor));
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
    attempts += 1;
  }
  return runs;
}

export function nextCronRun(cronExpr: string, fromDate = new Date()) {
  return nextCronRuns(cronExpr, 1, fromDate)[0] ?? null;
}

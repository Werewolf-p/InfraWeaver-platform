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

export function matchesCronDate(date: Date, cronExpr: string) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  return (
    parseCronPart(minute, 0, 59).has(date.getMinutes()) &&
    parseCronPart(hour, 0, 23).has(date.getHours()) &&
    parseCronPart(dayOfMonth, 1, 31).has(date.getDate()) &&
    parseCronPart(month, 1, 12).has(date.getMonth() + 1) &&
    parseCronPart(dayOfWeek, 0, 6).has(date.getDay())
  );
}

export function nextCronRuns(cronExpr: string, count = 1, fromDate = new Date()) {
  const runs: Date[] = [];
  const expr = cronExpr.trim();
  if (!expr || expr.split(/\s+/).length !== 5) return runs;
  const cursor = new Date(fromDate);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  let attempts = 0;
  while (runs.length < count && attempts < 525600) {
    if (matchesCronDate(cursor, expr)) {
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

interface Counter {
  [labels: string]: number;
}

interface Histogram {
  [labels: string]: number[];
}

const requestTotals: Counter = {};
const requestDurations: Histogram = {};

export function incrementRequestTotal(method: string, path: string, status: number): void {
  const key = `method="${method}",path="${normalizePath(path)}",status="${status}"`;
  requestTotals[key] = (requestTotals[key] ?? 0) + 1;
}

export function recordRequestDuration(method: string, path: string, durationMs: number): void {
  const key = `method="${method}",path="${normalizePath(path)}"`;
  if (!requestDurations[key]) requestDurations[key] = [];
  requestDurations[key].push(durationMs);
  if (requestDurations[key].length > 1000) requestDurations[key].shift();
}

function normalizePath(path: string): string {
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:id');
}

export function renderPrometheusMetrics(): string {
  const lines: string[] = [];

  lines.push('# HELP infraweaver_api_requests_total Total HTTP requests');
  lines.push('# TYPE infraweaver_api_requests_total counter');
  for (const [labels, count] of Object.entries(requestTotals)) {
    lines.push(`infraweaver_api_requests_total{${labels}} ${count}`);
  }

  lines.push('# HELP infraweaver_api_request_duration_ms HTTP request duration in milliseconds');
  lines.push('# TYPE infraweaver_api_request_duration_ms summary');
  for (const [labels, durations] of Object.entries(requestDurations)) {
    if (durations.length === 0) continue;
    const sorted = [...durations].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    const sum = sorted.reduce((a, b) => a + b, 0);
    lines.push(`infraweaver_api_request_duration_ms{${labels},quantile="0.5"} ${p50}`);
    lines.push(`infraweaver_api_request_duration_ms{${labels},quantile="0.95"} ${p95}`);
    lines.push(`infraweaver_api_request_duration_ms{${labels},quantile="0.99"} ${p99}`);
    lines.push(`infraweaver_api_request_duration_ms_sum{${labels}} ${sum}`);
    lines.push(`infraweaver_api_request_duration_ms_count{${labels}} ${sorted.length}`);
  }

  return lines.join('\n') + '\n';
}

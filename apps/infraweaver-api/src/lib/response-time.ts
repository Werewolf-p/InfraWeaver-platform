const RING_SIZE = 100;
const ringBuffer: number[] = new Array(RING_SIZE).fill(0);
let ringCount = 0;

export function recordResponseTime(ms: number): void {
  ringBuffer[ringCount % RING_SIZE] = ms;
  ringCount++;
}

export function computeP95(): number | null {
  if (ringCount === 0) return null;
  const filled = ringBuffer.slice(0, Math.min(ringCount, RING_SIZE));
  const sorted = [...filled].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * 0.95);
  return sorted[Math.min(idx, sorted.length - 1)];
}

export function getSampleCount(): number {
  return Math.min(ringCount, RING_SIZE);
}

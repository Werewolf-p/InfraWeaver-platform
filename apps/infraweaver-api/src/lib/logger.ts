export function info(message: string): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [INFO] ${message}`);
}

export function warn(message: string): void {
  const timestamp = new Date().toISOString();
  console.warn(`[${timestamp}] [WARN] ${message}`);
}

export function error(message: string, err?: unknown): void {
  const timestamp = new Date().toISOString();
  if (err !== undefined) {
    console.error(`[${timestamp}] [ERROR] ${message}`, err);
  } else {
    console.error(`[${timestamp}] [ERROR] ${message}`);
  }
}

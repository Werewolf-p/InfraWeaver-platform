import fs from "fs/promises";

/**
 * Writes a structured audit log entry to stdout and appends to the audit log file.
 * The file path is intentionally writable inside the container at runtime.
 */
export async function auditLog(action: string, user: string, detail: string): Promise<void> {
  const entry = `[${new Date().toISOString()}] USER=${user} ACTION=${action} DETAIL=${detail}\n`;
  // Always log to stdout so `kubectl logs` captures it
  console.log(`AUDIT: ${entry.trim()}`);
  try {
    await fs.appendFile("/tmp/infraweaver-audit.log", entry);
  } catch {
    // Non-fatal: audit file write failure must not break the request
  }
}

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { auditLog } from "@/lib/audit-log";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";
import { execFile } from "child_process";
import { promisify } from "util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

// Strict allowlist of safe read-only diagnostic commands
const ALLOWED_COMMANDS = new Set([
  "ls", "ls -la", "ls -l",
  "cat /etc/os-release",
  "env", "ps", "ps aux",
  "df", "df -h",
  "free", "free -h",
  "uname -a", "id", "pwd", "date",
]);

// RFC 1123 DNS label: lowercase alphanumeric and hyphens, no leading/trailing hyphens
const K8S_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const ExecBody = z.object({
  namespace: z.string().min(1).max(63).regex(K8S_NAME_RE, "Invalid namespace name"),
  pod:       z.string().min(1).max(253).regex(K8S_NAME_RE, "Invalid pod name"),
  container: z.string().min(1).max(253).regex(K8S_NAME_RE, "Invalid container name"),
  command:   z.string().min(1).max(200),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "cluster:admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!checkRateLimit(rateLimitKey("pods-exec", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const parsed = ExecBody.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { namespace, pod, container, command } = parsed.data;

  if (!ALLOWED_COMMANDS.has(command)) {
    return NextResponse.json({ error: "Command not allowed" }, { status: 403 });
  }

  await auditLog("pods:exec", session.user?.email ?? "unknown", `${namespace}/${pod}/${container} — ${command}`);

  try {
    // execFile avoids shell expansion — args are passed directly without shell interpretation
    const args = command.split(/\s+/);
    const { stdout, stderr } = await execFileAsync("kubectl", [
      "exec", "-n", namespace, pod, "-c", container, "--", ...args,
    ]);
    return NextResponse.json({ output: stdout, error: stderr || null });
  } catch (err) {
    return NextResponse.json({ output: "", error: safeError(err) }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const ALLOWED_COMMANDS = ["ls", "cat /etc/os-release", "env", "ps", "df", "free", "uname -a", "id", "pwd", "date", "ls -la", "ls -l", "df -h", "free -h", "ps aux"];

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json() as { namespace?: string; pod?: string; container?: string; command?: string };
  const { namespace, pod, container, command } = body;
  if (!namespace || !pod || !container || !command) return NextResponse.json({ error: "Missing params" }, { status: 400 });
  if (!ALLOWED_COMMANDS.includes(command)) return NextResponse.json({ error: "Command not allowed" }, { status: 403 });
  try {
    const { stdout, stderr } = await execAsync(`kubectl exec -n ${namespace} ${pod} -c ${container} -- sh -c "${command}"`);
    return NextResponse.json({ output: stdout, error: stderr || null });
  } catch (err) {
    return NextResponse.json({ output: "", error: String(err) });
  }
}

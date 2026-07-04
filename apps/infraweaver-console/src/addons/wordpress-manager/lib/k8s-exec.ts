import { PassThrough, Readable } from "node:stream";
import * as k8s from "@kubernetes/client-node";
import { loadKubeConfig } from "@/lib/k8s";
import { WORDPRESS_NAMESPACE } from "./wordpress-rbac";

/**
 * Run a shell command inside the WordPress container of a site's running pod and
 * capture stdout/stderr. Self-contained to the addon so it carries its own exec
 * path rather than depending on another addon's helpers.
 */
export interface ExecOptions {
  /** Piped to the command's stdin — use this to pass secrets so they never appear
   *  as a process argument (and thus never land in the k8s exec audit log). */
  stdin?: string;
  timeoutMs?: number;
  /** Hard ceiling on captured stdout+stderr; over it the exec is aborted. */
  maxOutputBytes?: number;
}

/**
 * Cap on total captured output. The WordPress container is a separate trust
 * domain: a compromised or buggy site could stream unbounded bytes back over a
 * signed-command or proof exec, and the console buffers the whole thing in
 * memory before parsing. 1 MB comfortably fits every real payload (the biggest
 * is the base64 plugin zip we send *in*, not out) while denying an OOM lever
 * against the shared console process.
 */
const MAX_EXEC_OUTPUT_BYTES = 1024 * 1024;

export async function execInWpPod(podName: string, script: string, opts: ExecOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const { stdin = null, timeoutMs = 60_000, maxOutputBytes = MAX_EXEC_OUTPUT_BYTES } = opts;
  const kc = loadKubeConfig();
  const exec = new k8s.Exec(kc);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdinStream = stdin !== null ? Readable.from([stdin]) : null;

  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    let total = 0;
    let settled = false;
    let ws: { close: () => void } | null = null;

    // Single-shot settle: guarantees we clear the timer and close the socket
    // exactly once whether we finish, time out, or trip the byte cap.
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws?.close();
      fn();
    };
    const timer = setTimeout(
      () => settle(() => reject(new Error(`exec timed out after ${timeoutMs}ms`))),
      timeoutMs,
    );
    // Returns false once the cap is tripped so the caller stops appending.
    const withinCap = (added: number): boolean => {
      total += added;
      if (total > maxOutputBytes) {
        settle(() => reject(new Error(`exec output exceeded ${maxOutputBytes} bytes`)));
        return false;
      }
      return true;
    };
    stdout.on("data", (chunk) => {
      if (settled) return;
      const text = chunk.toString();
      if (withinCap(Buffer.byteLength(text))) out += text;
    });
    stderr.on("data", (chunk) => {
      if (settled) return;
      const text = chunk.toString();
      if (withinCap(Buffer.byteLength(text))) err += text;
    });

    exec
      .exec(
        WORDPRESS_NAMESPACE,
        podName,
        "wordpress",
        ["sh", "-c", script],
        stdout,
        stderr,
        stdinStream,
        false,
        (status) => {
          settle(() => {
            if (status.status === "Failure") {
              reject(new Error(`exec failed: ${status.message ?? err}`));
            } else {
              resolve({ stdout: out, stderr: err });
            }
          });
        },
      )
      .then((socket) => {
        ws = socket as unknown as { close: () => void };
        // If the cap or timeout already fired, close the late-arriving socket.
        if (settled) ws.close();
      })
      .catch((error) => settle(() => reject(error)));
  });
}

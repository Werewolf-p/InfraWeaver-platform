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
}

export async function execInWpPod(podName: string, script: string, opts: ExecOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const { stdin = null, timeoutMs = 60_000 } = opts;
  const kc = loadKubeConfig();
  const exec = new k8s.Exec(kc);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdinStream = stdin !== null ? Readable.from([stdin]) : null;
  let out = "";
  let err = "";
  stdout.on("data", (chunk) => (out += chunk.toString()));
  stderr.on("data", (chunk) => (err += chunk.toString()));

  return new Promise((resolve, reject) => {
    let ws: { close: () => void } | null = null;
    const timer = setTimeout(() => {
      // Close the underlying socket so a hung exec doesn't leak a connection.
      ws?.close();
      reject(new Error(`exec timed out after ${timeoutMs}ms`));
    }, timeoutMs);
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
          clearTimeout(timer);
          if (status.status === "Failure") {
            reject(new Error(`exec failed: ${status.message ?? err}`));
          } else {
            resolve({ stdout: out, stderr: err });
          }
        },
      )
      .then((socket) => {
        ws = socket as unknown as { close: () => void };
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

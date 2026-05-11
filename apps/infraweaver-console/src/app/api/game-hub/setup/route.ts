import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(process.cwd(), "../../..");

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const apiExtApi = kc.makeApiClient(k8s.ApiextensionsV1Api);

    // Check namespace
    let nsExists = false;
    try {
      await coreApi.readNamespace({ name: "game-hub" });
      nsExists = true;
    } catch {}

    // Check CRD
    let crdExists = false;
    try {
      await apiExtApi.readCustomResourceDefinition({ name: "gameservers.infraweaver.rlservers.com" });
      crdExists = true;
    } catch {}

    // Check Longhorn
    let longhornAvailable = false;
    try {
      const storageApi = kc.makeApiClient(k8s.StorageV1Api);
      const scs = await storageApi.listStorageClass();
      longhornAvailable = (scs.items ?? []).some((sc: { metadata?: { name?: string } }) => sc.metadata?.name === "longhorn");
    } catch {}

    return NextResponse.json({ nsExists, crdExists, longhornAvailable, ready: nsExists && crdExists && longhornAvailable });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const results: Array<{ resource: string; status: string; error?: string }> = [];

  const manifests = [
    path.join(REPO_ROOT, "kubernetes/crds/gameserver-crd.yaml"),
    path.join(REPO_ROOT, "kubernetes/catalog/game-hub/namespace.yaml"),
  ];

  for (const manifest of manifests) {
    try {
      await execFileAsync("kubectl", ["apply", "-f", manifest]);
      results.push({ resource: path.basename(manifest), status: "applied" });
    } catch (err) {
      results.push({ resource: path.basename(manifest), status: "error", error: String(err) });
    }
  }

  return NextResponse.json({ results });
}

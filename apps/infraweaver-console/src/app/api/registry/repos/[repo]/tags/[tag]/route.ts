import { NextRequest, NextResponse } from "next/server";

const REGISTRY_HOST = process.env.REGISTRY_HOST ?? "registry.int.rlservers.com";
const REGISTRY_USERNAME = process.env.REGISTRY_USERNAME ?? "";
const REGISTRY_PASSWORD = process.env.REGISTRY_PASSWORD ?? "";

function getAuthHeader(): Record<string, string> {
  if (!REGISTRY_USERNAME || !REGISTRY_PASSWORD) return {};
  return {
    Authorization: `Basic ${Buffer.from(`${REGISTRY_USERNAME}:${REGISTRY_PASSWORD}`).toString("base64")}`,
  };
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ repo: string; tag: string }> }) {
  const { repo: encodedRepo, tag } = await params;
  const repo = decodeURIComponent(encodedRepo);
  try {
    const manifestRes = await fetch(`https://${REGISTRY_HOST}/v2/${repo}/manifests/${tag}`, {
      headers: {
        ...getAuthHeader(),
        Accept: "application/vnd.docker.distribution.manifest.v2+json",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!manifestRes.ok) throw new Error(`Failed to get manifest: ${manifestRes.status}`);
    const digest = manifestRes.headers.get("Docker-Content-Digest");
    if (!digest) throw new Error("No digest found");
    const deleteRes = await fetch(`https://${REGISTRY_HOST}/v2/${repo}/manifests/${digest}`, {
      method: "DELETE",
      headers: { ...getAuthHeader() },
      signal: AbortSignal.timeout(5000),
    });
    if (!deleteRes.ok && deleteRes.status !== 202) {
      throw new Error(`Delete failed: ${deleteRes.status}`);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// Platform infrastructure config (kubernetes/<app>/values.yaml, envs/<env>/cluster.yaml)
// lives in the SEPARATE private infra repo, not the console's own GITHUB_REPO. These
// helpers read and write it via the GitHub contents API using the same GITHUB_TOKEN
// the init container uses to clone that repo (EXTERNAL_ROUTES_REPO). Reading these
// paths through the normal git-provider (which targets GITHUB_REPO) 404s, which is
// why the Infrastructure settings page reported "Repository file not found".

const API_URL = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
// The infra repo is the one the init container clones (EXTERNAL_ROUTES_REPO); INFRA_REPO
// is accepted as a clearer alias. It must be set on the main container (not just the
// init container) for the Infrastructure settings routes to read/write config.
const INFRA_REPO = (process.env.INFRA_REPO || process.env.EXTERNAL_ROUTES_REPO) ?? "";
const TOKEN = process.env.GITHUB_TOKEN ?? "";
const COMMITTER = { name: "InfraWeaver Console", email: "console@infraweaver.internal" };

export function infraRepoConfigured(): boolean {
  return Boolean(INFRA_REPO && TOKEN);
}

function repoApi(): string {
  if (!INFRA_REPO || !TOKEN) {
    throw new Error("Infra repo is not configured (set EXTERNAL_ROUTES_REPO and GITHUB_TOKEN)");
  }
  return `${API_URL}/repos/${INFRA_REPO}`;
}

function headers(includeJson = false): HeadersInit {
  const h: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "infraweaver-console",
    Authorization: `Bearer ${TOKEN}`,
  };
  if (includeJson) h["Content-Type"] = "application/json";
  return h;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/^\/+/, "").replace(/\\/g, "/");
}

export interface InfraRepoFile {
  content: string;
  sha: string;
}

/** Read a file from the infra repo, or null when it does not exist. */
export async function readInfraRepoFile(filePath: string): Promise<InfraRepoFile | null> {
  const path = normalizePath(filePath);
  const res = await fetch(`${repoApi()}/contents/${path}`, { headers: headers(), cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Infra repo GET ${path}: ${res.status}`);
  const data = (await res.json()) as { content: string; sha: string };
  return {
    content: Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf-8"),
    sha: data.sha,
  };
}

/** Create-or-update a single file in the infra repo. Resolves the blob sha when omitted. */
export async function writeInfraRepoFile(filePath: string, content: string, message: string, sha?: string): Promise<void> {
  const path = normalizePath(filePath);
  const resolvedSha = sha ?? (await readInfraRepoFile(path))?.sha;
  const res = await fetch(`${repoApi()}/contents/${path}`, {
    method: "PUT",
    headers: headers(true),
    body: JSON.stringify({
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      ...(resolvedSha ? { sha: resolvedSha } : {}),
      committer: COMMITTER,
    }),
  });
  if (!res.ok) throw new Error(`Infra repo PUT ${path}: ${res.status} — ${await res.text()}`);
}

/** Create-or-update several files in the infra repo under one logical change. */
export async function writeInfraRepoFiles(files: Array<{ path: string; content: string }>, message: string): Promise<void> {
  for (const file of files) {
    await writeInfraRepoFile(file.path, file.content, message);
  }
}

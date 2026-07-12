// Platform infrastructure config (kubernetes/<app>/values.yaml, envs/<env>/cluster.yaml)
// lives in the SEPARATE private infra repo, not the console's own GITHUB_REPO. These
// helpers read and write it via the GitHub contents API using the same GITHUB_TOKEN
// the init container uses to clone that repo (EXTERNAL_ROUTES_REPO). Reading these
// paths through the normal git-provider (which targets GITHUB_REPO) 404s, which is
// why the Infrastructure settings page reported "Repository file not found".

import { createGithubContentsClient, type GithubContentsClient } from "@/lib/github-contents-client";

const API_URL = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
// The infra repo is the one the init container clones (EXTERNAL_ROUTES_REPO); INFRA_REPO
// is accepted as a clearer alias. It must be set on the main container (not just the
// init container) for the Infrastructure settings routes to read/write config.
const INFRA_REPO = (process.env.INFRA_REPO || process.env.EXTERNAL_ROUTES_REPO) ?? "";
const TOKEN = process.env.GITHUB_TOKEN ?? "";

export function infraRepoConfigured(): boolean {
  return Boolean(INFRA_REPO && TOKEN);
}

function client(): GithubContentsClient {
  if (!INFRA_REPO || !TOKEN) {
    throw new Error("Infra repo is not configured (set EXTERNAL_ROUTES_REPO and GITHUB_TOKEN)");
  }
  return createGithubContentsClient({ apiUrl: API_URL, repo: INFRA_REPO, token: TOKEN });
}

export interface InfraRepoFile {
  content: string;
  sha: string;
}

/** Read a file from the infra repo, or null when it does not exist. */
export async function readInfraRepoFile(filePath: string): Promise<InfraRepoFile | null> {
  return client().readFile(filePath);
}

/** Create-or-update a single file in the infra repo. Resolves the blob sha when omitted. */
export async function writeInfraRepoFile(filePath: string, content: string, message: string, sha?: string): Promise<void> {
  await client().writeFile(filePath, content, message, sha);
}

/** Create-or-update several files in the infra repo under one logical change. */
export async function writeInfraRepoFiles(files: Array<{ path: string; content: string }>, message: string): Promise<void> {
  const repoClient = client();
  for (const file of files) {
    await repoClient.writeFile(file.path, file.content, message);
  }
}

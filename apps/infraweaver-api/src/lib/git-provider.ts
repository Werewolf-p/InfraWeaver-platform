import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const GITHUB_API = 'https://api.github.com';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';
const GITHUB_REPO = process.env.GITHUB_REPO ?? 'your-org/your-repo';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH ?? 'main';

const ONEDEV_URL = (process.env.ONEDEV_URL ?? 'http://onedev.onedev.svc.cluster.local').replace(/\/$/, '');
const ONEDEV_TOKEN = process.env.ONEDEV_TOKEN ?? '';
const ONEDEV_PROJECT_PATH = process.env.ONEDEV_PROJECT_PATH ?? 'InfraWeaver-platform';
const ONEDEV_BRANCH = process.env.ONEDEV_BRANCH ?? 'main';
const ONEDEV_USERNAME = process.env.ONEDEV_USERNAME ?? 'admin';
const GIT_WORKTREE_ROOT = process.env.GIT_WORKTREE_ROOT ?? '/git-cache';

const COMMIT_AUTHOR = { name: 'InfraWeaver API', email: 'api@infraweaver.internal' };

export interface GitFile {
  content: string;
  sha: string;
}

export interface AppTreeEntry {
  path: string;
  sha: string;
}

export function isOnedev(): boolean {
  return (process.env.GIT_PROVIDER ?? 'github').toLowerCase() === 'onedev';
}

// ─── GitHub ──────────────────────────────────────────────────────────────────

function githubHeaders(json = false): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
  };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

export async function githubGetTree(): Promise<AppTreeEntry[]> {
  const res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1`, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`GitHub tree fetch failed: ${res.status}`);
  const data = await res.json() as { tree: Array<{ path: string; sha: string; type: string }> };
  return data.tree
    .filter((item) => item.type === 'blob' && item.path.startsWith('kubernetes/') && item.path.endsWith('application.yaml'))
    .map(({ path: p, sha }) => ({ path: p, sha }));
}

export async function githubGetFile(filePath: string): Promise<GitFile | null> {
  const res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/contents/${filePath}?ref=${GITHUB_BRANCH}`, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${filePath}: ${res.status}`);
  const data = await res.json() as { content: string; sha: string };
  return { content: Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8'), sha: data.sha };
}

export async function githubPutFile(filePath: string, content: string, message: string, sha: string): Promise<string> {
  const res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/contents/${filePath}`, {
    method: 'PUT',
    headers: githubHeaders(true),
    body: JSON.stringify({
      message,
      content: Buffer.from(content).toString('base64'),
      sha,
      committer: COMMIT_AUTHOR,
      branch: GITHUB_BRANCH,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`GitHub PUT ${filePath}: ${res.status} — ${await res.text()}`);
  const data = await res.json() as { commit?: { sha?: string } };
  return data.commit?.sha ?? '';
}

// ─── Onedev (simple-git) ─────────────────────────────────────────────────────

function onedevRepoUrlWithAuth(): string {
  // Embed credentials into the URL so git can authenticate without a credential helper.
  return ONEDEV_URL.replace('://', `://${encodeURIComponent(ONEDEV_USERNAME)}:${encodeURIComponent(ONEDEV_TOKEN)}@`) + `/${ONEDEV_PROJECT_PATH}.git`;
}

function isPushRejection(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /non-fast-forward|fetch first|push rejected|failed to push/i.test(msg);
}

async function withWorktree<T>(worker: (dir: string) => Promise<T>): Promise<T> {
  if (!ONEDEV_TOKEN) throw new Error('ONEDEV_TOKEN is not set');
  const { simpleGit } = await import('simple-git');
  const dir = path.join(GIT_WORKTREE_ROOT, randomUUID());
  await fs.mkdir(dir, { recursive: true });
  try {
    await simpleGit().clone(onedevRepoUrlWithAuth(), dir, ['--depth', '1', '--branch', ONEDEV_BRANCH]);
    return await worker(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function walkDir(fsDir: string, relDir: string, filter: (p: string) => boolean): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(path.join(fsDir, relDir), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const relPath = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      results.push(...await walkDir(fsDir, relPath, filter));
    } else if (filter(relPath)) {
      results.push(relPath);
    }
  }
  return results;
}

export async function onedevGetTreeAndFiles(): Promise<Array<{ path: string; content: string; sha: string }>> {
  return withWorktree(async (dir) => {
    const { simpleGit } = await import('simple-git');
    const sha = (await simpleGit(dir).revparse(['HEAD'])).trim();
    const appFiles = await walkDir(dir, 'kubernetes', (p) => p.endsWith('/application.yaml'));
    return Promise.all(appFiles.map(async (relPath) => {
      const content = await fs.readFile(path.join(dir, relPath), 'utf-8');
      return { path: relPath, content, sha };
    }));
  });
}

export async function onedevGetFile(filePath: string): Promise<GitFile | null> {
  return withWorktree(async (dir) => {
    try {
      const { simpleGit } = await import('simple-git');
      const content = await fs.readFile(path.join(dir, filePath), 'utf-8');
      const sha = (await simpleGit(dir).revparse(['HEAD'])).trim();
      return { content, sha };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  });
}

export async function onedevPutFile(filePath: string, content: string, message: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await withWorktree(async (dir) => {
        const { simpleGit } = await import('simple-git');
        const git = simpleGit(dir);
        await git.addConfig('user.name', COMMIT_AUTHOR.name);
        await git.addConfig('user.email', COMMIT_AUTHOR.email);
        await fs.mkdir(path.dirname(path.join(dir, filePath)), { recursive: true });
        await fs.writeFile(path.join(dir, filePath), content, 'utf-8');
        await git.add(['.']);
        await git.commit(message);
        await git.push('origin', ONEDEV_BRANCH);
        return (await git.revparse(['HEAD'])).trim();
      });
    } catch (err) {
      if (attempt < 2 && isPushRejection(err)) continue;
      throw err;
    }
  }
  throw new Error('Unreachable');
}

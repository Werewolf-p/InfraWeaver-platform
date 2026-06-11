// fix-context.js — gives the auto-fix agent the two things it was missing when it
// burned 8 redos on one bug (game server "won't stop"): MEMORY of what prior
// attempts already tried (so it stops reinventing failed theories) and GROUND
// TRUTH about the live cluster (so its theories are checked against reality, not
// guessed). Both are injected into the fix prompt by server.js::runPipeline.
//
// Everything here is best-effort and read-only: a failure to gather context must
// never block a fix, so each probe is wrapped and falls back to a short note.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function sh(cmd, timeout = 8000) {
  try { return execSync(cmd, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

// ── Prior-attempt memory ─────────────────────────────────────────────────────
// Each feedback id has a runs/<id>/ dir of per-run .log transcripts. We mine the
// most recent attempts for the theory they pursued and the files they changed,
// then hand the agent a "these did NOT work — do something genuinely different"
// digest. This is the single highest-value signal: the same bug had been retried
// 8 times, each attempt blind to the previous seven.
function priorAttemptsDigest(runsDir, feedbackId, max = 6) {
  try {
    const dir = path.join(runsDir, feedbackId);
    if (!fs.existsSync(dir)) return '';
    const logs = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, max);
    if (logs.length === 0) return '';

    const attempts = [];
    for (const { f } of logs) {
      const kind = f.split('-')[0]; // approve | redo | revert | validate | publish
      if (kind === 'revert' || kind === 'validate') continue;
      let text = '';
      try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      attempts.push({ f, summary: summariseAttempt(text) });
    }
    if (attempts.length === 0) return '';

    const lines = attempts.map((a, i) => `Attempt ${attempts.length - i} (${a.f}):\n${a.summary}`);
    return [
      `This exact feedback has ${attempts.length} prior auto-fix attempt(s) that did NOT`,
      `resolve it. Do NOT repeat any theory or file change below — if your plan matches`,
      `a prior attempt, it is wrong by definition. Find a genuinely different root cause.`,
      '',
      lines.join('\n\n'),
    ].join('\n');
  } catch {
    return '';
  }
}

// Pull the signal out of one run transcript: the root-cause theory it settled on
// and the files it changed. Heuristic, transcript-format aware (PHASE markers,
// `N files changed`, file-path mentions), capped so the digest stays compact.
function summariseAttempt(text) {
  const out = [];
  // The "Implement"/"Verify" phase usually states the theory in prose.
  const theory = matchAround(text, /root cause|the bug was|caused by|because|actually|the real fix/i, 240);
  if (theory) out.push(`  theory: ${theory}`);
  // Files changed (committing phase prints `git commit` stat lines).
  const files = [...text.matchAll(/^\s*([\w./-]+\.(?:ts|tsx|js|yaml|yml|json))\b/gm)]
    .map((m) => m[1]).filter((p) => !p.startsWith('node_modules'));
  const uniq = [...new Set(files)].slice(0, 8);
  if (uniq.length) out.push(`  touched: ${uniq.join(', ')}`);
  const changed = text.match(/(\d+ files? changed[^\n]*)/);
  if (changed) out.push(`  diffstat: ${changed[1]}`);
  return out.length ? out.join('\n') : '  (no extractable detail)';
}

function matchAround(text, re, len) {
  const m = text.match(re);
  if (!m) return '';
  const i = Math.max(0, m.index - 20);
  return text.slice(i, i + len).replace(/\s+/g, ' ').trim();
}

// ── Live cluster facts ───────────────────────────────────────────────────────
// Ground truth the agent cannot infer from the code. The single most important
// fact in this platform: ArgoCD reads the *Application definitions* (app-of-apps)
// from OneDev, while each app's *workload manifests* come from GitHub. A fix that
// edits the wrong source is inert — the trap that defeated every game-hub attempt.
function clusterFacts(ctx = {}) {
  const facts = [];

  // GitOps topology — always relevant, the recurring failure mode here.
  facts.push(gitopsTopology());

  // Page/area-specific ground truth.
  const area = `${ctx.pagePath || ''} ${ctx.description || ''}`.toLowerCase();
  if (/game|server|valheim|minecraft|stop|start/.test(area)) {
    facts.push(gameHubFacts());
  }

  const body = facts.filter(Boolean).join('\n\n');
  return body
    ? `Ground truth from the LIVE cluster (verified now — trust this over assumptions in the code/comments):\n\n${body}`
    : '';
}

function gitopsTopology() {
  const apps = sh(`kubectl get applications -n argocd -o jsonpath='{range .items[*]}{.metadata.name}{"|"}{.spec.source.repoURL}{"|"}{.spec.source.path}{"\\n"}{end}'`, 8000);
  if (!apps) return '';
  const onedev = [];
  const github = [];
  for (const line of apps.split('\n')) {
    const [name, repo, p] = line.split('|');
    if (!name) continue;
    if (/onedev/i.test(repo)) onedev.push(`${name} (${p || ''})`);
    else if (/github/i.test(repo)) github.push(name);
  }
  return [
    'GitOps sourcing (CRITICAL — a fix in the wrong repo is silently inert):',
    `- ArgoCD app-of-apps / Application *definitions* come from OneDev: ${onedev.slice(0, 12).join(', ') || '(none found)'}.`,
    `- Workload *manifests* come from GitHub InfraWeaver-infra: ${github.length} apps.`,
    '- The dispatch pipeline pushes console code to GitHub InfraWeaver-platform and bumps the',
    '  image pin in GitHub InfraWeaver-infra. It does NOT push to OneDev. So any change to an',
    '  ArgoCD Application spec (syncPolicy, ignoreDifferences, source, etc.) must be made in the',
    '  OneDev copy of InfraWeaver-platform or it will never reach the cluster.',
  ].join('\n');
}

function gameHubFacts() {
  const ns = 'game-hub';
  const hpas = sh(`kubectl get hpa -n ${ns} --no-headers 2>/dev/null | wc -l`);
  const app = 'catalog-game-hub-servers';
  const sync = sh(`kubectl get application -n argocd ${app} -o jsonpath='selfHeal={.spec.syncPolicy.automated.selfHeal} syncOptions={.spec.syncPolicy.syncOptions} ignoreReplicas={.spec.ignoreDifferences[0].jsonPointers}'`);
  return [
    'game-hub stop/start behaviour:',
    `- HorizontalPodAutoscalers in ns ${ns}: ${hpas || '0'} (if 0, "delete the HPA" fixes are inert).`,
    `- ArgoCD ${app}: ${sync || '(unreadable)'}.`,
    '- A console "stop" scales the Deployment to replicas:0. The ROBUST way to make that stick',
    '  under ArgoCD selfHeal is to OMIT spec.replicas from the git server manifest',
    '  (kubernetes/catalog/game-hub/servers/<name>.yaml in GitHub InfraWeaver-infra) so ArgoCD',
    '  relinquishes replicas to the console. ignoreDifferences on /spec/replicas is also set.',
    '  NOTE: RespectIgnoreDifferences=true alone did NOT work here — under ServerSideApply',
    '  selfHeal re-applies replicas:1 from git within ~1s regardless. Do not rely on it.',
    '  The server manifest is in GitHub-infra; the Application *spec* is in OneDev (see above).',
  ].join('\n');
}

module.exports = { priorAttemptsDigest, clusterFacts };

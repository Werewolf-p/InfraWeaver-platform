/**
 * InfraWeaver Coding Agent Dispatch Service (single-branch feedback pipeline)
 *
 * HTTP service the console calls directly (no n8n) to drive the feedback flow:
 *   POST /approve    — run Claude (plan→validate→implement) on the shared
 *                      `feedback/staging` branch, build ONE image in-cluster via
 *                      BuildKit, push to the self-hosted Zot registry, and repoint
 *                      the single shared `staging` dev env at the cumulative tip
 *                      (fixes from every approved entry accumulate on one env).
 *   POST /validate   — reviewer verdict: `validated` keeps the commit on staging;
 *                      `not_fixed` reverts it and re-runs the cycle with a note.
 *   POST /publish    — merge feedback/staging → main, build+push the release
 *                      image, bump the console deployment image pin (GitOps), and
 *                      tear the shared staging env down. Publishes everything at
 *                      once; nothing reaches prod until publish.
 *   GET  /runs?feedbackId= , /runs/:runId/log , /runs/:runId/stream (SSE)
 *                    — live + historical Claude/build output for the dashboard.
 *   GET/PUT /pipeline , POST /pipeline/reset
 *                    — Agent Studio: the editable, n8n-style auto-fix pipeline
 *                      (ordered steps with per-step prompt / agent / model /
 *                      specialism / tool allowlist / MCP plugins). See
 *                      pipeline-store.js; runPipeline() executes it on /approve.
 *   GET /specialists , POST /specialists/refresh , GET /catalog
 *                    — the dynamic specialist-prompt library (GitHub-sourced) and
 *                      the UI option catalogs. See specialists.js.
 *
 * Runs on port 9876, cluster/localhost only. See project memory
 * `project_feedback_image_pipeline` for the build/registry gotchas.
 */
const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pipelineStore = require('./pipeline-store');
const specialists = require('./specialists');

const PORT = process.env.DISPATCH_PORT || 9876;
const WORKSPACE = process.env.WORKSPACE_DIR || '/home/runner/InfraWeaver-platform';
const CONSOLE_DIR = path.join(WORKSPACE, 'apps/infraweaver-console');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const RUNS_DIR = path.join(__dirname, 'runs');

// Pipeline settings.
const FEEDBACK_BRANCH = process.env.FEEDBACK_BRANCH || 'feedback/staging';
const REGISTRY = process.env.REGISTRY || 'registry.int.rlservers.com';
const IMAGE = process.env.CONSOLE_IMAGE || `${REGISTRY}/infraweaver-console`;
// Workspace push target for the console *source* pipeline. GitHub `origin` is
// canonical: the leaf manifest ArgoCD apps + the image-pin bump read it, and
// OneDev has no reachable route from this runner. The OneDev umbrella app-of-apps
// only watches kubernetes/* (untouched here), so sourcing app fixes from GitHub
// does not affect deployed cluster state.
const GIT_REMOTE = process.env.GIT_REMOTE || 'origin';
const PREVIEW_HOST = process.env.PREVIEW_HOST || 'infraweaver-console-preview.int.rlservers.com';
const PREVIEW_SCRIPT = path.join(__dirname, 'preview.sh');
const BUILDKIT_NODEPORT = process.env.BUILDKIT_NODEPORT || '31234';
const BUILDCTL = process.env.BUILDCTL || '/home/runner/.local/bin/buildctl';
// Infra repo (ArgoCD source of truth) for the publish image-pin bump.
const INFRA_DIR = process.env.INFRA_DIR || '/home/runner/InfraWeaver-infra';
const INFRA_DEPLOYMENT = process.env.INFRA_DEPLOYMENT ||
  'kubernetes/catalog/infraweaver-console/manifests/deployment.yaml';

// Sanitize an id for safe use in branch names / shell args / k8s names.
function safeId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 40);
}

// ── Run logging (powers the dashboard's live console + audit history) ───────────
// Each run is a JSON record in runs/index.json with the full transcript at
// runs/<feedbackId>/<runId>.log. Live runs stream to in-memory SSE subscribers.
fs.mkdirSync(RUNS_DIR, { recursive: true });
const INDEX_FILE = path.join(RUNS_DIR, 'index.json');
const subscribers = new Map(); // runId -> Set<res>

function readIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { return []; }
}
function writeIndex(records) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(records.slice(0, 1000), null, 2));
}
function upsertRecord(rec) {
  const all = readIndex();
  const i = all.findIndex(r => r.runId === rec.runId);
  if (i >= 0) all[i] = rec; else all.unshift(rec);
  writeIndex(all);
}

function newRun(feedbackId, kind) {
  const id = safeId(feedbackId) || 'adhoc';
  const runId = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const dir = path.join(RUNS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, `${runId}.log`);
  const stream = fs.createWriteStream(logPath, { flags: 'a' });
  const rec = {
    runId, feedbackId: id, kind, phase: 'starting', status: 'running',
    startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
    previewUrl: null, tag: null, commit: null,
  };
  upsertRecord(rec);

  const run = {
    rec, logPath,
    append(chunk) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      stream.write(text);
      const subs = subscribers.get(runId);
      if (subs) for (const res of subs) res.write(`data: ${JSON.stringify({ log: text })}\n\n`);
    },
    setPhase(phase) {
      rec.phase = phase;
      upsertRecord(rec);
      run.append(`\n=== PHASE: ${phase} ===\n`);
      const subs = subscribers.get(runId);
      if (subs) for (const res of subs) res.write(`event: phase\ndata: ${JSON.stringify({ phase })}\n\n`);
    },
    finish(status, extra = {}) {
      Object.assign(rec, extra, { status, finishedAt: new Date().toISOString() });
      upsertRecord(rec);
      stream.end();
      const subs = subscribers.get(runId);
      if (subs) { for (const res of subs) { res.write(`event: done\ndata: ${JSON.stringify(rec)}\n\n`); res.end(); } subscribers.delete(runId); }
    },
  };
  return run;
}

// ── Shell + agent helpers ───────────────────────────────────────────────────
// Run a shell command, teeing output to a run log. Resolves {code,stdout,stderr}.
function sh(command, { cwd = WORKSPACE, timeout = 120000, run = null, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], {
      cwd,
      env: { ...process.env, HOME: '/home/runner', PREVIEW_HOST, IMAGE, ...env },
      timeout,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; if (run) run.append(d); });
    child.stderr.on('data', d => { stderr += d; if (run) run.append(d); });
    child.on('close', code => resolve({ code, stdout: stdout.slice(-12000), stderr: stderr.slice(-6000) }));
    child.on('error', err => resolve({ code: -1, stdout, stderr: String(err) }));
  });
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return { agents: { copilot: true, claude: true }, defaultAgent: 'claude' }; }
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }

// Run a coding agent, teeing live output to the run log/SSE. `opts` carries the
// per-step controls from the Agent Studio pipeline: an appended system prompt
// (specialism), a tool allowlist, a temp MCP config path, and a model override.
function runAgent(agent, task, run, workDir = WORKSPACE, opts = {}) {
  const { appendSystemPrompt = '', allowedTools = [], mcpConfigPath = '', model = '' } = opts;
  return new Promise((resolve, reject) => {
    const timeout = 900000; // 15 min
    let cmd, args;
    if (agent === 'copilot') {
      cmd = '/home/runner/.local/bin/copilot';
      args = ['-p', task, '--autopilot', '--allow-all-tools'];
    } else if (agent === 'claude') {
      cmd = '/home/runner/.local/bin/claude';
      args = ['-p', task, '--output-format', 'text', '--dangerously-skip-permissions'];
      if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt);
      if (allowedTools.length) args.push('--allowedTools', ...allowedTools);
      if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath, '--strict-mcp-config');
      if (model) args.push('--model', model);
    } else {
      return reject(new Error(`Unknown agent: ${agent}`));
    }
    const child = spawn(cmd, args, {
      cwd: workDir,
      env: { ...process.env, HOME: '/home/runner', ECC_GATEGUARD: 'off' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; if (run) run.append(d); });
    child.stderr.on('data', d => { stderr += d; if (run) run.append(d); });
    child.on('close', code => resolve({ exitCode: code, stdout: stdout.slice(-12000), stderr: stderr.slice(-6000) }));
    child.on('error', reject);
  });
}

// Write a temp `--mcp-config` file for a step's enabled MCP servers; '' if none.
function writeStepMcpConfig(mcpServers) {
  if (!mcpServers || mcpServers.length === 0) return '';
  const cfg = pipelineStore.buildMcpConfig(mcpServers);
  if (Object.keys(cfg.mcpServers).length === 0) return '';
  const file = path.join(os.tmpdir(), `iw-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.json`);
  fs.writeFileSync(file, JSON.stringify(cfg));
  return file;
}

/**
 * Run the operator-defined pipeline (Agent Studio) in place of the legacy single
 * Claude call. Each enabled step is one agent run whose output is threaded into
 * the next via {{previousOutput}}. Per-step controls — specialism (appended system
 * prompt), tool allowlist, MCP servers, model — come straight from pipeline.json.
 * Returns the concatenated transcript so the caller can classify the change.
 */
async function runPipeline(ctx, run) {
  const { description, pagePath, type, feedbackId, note } = ctx;
  const noteText = note
    ? `\n\nNOTE: a previous attempt did NOT fix this. Reviewer feedback: ${note}\nTry a different approach.`
    : '';
  const pipeline = pipelineStore.loadPipeline();
  const steps = pipeline.steps.filter((s) => s.enabled);
  if (steps.length === 0) throw new Error('pipeline has no enabled steps');

  let previousOutput = '';
  const transcripts = [];
  for (const step of steps) {
    run.setPhase(`step:${step.name}`);
    const vars = {
      description: description || '(none)',
      pagePath: pagePath || '',
      type: type || '',
      feedbackId: feedbackId || '',
      note: noteText,
      previousOutput,
      allOutput: transcripts.join('\n\n'),
    };
    const prompt = pipelineStore.composeStepPrompt(step.promptTemplate, vars);
    const mcpConfigPath = writeStepMcpConfig(step.mcpServers);
    try {
      const result = await runAgent(step.agent, prompt, run, WORKSPACE, {
        appendSystemPrompt: specialists.getSpecialistPrompt(step.specialism),
        allowedTools: step.allowedTools,
        mcpConfigPath,
        model: step.model,
      });
      previousOutput = result.stdout || '';
      transcripts.push(`# ${step.name}\n${previousOutput}`);
      if (result.exitCode !== 0 && !step.continueOnError) {
        throw new Error(`step "${step.name}" exited ${result.exitCode}`);
      }
    } finally {
      if (mcpConfigPath) { try { fs.unlinkSync(mcpConfigPath); } catch { /* best effort */ } }
    }
  }
  return transcripts.join('\n\n');
}

// Resolve the node IP currently hosting buildkitd (it floats via anti-affinity).
// Fails loudly if the pod can't be located — better a clear build error than a
// silent dial to a stale/dead host.
function buildkitAddr() {
  let ip = '';
  try {
    ip = execSync(
      `kubectl -n build get pod -l app.kubernetes.io/name=buildkitd -o jsonpath='{.items[0].status.hostIP}'`,
      { encoding: 'utf8' }).trim();
  } catch (err) {
    throw new Error(`buildkitd host IP lookup failed (is the build namespace reachable?): ${err.message}`);
  }
  if (!ip) throw new Error('buildkitd pod has no hostIP yet (not scheduled/running in the build namespace)');
  return `tcp://${ip}:${BUILDKIT_NODEPORT}`;
}

// Build the console image in-cluster (BuildKit → Zot). Needs security.insecure
// (Talos seccomp) + OCI media types (Zot) + the tmpfs-/dev/shm Dockerfile.
async function buildImage(tag, run) {
  const addr = buildkitAddr();
  const cmd = [
    BUILDCTL, '--addr', addr, 'build',
    '--frontend', 'dockerfile.v0',
    '--local', 'context=.',
    '--local', 'dockerfile=.',
    '--opt', 'filename=Dockerfile',
    `--opt build-arg:APP_VERSION=${tag}`,
    `--opt build-arg:CACHEBUST=${Date.now()}`,
    '--allow', 'security.insecure',
    '--output', `type=image,name=${IMAGE}:${tag},push=true,oci-mediatypes=true`,
  ].join(' ');
  return sh(cmd, { cwd: CONSOLE_DIR, timeout: 900000, run });
}

// Shell snippet that forcibly returns the shared workspace to a pristine state.
// CRITICAL for reliability: every prior run shares this one git checkout, so a
// run that died mid-merge/revert/cherry-pick/rebase (or left conflict markers /
// a dirty index) would otherwise strand the workspace and make EVERY subsequent
// run fail at checkout with "you need to resolve your current index first"
// (feedback 30101627). Aborting any in-progress operation + hard reset + cleaning
// untracked files (but NOT gitignored node_modules/.next, so builds stay warm)
// makes each run self-healing regardless of how the previous one ended.
const RESET_WORKSPACE = `
  git config user.email "dispatch@infraweaver" && git config user.name "InfraWeaver Dispatch"
  git merge --abort 2>/dev/null || true
  git revert --abort 2>/dev/null || true
  git cherry-pick --abort 2>/dev/null || true
  git rebase --abort 2>/dev/null || true
  git reset --hard 2>/dev/null || true
  git clean -fd 2>/dev/null || true
`;

// Ensure the workspace is on FEEDBACK_BRANCH (created from origin/main if absent),
// preserving already-accumulated fixes. Self-heals any stranded state first.
async function checkoutStaging(run) {
  return sh(`
    set -e
    ${RESET_WORKSPACE}
    git fetch ${GIT_REMOTE} --prune
    if git show-ref --verify --quiet refs/remotes/${GIT_REMOTE}/${FEEDBACK_BRANCH}; then
      git checkout -B ${FEEDBACK_BRANCH} ${GIT_REMOTE}/${FEEDBACK_BRANCH}
    elif git show-ref --verify --quiet refs/heads/${FEEDBACK_BRANCH}; then
      git checkout ${FEEDBACK_BRANCH}
    else
      git checkout -B ${FEEDBACK_BRANCH} ${GIT_REMOTE}/main
    fi
  `, { run });
}

function classifyChange(output, workDir) {
  const m = (output || '').match(/CHANGE_CLASS:\s*(core|functionality|config|cluster-state)/i);
  if (m) return m[1].toLowerCase();
  try {
    const files = execSync('git diff --name-only HEAD', { cwd: workDir, encoding: 'utf8' }).split('\n').filter(Boolean);
    if (files.length && files.every(f => /(^|\/)(kubernetes|k8s|helm|charts|manifests|deploy|argocd)\//i.test(f) || /\.ya?ml$/i.test(f))) return 'config';
  } catch { /* ignore */ }
  return 'core';
}

function isAllowed(req) {
  const ip = req.socket.remoteAddress?.replace('::ffff:', '') || '';
  return ip.startsWith('10.') || ip === '127.0.0.1' || ip === '::1';
}
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
  });
}

// ── Pipeline serialization ──────────────────────────────────────────────────
// approve / redo / publish all mutate the SAME git workspace and the one shared
// `staging` env. Run them strictly one-at-a-time so concurrent approvals can't
// corrupt the accumulating feedback/staging checkout — guaranteeing each fix
// piles onto the previous tip. Quick read paths (validated verdict, /runs, SSE)
// stay outside the lock.
let pipelineLock = Promise.resolve();
function withLock(fn) {
  const result = pipelineLock.then(fn, fn);
  // Keep the shared tail alive whether the op resolves or rejects.
  pipelineLock = result.then(() => {}, () => {});
  return result;
}

// ── Pipeline operations ─────────────────────────────────────────────────────
// /approve: plan→validate→implement on staging, build, push, deploy shared env.
async function doApprove({ feedbackId, description, pagePath, type, note }) {
  const id = safeId(feedbackId);
  const run = newRun(id, note ? 'redo' : 'approve');
  try {
    run.setPhase('checkout');
    const co = await checkoutStaging(run);
    if (co.code !== 0) throw new Error('checkout failed');

    // Run the operator-defined Agent Studio pipeline (default: plan→validate→
    // implement). Each step streams its own PHASE marker to the live console.
    const transcript = await runPipeline({ description, pagePath, type, feedbackId: id, note }, run);
    const changeClass = classifyChange(transcript, WORKSPACE);

    run.setPhase('committing');
    // Unique tag so the shared staging env actually rolls to the new image, but
    // NOT per-issue: every approve repoints the ONE shared `staging` dev env at
    // the latest cumulative feedback/staging tip.
    const tag = `staging-${Date.now().toString(36)}`;
    const commitMsg = `fix(feedback): ${id}`;
    const commit = await sh(`
      set -e
      git add -A
      git commit -m ${JSON.stringify(commitMsg)} || echo "nothing to commit"
      git push ${GIT_REMOTE} ${FEEDBACK_BRANCH}
      git rev-parse HEAD
    `, { run });
    const sha = (commit.stdout.trim().split('\n').pop() || '').slice(0, 40);

    run.setPhase('building');
    const build = await buildImage(tag, run);
    if (build.code !== 0) throw new Error('image build failed');

    run.setPhase('deploying');
    // Always the fixed `staging` id → one shared dev env that accumulates every
    // approved fix, repointed to the freshly built cumulative image each time.
    const deploy = await sh(`PREVIEW_IMAGE=${IMAGE}:${tag} bash ${PREVIEW_SCRIPT} up staging`, { run, timeout: 300000 });
    if (deploy.code !== 0) throw new Error('staging deploy failed');

    const previewUrl = `https://${PREVIEW_HOST}`;
    run.finish('success', { previewUrl, tag, commit: sha, changeClass });
    return { ok: true, previewUrl, testPath: pagePath || '/', tag, commit: sha, runId: run.rec.runId, changeClass };
  } catch (err) {
    run.finish('failed', { error: String(err && err.message || err) });
    return { ok: false, error: String(err && err.message || err), runId: run.rec.runId };
  }
}

// /validate: validated → keep; not_fixed → revert this feedback's commit + redo.
async function doValidate({ feedbackId, action, note, description, pagePath, type }) {
  const id = safeId(feedbackId);
  if (action === 'validated') {
    const run = newRun(id, 'validate');
    run.setPhase('validated');
    run.finish('success', {});
    return { ok: true, action: 'validated', runId: run.rec.runId };
  }
  // not_fixed: revert the most recent commit for this feedback id, then re-run.
  // Serialized: it mutates the shared staging checkout (revert) and then runs a
  // fresh approve, so it must not overlap another approve/publish.
  return withLock(async () => {
  const run = newRun(id, 'revert');
  run.setPhase('reverting');
  // Conflict-proof revert: a later accumulated fix may have touched the same
  // files, so a plain `git revert` can hit a conflict. If it does, abort cleanly
  // and continue WITHOUT reverting (the redo's fresh fix supersedes it) rather
  // than leaving conflict markers that strand the shared workspace for every
  // future run. Either way we never push a half-resolved tree.
  const revert = await sh(`
    set -e
    ${RESET_WORKSPACE}
    git fetch ${GIT_REMOTE} --prune
    if git show-ref --verify --quiet refs/remotes/${GIT_REMOTE}/${FEEDBACK_BRANCH}; then
      git checkout -B ${FEEDBACK_BRANCH} ${GIT_REMOTE}/${FEEDBACK_BRANCH}
    elif git show-ref --verify --quiet refs/heads/${FEEDBACK_BRANCH}; then
      git checkout ${FEEDBACK_BRANCH}
    else
      git checkout -B ${FEEDBACK_BRANCH} ${GIT_REMOTE}/main
    fi
    SHA=$(git log --grep="fix(feedback): ${id}" -n1 --format=%H || true)
    if [ -n "$SHA" ]; then
      if git revert --no-edit "$SHA"; then
        git push ${GIT_REMOTE} ${FEEDBACK_BRANCH}
        echo "reverted $SHA"
      else
        git revert --abort 2>/dev/null || true
        echo "revert of $SHA conflicted — skipped; redo will supersede"
      fi
    else
      echo "no prior commit for ${id}"
    fi
  `, { run });
  run.finish(revert.code === 0 ? 'success' : 'failed', {});
  // Re-dispatch with the reviewer note (fresh run). Called directly (not via the
  // /approve route) so it does not re-enter the lock we already hold.
  const redo = await doApprove({ feedbackId: id, description, pagePath, type, note: note || '(no note)' });
  return { ok: redo.ok, action: 'not_fixed', reverted: revert.code === 0, redo };
  });
}

// /publish: merge staging → main, build+push release, bump infra image pin.
async function doPublish() {
  const run = newRun('publish', 'publish');
  try {
    run.setPhase('merging');
    // Fail-closed merge: if staging↔main conflict, ABORT and error out instead of
    // pushing a tree with conflict markers to main (the old `|| true` swallowed
    // conflicts and could publish a broken main). Self-heal the workspace first.
    const merge = await sh(`
      set -e
      ${RESET_WORKSPACE}
      git fetch ${GIT_REMOTE} --prune
      git checkout -B main ${GIT_REMOTE}/main
      if ! git merge --no-ff ${GIT_REMOTE}/${FEEDBACK_BRANCH} -m "publish: merge feedback/staging"; then
        git merge --abort 2>/dev/null || true
        echo "MERGE_CONFLICT"
        exit 1
      fi
      git push ${GIT_REMOTE} main
      git rev-parse --short HEAD
    `, { run });
    const sha = (merge.stdout.trim().split('\n').pop() || 'release').slice(0, 12);
    if (merge.code !== 0) throw new Error('merge to main failed (staging↔main conflict — resolve and retry)');

    run.setPhase('building');
    const relTag = sha;
    const b1 = await buildImage(relTag, run);
    if (b1.code !== 0) throw new Error('release build failed');
    // Also tag main-latest by re-pushing the same context (cheap; cache hits).
    await buildImage('main-latest', run);

    run.setPhase('releasing');
    const prodImage = `${IMAGE}:${relTag}`;
    const bump = await sh(`
      set -e
      cd ${INFRA_DIR}
      git fetch origin --prune || true
      git checkout -B main origin/main || git checkout main
      sed -i -E 's#(image:\\s*).*infraweaver-console:.*#\\1${prodImage}#' ${INFRA_DEPLOYMENT}
      git add ${INFRA_DEPLOYMENT}
      git commit -m "release: console ${relTag}" || echo "no pin change"
      git push origin main
    `, { run, cwd: INFRA_DIR });

    run.setPhase('teardown');
    await sh(`
      bash ${PREVIEW_SCRIPT} down staging || true
      git checkout main || true
      git push ${GIT_REMOTE} :${FEEDBACK_BRANCH} || true
    `, { run });

    run.finish(bump.code === 0 ? 'success' : 'failed', { tag: relTag });
    return { ok: bump.code === 0, releaseTag: relTag, prodImage };
  } catch (err) {
    run.finish('failed', { error: String(err && err.message || err) });
    return { ok: false, error: String(err && err.message || err), runId: run.rec.runId };
  }
}

// ── HTTP server ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (!isAllowed(req)) { res.writeHead(403); return res.end(JSON.stringify({ error: 'Forbidden' })); }
  const url = new URL(req.url, 'http://localhost');
  const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

  try {
    if (req.method === 'GET' && url.pathname === '/health') return json(200, { status: 'ok', branch: FEEDBACK_BRANCH, registry: REGISTRY });

    if (url.pathname === '/config') {
      if (req.method === 'GET') return json(200, loadConfig());
      if (req.method === 'PUT') { const b = await parseBody(req); const cfg = loadConfig(); if (b.agents) cfg.agents = b.agents; if (b.defaultAgent) cfg.defaultAgent = b.defaultAgent; saveConfig(cfg); return json(200, { ok: true, config: cfg }); }
    }

    // ── Agent Studio: editable pipeline, specialist library, and UI catalogs ──
    if (url.pathname === '/pipeline') {
      if (req.method === 'GET') return json(200, pipelineStore.loadPipeline());
      if (req.method === 'PUT') {
        const b = await parseBody(req);
        try { return json(200, { ok: true, pipeline: pipelineStore.savePipeline(b) }); }
        catch (e) { return json(400, { ok: false, error: String(e && e.message || e) }); }
      }
    }
    if (req.method === 'POST' && url.pathname === '/pipeline/reset') {
      return json(200, { ok: true, pipeline: pipelineStore.resetPipeline() });
    }
    if (req.method === 'GET' && url.pathname === '/specialists') {
      return json(200, specialists.loadSpecialists());
    }
    if (req.method === 'POST' && url.pathname === '/specialists/refresh') {
      const b = await parseBody(req).catch(() => ({}));
      const result = await specialists.refreshSpecialists(b.repo || undefined);
      return json(result.ok ? 200 : 502, result);
    }
    if (req.method === 'GET' && url.pathname === '/catalog') {
      return json(200, {
        agents: pipelineStore.AGENT_CATALOG,
        tools: pipelineStore.TOOL_CATALOG,
        models: pipelineStore.MODEL_CATALOG,
        mcp: pipelineStore.MCP_CATALOG,
      });
    }

    // Run history / audit.
    if (req.method === 'GET' && url.pathname === '/runs') {
      const fid = safeId(url.searchParams.get('feedbackId') || '');
      const all = readIndex();
      return json(200, { runs: fid ? all.filter(r => r.feedbackId === fid) : all });
    }
    const logMatch = url.pathname.match(/^\/runs\/([^/]+)\/log$/);
    if (req.method === 'GET' && logMatch) {
      const rec = readIndex().find(r => r.runId === logMatch[1]);
      if (!rec) return json(404, { error: 'run not found' });
      let log = '';
      try { log = fs.readFileSync(path.join(RUNS_DIR, rec.feedbackId, `${rec.runId}.log`), 'utf8'); } catch { /* none */ }
      return json(200, { run: rec, log });
    }
    const streamMatch = url.pathname.match(/^\/runs\/([^/]+)\/stream$/);
    if (req.method === 'GET' && streamMatch) {
      const runId = streamMatch[1];
      const rec = readIndex().find(r => r.runId === runId);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      // Replay existing log, then live-tail if still running.
      if (rec) { try { res.write(`data: ${JSON.stringify({ log: fs.readFileSync(path.join(RUNS_DIR, rec.feedbackId, `${rec.runId}.log`), 'utf8') })}\n\n`); } catch { /* none */ } }
      if (!rec || rec.status !== 'running') { res.write(`event: done\ndata: ${JSON.stringify(rec || {})}\n\n`); return res.end(); }
      if (!subscribers.has(runId)) subscribers.set(runId, new Set());
      subscribers.get(runId).add(res);
      req.on('close', () => { const s = subscribers.get(runId); if (s) s.delete(res); });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/approve') {
      const b = await parseBody(req);
      if (!b.feedbackId || !b.description) return json(400, { error: 'feedbackId and description required' });
      return json(200, await withLock(() => doApprove(b)));
    }
    if (req.method === 'POST' && url.pathname === '/validate') {
      const b = await parseBody(req);
      if (!b.feedbackId || !b.action) return json(400, { error: 'feedbackId and action required' });
      return json(200, await doValidate(b));
    }
    if (req.method === 'POST' && url.pathname === '/publish') {
      return json(200, await withLock(() => doPublish()));
    }

    return json(404, { error: 'Not found' });
  } catch (err) {
    return json(500, { error: String(err && err.message || err) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`InfraWeaver Dispatch (single-branch) on :${PORT} — branch=${FEEDBACK_BRANCH} registry=${REGISTRY}`);
});

/**
 * Sandbox for the /approve coding agent (C2, SECURITY-SCAN-2026-07-08).
 *
 * The dispatch process itself holds cluster + git-push + registry credentials so
 * it can build, pin, and roll out. The coding agent it spawns runs the Bash tool
 * on ATTACKER-INFLUENCED feedback text, so it must inherit NONE of those: a
 * prompt-injected `kubectl` / `git push` / `curl -H "Authorization: $TOKEN"` must
 * have nothing to authenticate with, and the in-cluster API host must be invisible.
 *
 * Two layers, both pure/deterministic so they are unit-tested independently of a
 * real spawn (agent-sandbox.test.js):
 *   1. sandboxedAgentEnv() — an ALLOWLIST env. Keeps only known-safe operational
 *      vars (+ the agent runtime's own model auth); drops everything else,
 *      including KUBECONFIG, DISPATCH_SECRET, the git push token, cloud/registry
 *      creds, and any *_SECRET/*_TOKEN/*_PASSWORD/*_KEY var. Also forces
 *      KUBECONFIG=/dev/null (so kubectl can't fall back to ~/.kube/config) and
 *      neutralizes the git/gh credential helper.
 *   2. buildAgentLaunch() — optionally wraps the spawn in a network-isolation
 *      launcher (AGENT_SANDBOX_CMD, e.g. `firejail --net=none --`) so the agent's
 *      Bash cannot reach the cluster/internal network at all.
 *
 * SCOPE / LIMITS (important — do not overclaim): this layer removes ENV-based and
 * git/gh credentials only. It does NOT provide OS process isolation. The agent
 * still runs as the same Unix user as dispatch (`runner`), which on the stock
 * runner has passwordless sudo, docker-group access, and on-disk creds (kube
 * configs, SSH keys, ~/.docker/config.json) reachable through the deliberately
 * preserved HOME (claude reads ~/.claude.json). A prompt-injected `sudo`, `docker`,
 * or `cat ~/.kube/…` therefore still escalates. Closing that requires REAL
 * isolation — run the agent as a dedicated low-privilege UID (no sudo, not in the
 * docker group) with a synthetic HOME and no cluster/SSH files, and/or set
 * AGENT_SANDBOX_CMD to a jail (firejail/bubblewrap/user-namespace) that also drops
 * privilege. Tracked as follow-up hardening; the diff-review gate (diff-review.js)
 * is the compensating control on the prod-ship path until then.
 */

// Exact names that are always safe to pass through (non-secret, operational).
const SAFE_ALLOW = new Set([
  'PATH', 'HOME', 'HOSTNAME', 'USER', 'LOGNAME', 'PWD', 'SHELL', 'SHLVL',
  'LANG', 'LANGUAGE', 'TERM', 'TZ', 'TMPDIR', 'TMP', 'TEMP',
  'COLUMNS', 'LINES', 'EDITOR', 'PAGER', 'NODE_ENV', 'ECC_GATEGUARD',
  // proxy + TLS trust: the agent runtime needs these to reach the model API
  // through a corporate proxy / custom CA. They carry no credentials.
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'GIT_SSL_CAINFO',
]);

// Prefixes that are always safe (locale + XDG base dirs).
const SAFE_PREFIXES = ['LC_', 'XDG_'];

// The agent runtime's OWN model auth. These look like secrets but are required
// for `claude`/`copilot` to run at all (the CLI also falls back to file auth in
// ~/.claude.json, so this is belt-and-suspenders). Kept even though they match
// the secret pattern below. Env-overridable via AGENT_RUNTIME_ALLOW.
const RUNTIME_ALLOW_DEFAULT = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN',
];

// Anything whose name matches this is a credential and is dropped unless it is in
// the runtime-auth allowlist above.
const SECRET_NAME_RE = /(SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|APIKEY|API_KEY|CREDENTIAL|PRIVATE|_KEY$|AUTH$)/i;

function isSafeName(name) {
  if (SAFE_ALLOW.has(name)) return true;
  return SAFE_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Build the scrubbed environment for the coding agent from `base` (defaults to
 * process.env). Allowlist semantics: a var is kept only if it is in the runtime
 * auth allowlist, or it is a known-safe operational var AND not a credential.
 * Returns a NEW object; never mutates `base`.
 */
function sandboxedAgentEnv(base = process.env, { extraAllow = [] } = {}) {
  const runtimeAllow = new Set([
    ...RUNTIME_ALLOW_DEFAULT,
    ...(process.env.AGENT_RUNTIME_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean),
  ]);
  const extra = new Set([
    ...extraAllow,
    ...(process.env.AGENT_ENV_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean),
  ]);

  const out = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (runtimeAllow.has(name)) { out[name] = value; continue; }
    const safe = isSafeName(name) || extra.has(name);
    if (safe && !SECRET_NAME_RE.test(name)) out[name] = value;
  }
  // Neutralize git/gh push capability for the agent (C2). Env scrub alone is not
  // enough: HOME is kept (claude reads ~/.claude.json for model auth), and the
  // runner's git credential helper is `!gh auth git-credential`, so a kept HOME
  // would still let a prompt-injected `git push` / `gh` authenticate against prod
  // repos via gh's stored token. Ignore global+system git config (drops the
  // credential helper), disable interactive/askpass prompts, and point gh at an
  // empty config dir so it finds no host auth. The ORCHESTRATOR does all real git
  // ops with the full env (via sh()), so it is unaffected; only this child loses
  // push. Local read ops (git diff/status/log) still work.
  out.GIT_CONFIG_GLOBAL = '/dev/null';
  out.GIT_CONFIG_NOSYSTEM = '1';
  out.GIT_TERMINAL_PROMPT = '0';
  out.GIT_ASKPASS = '/bin/false';
  out.GH_CONFIG_DIR = '/nonexistent-iw-agent-sandbox';
  // (GH_TOKEN/GITHUB_TOKEN are already dropped by the credential scrub above, so
  // gh finds no token in env and no host auth in the empty config dir.)
  // Force an empty kubeconfig so kubectl cannot fall back to the default
  // ~/.kube/config path (KUBECONFIG env is scrubbed above, but kubectl's default
  // path lookup would otherwise still find an on-disk prod config via HOME).
  out.KUBECONFIG = '/dev/null';
  // Marker so downstream (and the agent's own env dump) can see it is sandboxed.
  out.IW_AGENT_SANDBOX = '1';
  return out;
}

/**
 * Optionally wrap `{cmd, args}` in a network-isolation launcher. `sandboxCmd` is a
 * whitespace-delimited prefix that ends expecting the real command, e.g.
 * `firejail --net=none --` or `unshare -rn --`. Empty → pass through unchanged.
 * Pure: returns a new `{cmd, args}`.
 */
function buildAgentLaunch({ cmd, args = [], sandboxCmd = '' }) {
  const prefix = String(sandboxCmd || '').trim().split(/\s+/).filter(Boolean);
  if (prefix.length === 0) return { cmd, args: [...args] };
  return { cmd: prefix[0], args: [...prefix.slice(1), cmd, ...args] };
}

module.exports = {
  sandboxedAgentEnv,
  buildAgentLaunch,
  SAFE_ALLOW,
  SECRET_NAME_RE,
  RUNTIME_ALLOW_DEFAULT,
};

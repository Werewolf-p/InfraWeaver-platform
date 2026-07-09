/**
 * Tests for the /approve coding-agent sandbox (C2, SECURITY-SCAN-2026-07-08).
 * Zero deps — run with:  node --test
 *
 * The coding agent runs the Bash tool on attacker-influenced feedback text. It
 * must NOT inherit the dispatch process's cluster/registry/git credentials
 * (KUBECONFIG, DISPATCH_SECRET, git push token, cloud creds, OpenBao token, …),
 * so a prompt-injected `kubectl`/`curl`/`git push` has nothing to authenticate
 * with. sandboxedAgentEnv() is an ALLOWLIST: it keeps only known-safe operational
 * vars (plus the agent runtime's own model auth) and drops everything else.
 * buildAgentLaunch() optionally wraps the spawn in a network-isolation launcher.
 */
const test = require('node:test');
const assert = require('node:assert');

const { sandboxedAgentEnv, buildAgentLaunch, buildJailLaunch } = require('./agent-sandbox');

const BASE = {
  // must be dropped — cluster / infra / secrets
  KUBECONFIG: '/home/runner/.kube/config-prod',
  KUBERNETES_SERVICE_HOST: '10.96.0.1',
  KUBERNETES_SERVICE_PORT: '443',
  TALOSCONFIG: '/home/runner/.talos/config',
  DISPATCH_SECRET: 'deadbeef',
  PUBLIC_GIT_TOKEN: 'ghp_xxx',
  GITHUB_TOKEN: 'ghp_yyy',
  AWS_SECRET_ACCESS_KEY: 'aws',
  OPENBAO_TOKEN: 'bao',
  VAULT_TOKEN: 'v',
  CF_API_TOKEN: 'cf',
  SOME_PASSWORD: 'p',
  DOCKER_HOST: 'tcp://x',
  PUBLIC_REPO: 'https://x',
  NODE_AUTH_TOKEN: 'npm',
  // must be kept — safe operational
  PATH: '/usr/bin',
  HOME: '/home/runner',
  LANG: 'C.UTF-8',
  TERM: 'xterm',
  TZ: 'UTC',
  NODE_ENV: 'production',
  HTTPS_PROXY: 'http://proxy:3128',
  NODE_EXTRA_CA_CERTS: '/etc/ssl/ca.pem',
  LC_ALL: 'C.UTF-8',
  // kept — agent runtime model auth (needed so claude can run)
  ANTHROPIC_API_KEY: 'sk-ant-xxx',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
};

test('neutralizes cluster credentials (KUBECONFIG forced empty, KUBERNETES_*/TALOSCONFIG dropped)', () => {
  const env = sandboxedAgentEnv(BASE);
  // KUBECONFIG is forced to /dev/null so kubectl cannot use the inherited value
  // NOR fall back to ~/.kube/config on disk.
  assert.strictEqual(env.KUBECONFIG, '/dev/null');
  assert.strictEqual(env.KUBERNETES_SERVICE_HOST, undefined);
  assert.strictEqual(env.KUBERNETES_SERVICE_PORT, undefined);
  assert.strictEqual(env.TALOSCONFIG, undefined);
});

test('drops the dispatch control secret and all git/registry/cloud tokens', () => {
  const env = sandboxedAgentEnv(BASE);
  for (const k of ['DISPATCH_SECRET', 'PUBLIC_GIT_TOKEN', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'OPENBAO_TOKEN', 'VAULT_TOKEN', 'CF_API_TOKEN', 'DOCKER_HOST', 'NODE_AUTH_TOKEN']) {
    assert.strictEqual(env[k], undefined, `${k} must be scrubbed`);
  }
});

test('drops any *_PASSWORD / *_TOKEN / *_SECRET / *_KEY var by pattern', () => {
  const env = sandboxedAgentEnv({ ...BASE, WHATEVER_SECRET: 'x', FOO_APIKEY: 'y', BAR_PRIVATE_KEY: 'z' });
  assert.strictEqual(env.SOME_PASSWORD, undefined);
  assert.strictEqual(env.WHATEVER_SECRET, undefined);
  assert.strictEqual(env.FOO_APIKEY, undefined);
  assert.strictEqual(env.BAR_PRIVATE_KEY, undefined);
});

test('keeps safe operational vars needed to run', () => {
  const env = sandboxedAgentEnv(BASE);
  assert.strictEqual(env.PATH, '/usr/bin');
  assert.strictEqual(env.HOME, '/home/runner');
  assert.strictEqual(env.LANG, 'C.UTF-8');
  assert.strictEqual(env.TERM, 'xterm');
  assert.strictEqual(env.NODE_ENV, 'production');
  assert.strictEqual(env.HTTPS_PROXY, 'http://proxy:3128');
  assert.strictEqual(env.NODE_EXTRA_CA_CERTS, '/etc/ssl/ca.pem');
  assert.strictEqual(env.LC_ALL, 'C.UTF-8');
});

test('keeps the agent runtime model auth so claude can authenticate', () => {
  const env = sandboxedAgentEnv(BASE);
  assert.strictEqual(env.ANTHROPIC_API_KEY, 'sk-ant-xxx');
  assert.strictEqual(env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth');
});

test('drops unknown vars by default (allowlist, not denylist)', () => {
  const env = sandboxedAgentEnv({ ...BASE, RANDOM_INTERNAL_URL: 'http://svc.cluster.local' });
  assert.strictEqual(env.RANDOM_INTERNAL_URL, undefined);
});

test('extraAllow lets ops keep a specific extra var without code change', () => {
  const env = sandboxedAgentEnv({ ...BASE, RANDOM_INTERNAL_URL: 'x' }, { extraAllow: ['RANDOM_INTERNAL_URL'] });
  assert.strictEqual(env.RANDOM_INTERNAL_URL, 'x');
});

test('neutralizes git + gh push capability (file-based creds via kept HOME)', () => {
  const env = sandboxedAgentEnv(BASE);
  assert.strictEqual(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.strictEqual(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.strictEqual(env.GIT_TERMINAL_PROMPT, '0');
  assert.strictEqual(env.GIT_ASKPASS, '/bin/false');
  assert.strictEqual(env.GH_CONFIG_DIR, '/nonexistent-iw-agent-sandbox');
  // GH_TOKEN/GITHUB_TOKEN are dropped entirely by the credential scrub.
  assert.strictEqual(env.GH_TOKEN, undefined);
  assert.strictEqual(env.GITHUB_TOKEN, undefined);
});

test('marks the env as sandboxed', () => {
  assert.strictEqual(sandboxedAgentEnv(BASE).IW_AGENT_SANDBOX, '1');
});

test('does not mutate the input env object', () => {
  const input = { ...BASE };
  sandboxedAgentEnv(input);
  assert.strictEqual(input.KUBECONFIG, '/home/runner/.kube/config-prod');
});

test('buildAgentLaunch passes through unchanged when no sandbox command configured', () => {
  const out = buildAgentLaunch({ cmd: 'claude', args: ['-p', 'task'], sandboxCmd: '' });
  assert.deepStrictEqual(out, { cmd: 'claude', args: ['-p', 'task'] });
});

test('buildAgentLaunch wraps the spawn in the configured network jail', () => {
  const out = buildAgentLaunch({ cmd: 'claude', args: ['-p', 'task'], sandboxCmd: 'firejail --net=none --' });
  assert.strictEqual(out.cmd, 'firejail');
  assert.deepStrictEqual(out.args, ['--net=none', '--', 'claude', '-p', 'task']);
});

test('buildAgentLaunch tolerates extra whitespace in the sandbox command', () => {
  const out = buildAgentLaunch({ cmd: 'claude', args: [], sandboxCmd: '  unshare  -rn  --  ' });
  assert.strictEqual(out.cmd, 'unshare');
  assert.deepStrictEqual(out.args, ['-rn', '--', 'claude']);
});

// ── buildJailLaunch (CRITICAL-1) ────────────────────────────────────────────
// The env-scrub above removes credentials but the agent still ran as `runner`
// (passwordless sudo, docker group, on-disk kube/ssh creds via HOME). The jail
// wrapper runs the agent as a dedicated low-priv UID inside a mount namespace via
// a root helper (iw-agent-jail), invoked through the operator's existing sudo.

test('buildJailLaunch passes through unchanged when no jail script configured', () => {
  const out = buildJailLaunch({ cmd: 'claude', args: ['-p', 'task'], workDir: '/repo', jailScript: '' });
  assert.deepStrictEqual(out, { cmd: 'claude', args: ['-p', 'task'] });
});

test('buildJailLaunch wraps the spawn in sudo + the jail helper with the workdir', () => {
  const out = buildJailLaunch({
    cmd: '/home/runner/.local/bin/claude',
    args: ['-p', 'task', '--output-format', 'text'],
    workDir: '/home/runner/InfraWeaver-platform',
    jailScript: '/usr/local/sbin/iw-agent-jail',
  });
  assert.strictEqual(out.cmd, 'sudo');
  assert.deepStrictEqual(out.args, [
    '-n', '/usr/local/sbin/iw-agent-jail',
    '--workdir', '/home/runner/InfraWeaver-platform',
    '--',
    '/home/runner/.local/bin/claude', '-p', 'task', '--output-format', 'text',
  ]);
});

test('buildJailLaunch omits --workdir when none is given', () => {
  const out = buildJailLaunch({ cmd: 'claude', args: ['-p', 'x'], jailScript: '/usr/local/sbin/iw-agent-jail' });
  assert.deepStrictEqual(out.args, ['-n', '/usr/local/sbin/iw-agent-jail', '--', 'claude', '-p', 'x']);
});

test('buildJailLaunch does not mutate the input args', () => {
  const args = ['-p', 'task'];
  buildJailLaunch({ cmd: 'claude', args, workDir: '/repo', jailScript: '/usr/local/sbin/iw-agent-jail' });
  assert.deepStrictEqual(args, ['-p', 'task']);
});

test('jail composes inside an optional outer network jail (buildAgentLaunch of buildJailLaunch)', () => {
  const jailed = buildJailLaunch({ cmd: 'claude', args: ['-p', 'x'], workDir: '/repo', jailScript: '/usr/local/sbin/iw-agent-jail' });
  const out = buildAgentLaunch({ cmd: jailed.cmd, args: jailed.args, sandboxCmd: 'firejail --net=none --' });
  assert.strictEqual(out.cmd, 'firejail');
  assert.deepStrictEqual(out.args, [
    '--net=none', '--',
    'sudo', '-n', '/usr/local/sbin/iw-agent-jail', '--workdir', '/repo', '--', 'claude', '-p', 'x',
  ]);
});

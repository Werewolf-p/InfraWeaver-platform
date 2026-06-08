/**
 * Pipeline definition store for the InfraWeaver feedback auto-fix flow.
 *
 * The pipeline is the ordered list of agent "steps" the dispatch service runs on
 * /approve, in place of the old single hardcoded Claude call. It is fully editable
 * from the console's Agent Studio modal (n8n-style) and persisted here as
 * `pipeline.json`. When that file is absent we fall back to DEFAULT_PIPELINE: a
 * cost-routed plan → validate → security → implement → verify flow — read-only
 * triage/review on Haiku, the implementing step on Opus, then a self-correcting
 * Verify gate — so out of the box the flow is cheap to triage and strong where it
 * actually edits code.
 *
 * Pure data + validation + prompt composition only: no process spawning lives here
 * (the executor in server.js owns that), which keeps this module trivially testable.
 */
const fs = require('fs');
const path = require('path');

const PIPELINE_FILE = path.join(__dirname, 'pipeline.json');

// Tools the operator may put on a step's allowlist (Claude Code built-ins).
const TOOL_CATALOG = ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch', 'TodoWrite'];

// Models selectable per step ('' = the agent default).
const MODEL_CATALOG = ['', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];

const AGENT_CATALOG = ['claude', 'copilot'];

// MCP server presets a step can enable. Each maps to a stdio launch config that is
// written to a temp `--mcp-config` file at run time. Public, npx-launched servers.
const MCP_PRESETS = {
  context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
  github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
  playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
  'sequential-thinking': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
  fetch: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-fetch'] },
};
const MCP_CATALOG = Object.keys(MCP_PRESETS);

// The default pipeline: plan → validate → security → implement → verify.
//
// Model routing (cost/quality): the three read-only thinking steps run on Haiku
// (≈cheapest, plenty for triage/review); the implementing step runs on Opus (the
// only step that writes code, where quality pays for itself); Verify runs on Sonnet
// (mechanical typecheck/test + small self-correction — strong but cheaper than Opus).
// Net effect vs an all-default run: most tokens are spent on Haiku, Opus is paid for
// once, and a fix is typechecked before the expensive in-cluster image build.
//
// Specialisms steer each step's expertise; tool allowlists keep the read-only steps
// truly read-only (Read/Grep/Glob) and give only the two editing steps write/Bash.
// MCP is enabled only where it earns its startup cost: context7 on plan+implement
// (the console's AGENTS.md warns this Next.js has breaking changes vs training data,
// so current docs matter) and sequential-thinking on plan (harder triage). The
// implement step keeps the CHANGE_CLASS marker server.js classifies on; Verify must
// not emit one. Playwright is deliberately omitted from Verify: the build+deploy
// happen AFTER the pipeline (in doApprove), so there is no new page to exercise yet
// and a per-step dev server would be slow and flaky.
const DEFAULT_PIPELINE = {
  version: 1,
  steps: [
    {
      id: 'plan',
      name: 'Plan',
      enabled: true,
      agent: 'claude',
      model: 'claude-haiku-4-5-20251001',
      specialism: 'architect',
      promptTemplate: [
        'You are triaging an approved in-console developer-feedback item for the',
        'InfraWeaver console (a Next.js + TypeScript + React app). This is a READ-ONLY',
        'planning step: do NOT create, edit, or delete any files.',
        '',
        'Read only what you need to locate the cause, then produce a tight plan:',
        '1. Restate the issue in one or two sentences.',
        '2. Name the SMALLEST correct change and the EXACT file paths to touch.',
        '3. Flag any repo rules that apply — the console ships AGENTS.md / CLAUDE.md and',
        '   this Next.js version has breaking changes vs your training data, so note where',
        '   up-to-date Next.js docs must be checked. No code yet.',
        '',
        'Reported issue (type: {{type}}, page: {{pagePath}}):',
        '{{description}}{{note}}',
      ].join('\n'),
      allowedTools: ['Read', 'Grep', 'Glob'],
      mcpServers: ['context7', 'sequential-thinking'],
      continueOnError: false,
    },
    {
      id: 'validate',
      name: 'Validate plan',
      enabled: true,
      agent: 'claude',
      model: 'claude-haiku-4-5-20251001',
      specialism: 'code-reviewer',
      promptTemplate: [
        'Sanity-check the plan below against the reported issue. READ-ONLY: do NOT change',
        'any files.',
        '',
        "Confirm the plan actually fixes the report and won't break adjacent behaviour. If",
        "it's wrong, incomplete, or risky, rewrite it into a corrected FINAL plan;",
        'otherwise restate it as the final plan. Keep the exact file list explicit.',
        '',
        'Reported issue (type: {{type}}, page: {{pagePath}}):',
        '{{description}}{{note}}',
        '',
        'Proposed plan:',
        '{{previousOutput}}',
      ].join('\n'),
      allowedTools: ['Read', 'Grep', 'Glob'],
      mcpServers: [],
      continueOnError: true,
    },
    {
      id: 'security',
      name: 'Security gate',
      enabled: true,
      agent: 'claude',
      model: 'claude-haiku-4-5-20251001',
      specialism: 'security-reviewer',
      promptTemplate: [
        'You are screening the planned change below for security impact. READ-ONLY: do',
        'NOT change any files.',
        '',
        'Decide whether the change touches a security-sensitive surface: authentication,',
        'authorization/RBAC, sessions/cookies, user-input handling or validation, API route',
        'handlers, secrets/credentials, or data access.',
        '- If it does NOT, reply with exactly: NO_SECURITY_CONCERNS',
        '- If it DOES, list the specific, must-follow constraints for the implementer',
        '  (fail closed, never weaken an existing gate, validate all input, no secrets in',
        '  code). Be concrete and brief.',
        '',
        'Reported issue (type: {{type}}, page: {{pagePath}}):',
        '{{description}}{{note}}',
        '',
        'Planned change:',
        '{{previousOutput}}',
      ].join('\n'),
      allowedTools: ['Read', 'Grep', 'Glob'],
      mcpServers: [],
      continueOnError: true,
    },
    {
      id: 'implement',
      name: 'Implement',
      enabled: true,
      agent: 'claude',
      model: 'claude-opus-4-8',
      specialism: 'react-reviewer',
      promptTemplate: [
        'Implement the validated plan for the InfraWeaver console (Next.js + TypeScript +',
        'React). Apply the change now.',
        '',
        'Constraints:',
        '- Make the SMALLEST correct change; match the surrounding code style; prefer',
        '  immutable updates (never mutate in place).',
        '- Obey apps/infraweaver-console/AGENTS.md / CLAUDE.md. This Next.js version has',
        '  breaking changes vs your training data — consult current Next.js docs (context7,',
        '  or node_modules/next/dist/docs) before writing Next-specific code.',
        '- Honour every security constraint in the review below; if it says',
        '  NO_SECURITY_CONCERNS, proceed.',
        '- Add or adjust tests where practical, and self-check (typecheck where cheap).',
        '',
        'Reported issue (type: {{type}}, page: {{pagePath}}):',
        '{{description}}{{note}}',
        '',
        'Full context (plan → validation → security review):',
        '{{allOutput}}',
        '',
        'On the FINAL line print exactly: CHANGE_CLASS: <core|functionality|config|cluster-state>',
      ].join('\n'),
      allowedTools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'],
      mcpServers: ['context7'],
      continueOnError: false,
    },
    {
      id: 'verify',
      name: 'Verify',
      enabled: true,
      agent: 'claude',
      model: 'claude-sonnet-4-6',
      specialism: '',
      promptTemplate: [
        'Verify the change just made to the InfraWeaver console and self-correct small',
        'breakages it introduced. Work inside apps/infraweaver-console.',
        '',
        '1. Run the cheapest meaningful checks: `cd apps/infraweaver-console && npx tsc',
        '   --noEmit`, plus the lint/tests touching the diff (e.g. `npm test -- <related>`).',
        '   Do NOT run a full `next build` — the in-cluster build runs after this pipeline.',
        '2. If a check fails because of THIS change, make the minimal fix and re-run. Do not',
        '   refactor unrelated code and do not revert the intended fix.',
        '3. If something is genuinely red and you cannot fix it cheaply, stop and report',
        '   exactly what failed.',
        '',
        'Do NOT print a CHANGE_CLASS line — the implement step already set it.',
        '',
        'Implementation report:',
        '{{previousOutput}}',
      ].join('\n'),
      allowedTools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'],
      mcpServers: [],
      continueOnError: true,
    },
  ],
};

function clampStr(value, max) {
  return String(value == null ? '' : value).slice(0, max);
}

function safeStepId(value, fallback) {
  const cleaned = String(value || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 40);
  return cleaned || fallback;
}

/**
 * Validate + normalise a raw pipeline payload from the console into a safe,
 * well-typed shape. Throws on structurally invalid input; silently drops unknown
 * tool/agent/mcp/model values so a stale UI can never inject arbitrary CLI args.
 */
function validatePipeline(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.steps)) {
    throw new Error('pipeline must be an object with a steps array');
  }
  if (raw.steps.length === 0) throw new Error('pipeline must have at least one step');
  if (raw.steps.length > 12) throw new Error('pipeline may have at most 12 steps');

  const steps = raw.steps.map((s, i) => {
    if (!s || typeof s !== 'object') throw new Error(`step ${i} is not an object`);
    const agent = AGENT_CATALOG.includes(s.agent) ? s.agent : 'claude';
    const model = MODEL_CATALOG.includes(s.model) ? s.model : '';
    const allowedTools = Array.isArray(s.allowedTools)
      ? s.allowedTools.filter((t) => TOOL_CATALOG.includes(t))
      : [];
    const mcpServers = Array.isArray(s.mcpServers)
      ? s.mcpServers.filter((m) => MCP_CATALOG.includes(m))
      : [];
    const promptTemplate = clampStr(s.promptTemplate, 8000);
    if (!promptTemplate.trim()) throw new Error(`step ${i} ("${s.name || s.id}") has an empty prompt`);
    return {
      id: safeStepId(s.id, `step-${i + 1}`),
      name: clampStr(s.name, 60) || `Step ${i + 1}`,
      enabled: s.enabled !== false,
      agent,
      model,
      specialism: clampStr(s.specialism, 80),
      promptTemplate,
      allowedTools,
      mcpServers,
      continueOnError: Boolean(s.continueOnError),
    };
  });

  return { version: 1, steps };
}

function loadPipeline() {
  try {
    return validatePipeline(JSON.parse(fs.readFileSync(PIPELINE_FILE, 'utf8')));
  } catch {
    return DEFAULT_PIPELINE;
  }
}

function savePipeline(raw) {
  const valid = validatePipeline(raw);
  fs.writeFileSync(PIPELINE_FILE, JSON.stringify(valid, null, 2));
  return valid;
}

function resetPipeline() {
  try { fs.unlinkSync(PIPELINE_FILE); } catch { /* already absent */ }
  return DEFAULT_PIPELINE;
}

/** Resolve {{placeholders}} in a step prompt against the run's variable bag. */
function composeStepPrompt(template, vars) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? '') : '');
}

/** Build a `--mcp-config` payload object for the given preset ids. */
function buildMcpConfig(serverIds) {
  const mcpServers = {};
  for (const id of serverIds || []) {
    if (MCP_PRESETS[id]) mcpServers[id] = MCP_PRESETS[id];
  }
  return { mcpServers };
}

module.exports = {
  PIPELINE_FILE,
  DEFAULT_PIPELINE,
  TOOL_CATALOG,
  MODEL_CATALOG,
  AGENT_CATALOG,
  MCP_PRESETS,
  MCP_CATALOG,
  validatePipeline,
  loadPipeline,
  savePipeline,
  resetPipeline,
  composeStepPrompt,
  buildMcpConfig,
};

/**
 * Pipeline definition store for the InfraWeaver feedback auto-fix flow.
 *
 * The pipeline is the ordered list of agent "steps" the dispatch service runs on
 * /approve, in place of the old single hardcoded Claude call. It is fully editable
 * from the console's Agent Studio modal (n8n-style) and persisted here as
 * `pipeline.json`. When that file is absent we fall back to DEFAULT_PIPELINE, whose
 * content reproduces the legacy plan→validate→implement guidance split into three
 * cards — so out of the box behaviour is equivalent, just granularised.
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

// The default pipeline: legacy plan→validate→implement, one agent run per phase.
// Plan/validate are read-only (cheap); implement does the work and emits the
// CHANGE_CLASS marker server.js classifies on.
const DEFAULT_PIPELINE = {
  version: 1,
  steps: [
    {
      id: 'plan',
      name: 'Plan',
      enabled: true,
      agent: 'claude',
      model: '',
      specialism: 'architect',
      promptTemplate: [
        'You are triaging approved in-console developer feedback for the InfraWeaver',
        'console (a Next.js app). Do NOT change any files in this step.',
        '',
        'Restate the issue in your own words, then outline the SMALLEST correct change',
        'and the EXACT files you would touch. Keep it tight and concrete.',
        '',
        'Reported issue (type: {{type}}, page: {{pagePath}}):',
        '{{description}}{{note}}',
      ].join('\n'),
      allowedTools: ['Read', 'Grep', 'Glob'],
      mcpServers: [],
      continueOnError: false,
    },
    {
      id: 'validate',
      name: 'Validate plan',
      enabled: true,
      agent: 'claude',
      model: '',
      specialism: 'code-reviewer',
      promptTemplate: [
        'Sanity-check the plan below against the reported issue. Confirm it actually',
        "addresses the report and won't break adjacent behaviour. If it's wrong or risky,",
        'rewrite it into a corrected, final plan. Do NOT change any files in this step.',
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
      id: 'implement',
      name: 'Implement',
      enabled: true,
      agent: 'claude',
      model: '',
      specialism: '',
      promptTemplate: [
        'Implement the validated plan below for the InfraWeaver console. Apply the change,',
        'keep it minimal and immutable-style, and self-verify (typecheck/build where cheap).',
        'Match the existing code style and repo rules (see AGENTS.md / CLAUDE.md).',
        '',
        'Reported issue (type: {{type}}, page: {{pagePath}}):',
        '{{description}}{{note}}',
        '',
        'Validated plan to implement:',
        '{{previousOutput}}',
        '',
        'On the FINAL line print exactly: CHANGE_CLASS: <core|functionality|config|cluster-state>',
      ].join('\n'),
      allowedTools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'],
      mcpServers: [],
      continueOnError: false,
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

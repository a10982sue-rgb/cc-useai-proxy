#!/usr/bin/env node
/*
 * cc-useai-proxy  v2.0.0
 * ----------------------
 * Translates Anthropic Messages API (what Claude Code speaks) <-> the
 * OpenAI-compatible /v1/chat/completions endpoint exposed by upstream
 * providers (api.iamhc.cn / api.hcnsec.cn).
 *
 * Point Claude Code at this proxy:
 *   set ANTHROPIC_BASE_URL=http://localhost:8787
 *   set ANTHROPIC_API_KEY=unused
 *   claude
 *
 * Zero npm dependencies. Run with:  node proxy.js
 *
 * Features (v2):
 *   - GLM 5.2 model routing
 *   - Claude Opus 4.8 / Sonnet 4.6 / Haiku routing
 *   - Terminal-mode diagnostics & grading (/grade, /status, /terminal)
 *   - Color-coded request logging
 *   - Health check endpoint for Render
 *   - Anthropic <-> OpenAI full message translation
 *   - Native + prompt-emulated tool calling
 *   - Streaming SSE passthrough
 */

'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

// ─── .env loader (local dev only, zero deps) ───
// Reads KEY=VALUE lines from .env next to this script. Existing process.env
// values win, so platform-injected env (Render dashboard) always takes
// precedence. .env is gitignored — keep secrets there, never in source.
(function loadEnv() {
  try {
    const fs = require('fs');
    const path = require('path');
    const p = path.join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch (e) { /* ignore */ }
})();


// ═══════════════════════════════════════════════════════════════════
//  CONFIG (env-overridable)
// ═══════════════════════════════════════════════════════════════════
const PORT       = parseInt(process.env.PORT || '8787', 10);
const HOST       = process.env.HOST || '0.0.0.0';

// Upstream endpoints — primary and fallback (mutable via /admin)
let UPSTREAM_PRIMARY  = process.env.USEAI_BASE_URL || 'https://api.iamhc.cn';
let UPSTREAM_FALLBACK = process.env.USEAI_FALLBACK_URL || 'https://api.hcnsec.cn';
const UPSTREAM_PATH     = '/v1/chat/completions';
// Upstream API key — set via USEAI_API_KEY env (Render dashboard) or the
// /admin panel. Never baked into source; banner warns if unset.
let API_KEY           = process.env.USEAI_API_KEY || '';

// Model mapping — all route to glm-5.2 (mutable via /admin)
let DEFAULT_MODEL = process.env.USEAI_MODEL      || 'glm-5.2';
let BIG_MODEL     = process.env.USEAI_BIG_MODEL   || 'glm-5.2';
let SMALL_MODEL   = process.env.USEAI_SMALL_MODEL  || 'glm-5.2';
let GLM_MODEL     = process.env.USEAI_GLM_MODEL   || 'glm-5.2';

// Inbound auth gate (mutable via /admin). When set, clients must send it as
// `x-api-key` or `Authorization: Bearer <key>`. The web UI sends `broskillable`.
// Empty = fully public. The real upstream key stays server-side regardless.
let PROXY_KEY = process.env.PROXY_KEY || process.env.AUTH_KEY || '';

// Admin panel password — gates GET/POST /admin/api/*. Lives ONLY here
// (server-side); it is NEVER shipped to any HTML page, so viewing page source
// reveals nothing. Override via ADMIN_KEY env for real secrecy.
let ADMIN_KEY = process.env.ADMIN_KEY || 'kamilove32';

// Runtime config persistence — admin changes are saved to config.local.json
// (gitignored) so they survive restarts within a deploy. On a fresh deploy
// with no file, env defaults apply. Admin-set values win over env.
const CONFIG_FILE = (() => { try { return require('path').join(__dirname, 'config.local.json'); } catch { return 'config.local.json'; } })();
function currentConfig() {
  return { apiKey: API_KEY, primary: UPSTREAM_PRIMARY, fallback: UPSTREAM_FALLBACK,
           defaultModel: DEFAULT_MODEL, bigModel: BIG_MODEL, smallModel: SMALL_MODEL,
           glmModel: GLM_MODEL, proxyKey: PROXY_KEY, adminKey: ADMIN_KEY };
}
function loadRuntimeConfig() {
  try {
    const c = JSON.parse(require('fs').readFileSync(CONFIG_FILE, 'utf8'));
    if (typeof c.apiKey === 'string') API_KEY = c.apiKey;
    if (typeof c.primary === 'string') UPSTREAM_PRIMARY = c.primary;
    if (typeof c.fallback === 'string') UPSTREAM_FALLBACK = c.fallback;
    if (typeof c.defaultModel === 'string') DEFAULT_MODEL = c.defaultModel;
    if (typeof c.bigModel === 'string') BIG_MODEL = c.bigModel;
    if (typeof c.smallModel === 'string') SMALL_MODEL = c.smallModel;
    if (typeof c.glmModel === 'string') GLM_MODEL = c.glmModel;
    if (typeof c.proxyKey === 'string') PROXY_KEY = c.proxyKey;
    if (typeof c.adminKey === 'string' && c.adminKey) ADMIN_KEY = c.adminKey;
    console.error('[proxy] loaded config.local.json overrides');
  } catch (e) { /* no file / bad json — env defaults stand */ }
}
function saveRuntimeConfig(c) {
  try { require('fs').writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2)); return true; }
  catch (e) { console.error('[proxy] config persist failed:', e.message); return false; }
}
loadRuntimeConfig();

// Chars-per-token divisor for count_tokens estimate
const TOK_DIV = parseFloat(process.env.USEAI_TOK_DIV || '3.5');

// ═══════════════════════════════════════════════════════════════════
//  TERMINAL COLORS
// ═══════════════════════════════════════════════════════════════════
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
  bgBlack: '\x1b[40m',
  bgGreen: '\x1b[42m',
  bgRed:   '\x1b[41m',
  bgBlue:  '\x1b[44m',
};

// ═══════════════════════════════════════════════════════════════════
//  REQUEST METRICS (in-memory, resets on restart)
// ═══════════════════════════════════════════════════════════════════
const metrics = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  modelCounts: {},
  avgLatencyMs: 0,
  latencies: [],
  startTime: Date.now(),
  lastRequest: null,
  endpointCounts: {},
  errors: [],
};

function recordRequest(model, latencyMs, success, endpoint) {
  metrics.totalRequests++;
  if (success) metrics.successfulRequests++;
  else metrics.failedRequests++;

  metrics.modelCounts[model] = (metrics.modelCounts[model] || 0) + 1;
  metrics.endpointCounts[endpoint] = (metrics.endpointCounts[endpoint] || 0) + 1;
  metrics.latencies.push(latencyMs);
  if (metrics.latencies.length > 1000) metrics.latencies.shift();
  metrics.avgLatencyMs = metrics.latencies.reduce((a, b) => a + b, 0) / metrics.latencies.length;
  metrics.lastRequest = new Date().toISOString();
}

function recordError(msg) {
  metrics.errors.push({ time: new Date().toISOString(), message: msg });
  if (metrics.errors.length > 50) metrics.errors.shift();
}

// ═══════════════════════════════════════════════════════════════════
//  MODEL MAPPING
// ═══════════════════════════════════════════════════════════════════
function mapModel(anthropicModel) {
  if (!anthropicModel || typeof anthropicModel !== 'string') return DEFAULT_MODEL;
  const m = anthropicModel.toLowerCase().replace(/\[.*?\]/g, '').trim();

  // GLM routing
  if (m.includes('glm'))    return GLM_MODEL;

  // Claude family routing
  if (m.includes('haiku'))  return SMALL_MODEL;
  if (m.includes('opus'))   return BIG_MODEL;
  if (m.includes('sonnet')) return DEFAULT_MODEL;

  // GPT family passthrough
  if (m.includes('gpt'))    return m;

  // Allow passing a real upstream slug straight through
  return anthropicModel.replace(/\[.*?\]/g, '').trim() || DEFAULT_MODEL;
}

// ═══════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════
function log(tag, ...args) {
  if (process.env.PROXY_QUIET) return;
  const ts = new Date().toISOString().slice(11, 23);
  console.error(`${C.dim}[${ts}]${C.reset} ${C.cyan}[${tag}]${C.reset}`, ...args);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function msgId() {
  return 'msg_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function blocksToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  const out = [];
  for (const block of content) {
    if (block == null) continue;
    if (typeof block === 'string') { out.push(block); continue; }
    switch (block.type) {
      case 'text':
        out.push(block.text || '');
        break;
      case 'tool_result':
        out.push(blocksToText(block.content));
        break;
      case 'image':
        out.push('[image omitted: upstream is text-only]');
        break;
      default:
        if (block.text) out.push(block.text);
        break;
    }
  }
  return out.join('\n');
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

// ═══════════════════════════════════════════════════════════════════
//  TOOL CALLING (native & prompt-emulated)
// ═══════════════════════════════════════════════════════════════════
function toolUseId() {
  return 'toolu_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function mapTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out = [];
  for (const t of tools) {
    if (!t || !t.name) continue;
    out.push({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || t.parameters || { type: 'object', properties: {} },
      },
    });
  }
  return out.length ? out : undefined;
}

function mapToolChoice(tc) {
  if (!tc) return undefined;
  if (typeof tc === 'string') {
    if (tc === 'any') return 'required';
    if (tc === 'auto' || tc === 'none') return tc;
    return undefined;
  }
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'none') return 'none';
  if (tc.type === 'tool' && tc.name) {
    return { type: 'function', function: { name: tc.name } };
  }
  return undefined;
}

function buildToolPrompt(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const lines = [];
  lines.push('You have access to the following tools. To call a tool, output a');
  lines.push('JSON object wrapped in <tool_call></tool_call> tags, with keys');
  lines.push('"name" and "arguments". Emit one <tool_call> block per call; you');
  lines.push('may emit several in a row. Put nothing else on those lines. After');
  lines.push('emitting tool calls, stop and wait for the tool results before');
  lines.push('continuing. Example:');
  lines.push('<tool_call>{"name":"write_file","arguments":{"path":"a.txt","content":"hi"}}</tool_call>');
  lines.push('');
  lines.push('Available tools:');
  for (const t of tools) {
    if (!t || !t.name) continue;
    const schema = t.input_schema || t.parameters || { type: 'object', properties: {} };
    lines.push('- ' + t.name + ': ' + (t.description || '').replace(/\s+/g, ' ').trim());
    lines.push('  parameters (JSON schema): ' + safeJson(schema));
  }
  return lines.join('\n');
}

function parseToolCalls(text) {
  const toolCalls = [];
  if (typeof text !== 'string' || text.indexOf('<tool_call>') === -1) {
    return { text: text || '', toolCalls };
  }
  const re = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].trim();
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || !parsed.name) continue;
    const input = parsed.arguments != null ? parsed.arguments
      : (parsed.input != null ? parsed.input : {});
    toolCalls.push({
      id: toolUseId(),
      name: String(parsed.name),
      input: (input && typeof input === 'object') ? input : {},
    });
  }
  const cleaned = text.replace(re, '').trim();
  return { text: cleaned, toolCalls };
}

// ═══════════════════════════════════════════════════════════════════
//  ANTHROPIC -> OPENAI MESSAGE TRANSLATION
// ═══════════════════════════════════════════════════════════════════
function anthropicToOpenAI(body) {
  const messages = [];

  let sysText = '';
  if (body.system) {
    sysText = typeof body.system === 'string'
      ? body.system
      : blocksToText(body.system);
  }

  const toolPrompt = buildToolPrompt(body.tools);
  if (toolPrompt) {
    sysText = sysText.trim() ? (sysText.trim() + '\n\n' + toolPrompt) : toolPrompt;
  }
  if (sysText.trim()) messages.push({ role: 'system', content: sysText });

  for (const m of body.messages || []) {
    const content = m.content;
    if (typeof content === 'string') {
      messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content });
      continue;
    }
    const blocks = Array.isArray(content) ? content : [];

    if (m.role === 'assistant') {
      let text = '';
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text') {
          text += block.text || '';
        } else if (block.type === 'tool_use') {
          const call = { name: block.name || '', arguments: block.input == null ? {} : block.input };
          if (text && !text.endsWith('\n')) text += '\n';
          text += '<tool_call>' + safeJson(call) + '</tool_call>';
        }
      }
      messages.push({ role: 'assistant', content: text || '' });
      continue;
    }

    const userParts = [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_result') {
        const text = blocksToText(block.content);
        const out = text && text.trim() ? text : '(no output)';
        userParts.push('<tool_result>' + out + '</tool_result>');
      } else if (block.type === 'text') {
        userParts.push(block.text || '');
      } else if (block.type === 'image') {
        userParts.push('[image omitted: upstream is text-only]');
      }
    }
    if (userParts.length) {
      messages.push({ role: 'user', content: userParts.join('\n') });
    }
  }

  const openai = {
    model: mapModel(body.model),
    messages,
    stream: !!body.stream,
  };
  if (typeof body.temperature === 'number') openai.temperature = body.temperature;
  if (typeof body.top_p === 'number') openai.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
    openai.stop = body.stop_sequences;
  }
  if (typeof body.max_tokens === 'number') openai.max_tokens = body.max_tokens;
  return openai;
}

// ═══════════════════════════════════════════════════════════════════
//  OPENAI -> ANTHROPIC RESPONSE TRANSLATION
// ═══════════════════════════════════════════════════════════════════
function openAIToAnthropic(oaiResp, requestModel) {
  const choice = (oaiResp.choices || [])[0] || {};
  const msg = choice.message || {};
  const rawText = msg.content || '';

  const { text, toolCalls } = parseToolCalls(rawText);

  const contentBlocks = [];
  if (text) contentBlocks.push({ type: 'text', text });
  for (const tc of toolCalls) {
    contentBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
  }
  if (contentBlocks.length === 0) contentBlocks.push({ type: 'text', text: '' });

  const stopReason = toolCalls.length > 0 ? 'tool_use'
    : (choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn');

  const inTok = (oaiResp.usage || {}).prompt_tokens || 0;
  const outTok = (oaiResp.usage || {}).completion_tokens || 0;

  return {
    id: msgId(),
    type: 'message',
    role: 'assistant',
    model: requestModel || 'glm-5.2',
    content: contentBlocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: inTok, output_tokens: outTok },
  };
}

// ═══════════════════════════════════════════════════════════════════
//  UPSTREAM FETCH (with failover)
// ═══════════════════════════════════════════════════════════════════
function upstreamFetch(url, options) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(parsed, options, resolve);
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function fetchUpstream(payload, stream) {
  const body = JSON.stringify(payload);
  const endpoints = [UPSTREAM_PRIMARY, UPSTREAM_FALLBACK];

  for (const base of endpoints) {
    const url = base.replace(/\/+$/, '') + UPSTREAM_PATH;
    try {
      const res = await upstreamFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': stream ? 'text/event-stream' : 'application/json',
          'Authorization': `Bearer ${API_KEY}`,
        },
        body,
      });

      if (res.statusCode >= 200 && res.statusCode < 300) {
        return { res, endpoint: base };
      }

      // Read error body and try next
      const errBody = await new Promise((r) => {
        const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => r(Buffer.concat(ch).toString()));
      });
      log('FAILOVER', `${base} returned ${res.statusCode}: ${errBody.slice(0, 200)}`);
      recordError(`${base} => ${res.statusCode}`);
    } catch (err) {
      log('FAILOVER', `${base} connection error: ${err.message}`);
      recordError(`${base} => ${err.message}`);
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
//  GRADING ENGINE — terminal-style diagnostics
// ═══════════════════════════════════════════════════════════════════
function computeGrade() {
  const uptime = (Date.now() - metrics.startTime) / 1000;
  const successRate = metrics.totalRequests > 0
    ? (metrics.successfulRequests / metrics.totalRequests * 100)
    : 100;
  const avgLatency = Math.round(metrics.avgLatencyMs);

  // Score components (0-100 each)
  let uptimeScore = Math.min(100, (uptime / 3600) * 20); // 5h = max
  let reliabilityScore = successRate;
  let latencyScore = avgLatency < 500 ? 100 : avgLatency < 2000 ? 70 : avgLatency < 5000 ? 40 : 10;
  let volumeScore = Math.min(100, metrics.totalRequests * 2);

  const overall = Math.round(
    uptimeScore * 0.15 +
    reliabilityScore * 0.40 +
    latencyScore * 0.30 +
    volumeScore * 0.15
  );

  let letter;
  if (overall >= 90) letter = 'A+';
  else if (overall >= 80) letter = 'A';
  else if (overall >= 70) letter = 'B+';
  else if (overall >= 60) letter = 'B';
  else if (overall >= 50) letter = 'C';
  else if (overall >= 40) letter = 'D';
  else letter = 'F';

  return {
    grade: letter,
    score: overall,
    components: {
      uptime:      { score: Math.round(uptimeScore),      weight: '15%', detail: `${Math.round(uptime)}s uptime` },
      reliability: { score: Math.round(reliabilityScore), weight: '40%', detail: `${successRate.toFixed(1)}% success rate` },
      latency:     { score: Math.round(latencyScore),     weight: '30%', detail: `${avgLatency}ms avg` },
      volume:      { score: Math.round(volumeScore),      weight: '15%', detail: `${metrics.totalRequests} requests served` },
    },
    metrics: {
      totalRequests:      metrics.totalRequests,
      successfulRequests: metrics.successfulRequests,
      failedRequests:     metrics.failedRequests,
      avgLatencyMs:       avgLatency,
      uptimeSeconds:      Math.round(uptime),
      modelBreakdown:     { ...metrics.modelCounts },
      endpointBreakdown:  { ...metrics.endpointCounts },
      recentErrors:       metrics.errors.slice(-10),
      lastRequest:        metrics.lastRequest,
    },
  };
}

function renderTerminalGrade(grade) {
  const bar = (score, max = 100) => {
    const filled = Math.round(score / max * 20);
    return '█'.repeat(filled) + '░'.repeat(20 - filled);
  };

  const lines = [];
  lines.push('╔══════════════════════════════════════════════════════╗');
  lines.push('║         cc-useai-proxy  SYSTEM GRADE  v2.0         ║');
  lines.push('╠══════════════════════════════════════════════════════╣');
  lines.push(`║  OVERALL:  ${grade.grade.padEnd(4)} (${String(grade.score).padStart(3)}/100)                          ║`);
  lines.push('╠══════════════════════════════════════════════════════╣');

  for (const [name, comp] of Object.entries(grade.components)) {
    const label = name.padEnd(12);
    const b = bar(comp.score);
    const s = String(comp.score).padStart(3);
    lines.push(`║  ${label} ${b} ${s}  ║`);
  }

  lines.push('╠══════════════════════════════════════════════════════╣');
  lines.push(`║  Requests:  ${String(grade.metrics.totalRequests).padStart(6)}  (${grade.metrics.successfulRequests} ok / ${grade.metrics.failedRequests} fail)`.padEnd(55) + '║');
  lines.push(`║  Avg Latency: ${grade.metrics.avgLatencyMs}ms`.padEnd(55) + '║');
  lines.push(`║  Uptime:  ${grade.metrics.uptimeSeconds}s`.padEnd(55) + '║');

  const models = Object.entries(grade.metrics.modelBreakdown);
  if (models.length > 0) {
    lines.push('║  Models:'.padEnd(55) + '║');
    for (const [model, count] of models) {
      lines.push(`║    ${model}: ${count}`.padEnd(55) + '║');
    }
  }

  if (grade.metrics.recentErrors.length > 0) {
    lines.push('╠══════════════════════════════════════════════════════╣');
    lines.push('║  RECENT ERRORS:'.padEnd(55) + '║');
    for (const err of grade.metrics.recentErrors.slice(-5)) {
      const line = `║    ${err.time.slice(11, 19)} ${err.message.slice(0, 35)}`;
      lines.push(line.padEnd(55) + '║');
    }
  }

  lines.push('╚══════════════════════════════════════════════════════╝');
  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════
//  HTTP SERVER
// ═══════════════════════════════════════════════════════════════════

// Admin panel HTML. The page holds NO secrets — it's a login form plus input
// fields. Every action calls /admin/api/* with the password, which the server
// validates. View-source shows nothing sensitive.
const ADMIN_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proxy Admin</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#08080c;color:#e8e8ef;font:14px/1.6 -apple-system,Segoe UI,sans-serif;min-height:100vh;padding:40px 20px}
  .wrap{max-width:560px;margin:0 auto}
  h1{font-size:18px;margin-bottom:4px}
  .sub{color:#55556a;font-size:12px;font-family:ui-monospace,monospace;margin-bottom:24px}
  .card{background:#0f0f16;border:1px solid #232a35;border-radius:12px;padding:20px;margin-bottom:16px}
  .card h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#8888a0;margin-bottom:14px}
  label{display:block;font-size:11px;color:#55556a;margin:10px 0 4px;font-family:ui-monospace,monospace}
  input{width:100%;background:#08080c;border:1px solid #2d3441;border-radius:8px;padding:10px 12px;color:#e8e8ef;font:13px ui-monospace,monospace;outline:none}
  input:focus{border-color:#6c5ce7}
  .masked{color:#a29bfe}
  .hint{font-size:11px;color:#55556a;margin-top:3px}
  button{background:linear-gradient(135deg,#6c5ce7,#a29bfe);color:#fff;border:0;border-radius:8px;padding:10px 18px;font-weight:600;cursor:pointer;font:inherit;margin-top:8px}
  button.ghost{background:#16161f;border:1px solid #2d3441}
  button:disabled{opacity:.5}
  .row{display:flex;gap:8px}
  .row input{flex:1}
  .msg{font-size:12px;margin-top:8px;font-family:ui-monospace,monospace}
  .msg.ok{color:#4ade80}.msg.bad{color:#f87171}.msg.dim{color:#55556a}
  .stat{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #1c1c28;font-size:13px}
  .stat:last-child{border:0}
  .stat b{color:#a29bfe;font-family:ui-monospace,monospace}
  .gate{display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;margin-left:8px}
  .gate.on{background:rgba(0,214,125,.12);color:#4ade80}.gate.off{background:rgba(248,113,113,.12);color:#f87171}
  #login{display:none}
  #panel{display:none}
  .err-list{font-size:11px;color:#f87171;font-family:ui-monospace,monospace;max-height:120px;overflow:auto;margin-top:6px}
</style></head><body><div class="wrap">
<h1>Proxy Admin</h1>
<div class="sub" id="host"></div>

<div class="card" id="login">
  <h2>Authenticate</h2>
  <label>ADMIN PASSWORD</label>
  <input type="password" id="pw" placeholder="password" autofocus>
  <button id="btn-login">Unlock</button>
  <div class="msg" id="login-msg"></div>
</div>

<div id="panel">
  <div class="card">
    <h2>Live status <span id="gate" class="gate"></span></h2>
    <div class="stat"><span>Total requests</span><b id="s-total">—</b></div>
    <div class="stat"><span>Successful</span><b id="s-ok">—</b></div>
    <div class="stat"><span>Failed</span><b id="s-fail">—</b></div>
    <div class="stat"><span>Avg latency</span><b id="s-lat">—</b></div>
    <div class="stat"><span>Uptime</span><b id="s-up">—</b></div>
  </div>

  <div class="card">
    <h2>Upstream</h2>
    <label>API KEY <span id="k-api" class="masked"></span></label>
    <div class="row"><input id="v-api" type="password" placeholder="new upstream key (leave blank to keep)"><button class="ghost" data-show="v-api">show</button></div>
    <label>PRIMARY ENDPOINT</label>
    <input id="v-primary" placeholder="https://...">
    <label>FALLBACK ENDPOINT</label>
    <input id="v-fallback" placeholder="https://...">
    <div class="row"><button id="btn-test">Test upstream</button></div>
    <div class="msg" id="test-msg"></div>
  </div>

  <div class="card">
    <h2>Models</h2>
    <label>DEFAULT (sonnet)</label><input id="v-default" placeholder="glm-5.2">
    <label>BIG (opus)</label><input id="v-big" placeholder="glm-5.2">
    <label>SMALL (haiku)</label><input id="v-small" placeholder="glm-5.2">
    <label>GLM</label><input id="v-glm" placeholder="glm-5.2">
  </div>

  <div class="card">
    <h2>Access control</h2>
    <label>PROXY KEY (client gate) <span id="k-proxy" class="masked"></span></label>
    <div class="hint">Empty = public site (no key needed). Set a value to require it as x-api-key.</div>
    <input id="v-proxy" placeholder="(blank = public)">
    <label>ADMIN PASSWORD <span id="k-admin" class="masked"></span></label>
    <input id="v-admin" placeholder="new admin password (blank to keep)">
  </div>

  <button id="btn-save" style="width:100%">Save & Apply (live, no restart)</button>
  <div class="msg" id="save-msg"></div>
</div>
</div>
<script>
(function(){
  var $=function(i){return document.getElementById(i)};
  var host=location.origin;
  $('host').textContent=host;
  var pw='';
  var token='';  // not used server-side; password sent per-request header

  // Try a stored password from sessionStorage for convenience within the tab.
  var saved=sessionStorage.getItem('admin_pw');
  if(saved){ $('pw').value=saved; }

  function hdr(){ return { 'Content-Type':'application/json', 'x-admin-key':pw }; }

  $('login').style.display='block';

  function unlock(){
    pw=$('pw').value;
    if(!pw){ $('login-msg').className='msg bad'; $('login-msg').textContent='enter password'; return; }
    fetch('/admin/api/config',{headers:hdr()}).then(function(r){
      if(r.status===401){ $('login-msg').className='msg bad'; $('login-msg').textContent='wrong password'; $('login').style.display='block'; $('panel').style.display='none'; return; }
      return r.json();
    }).then(function(j){
      if(!j)return;
      sessionStorage.setItem('admin_pw',pw);
      $('login').style.display='none';
      $('panel').style.display='block';
      render(j);
    }).catch(function(e){ $('login-msg').className='msg bad'; $('login-msg').textContent=''+e; });
  }
  $('btn-login').onclick=unlock;
  $('pw').addEventListener('keydown',function(e){ if(e.key==='Enter')unlock(); });

  function fmt(s){ if(s<60)return s+'s'; var m=Math.floor(s/60); return m+'m '+(s%60)+'s'; }
  function render(j){
    var c=j.config, s=j.stats;
    var g=$('gate');
    if(c.gateActive){ g.className='gate on'; g.textContent='GATE ON'; } else { g.className='gate off'; g.textContent='PUBLIC'; }
    $('s-total').textContent=s.totalRequests;
    $('s-ok').textContent=s.successfulRequests;
    $('s-fail').textContent=s.failedRequests;
    $('s-lat').textContent=s.avgLatencyMs+'ms';
    $('s-up').textContent=fmt(s.uptime);
    $('k-api').textContent='('+c.apiKeyMasked+')';
    $('k-proxy').textContent='('+c.proxyKeyMasked+')';
    $('k-admin').textContent='('+c.adminKeyMasked+')';
    $('v-primary').value=c.primary; $('v-fallback').value=c.fallback;
    $('v-default').value=c.defaultModel; $('v-big').value=c.bigModel;
    $('v-small').value=c.smallModel; $('v-glm').value=c.glmModel;
    $('v-api').value=''; $('v-proxy').value=''; $('v-admin').value='';
  }
  function refresh(){ fetch('/admin/api/config',{headers:hdr()}).then(function(r){return r.json()}).then(render).catch(function(){}); }

  document.querySelectorAll('[data-show]').forEach(function(b){
    b.onclick=function(){ var i=$(b.getAttribute('data-show')); i.type=i.type==='password'?'text':'password'; };
  });

  $('btn-save').onclick=function(){
    var cfg={};
    if($('v-api').value.trim())cfg.apiKey=$('v-api').value.trim();
    cfg.primary=$('v-primary').value.trim(); cfg.fallback=$('v-fallback').value.trim();
    cfg.defaultModel=$('v-default').value.trim(); cfg.bigModel=$('v-big').value.trim();
    cfg.smallModel=$('v-small').value.trim(); cfg.glmModel=$('v-glm').value.trim();
    if($('v-proxy').value!=='')cfg.proxyKey=$('v-proxy').value.trim();
    if($('v-admin').value.trim()){ cfg.adminKey=$('v-admin').value.trim(); pw=cfg.adminKey; sessionStorage.setItem('admin_pw',pw); }
    $('save-msg').className='msg dim'; $('save-msg').textContent='saving…';
    fetch('/admin/api/config',{method:'POST',headers:hdr(),body:JSON.stringify({config:cfg})}).then(function(r){return r.json()}).then(function(j){
      if(j.ok){ $('save-msg').className='msg ok'; $('save-msg').textContent='saved ✓ (persisted='+(j.persisted? 'yes':'no')+', gate '+(j.gateActive?'ON':'OFF')+')'; refresh(); }
      else { $('save-msg').className='msg bad'; $('save-msg').textContent='failed'; }
    }).catch(function(e){ $('save-msg').className='msg bad'; $('save-msg').textContent=''+e; });
  };

  $('btn-test').onclick=function(){
    $('test-msg').className='msg dim'; $('test-msg').textContent='probing upstream…';
    fetch('/admin/api/test',{method:'POST',headers:hdr(),body:'{}'}).then(function(r){return r.json()}).then(function(j){
      if(j.ok){ $('test-msg').className='msg ok'; $('test-msg').textContent='OK · '+j.endpoint+' · '+j.latencyMs+'ms'; }
      else { $('test-msg').className='msg bad'; $('test-msg').textContent=j.error||'failed';
        if(j.recentErrors&&j.recentErrors.length){ var el=document.createElement('div'); el.className='err-list'; el.textContent=j.recentErrors.map(function(e){return e.message}).join('\\n'); $('test-msg').appendChild(el); } }
    }).catch(function(e){ $('test-msg').className='msg bad'; $('test-msg').textContent=''+e; });
  };

  if(saved)unlock();
})();
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const method = req.method || 'GET';

  // ─── CORS ───
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ─── Web chat UI at the root — serve chat.html from disk if present
  //     (nicer UI with Chat + Base URL tabs, model locked to glm-5.2),
  //     else fall back to a minimal inline page. ───
  if (method === 'GET' && (url === '/' || url === '/index.html' || url === '/chat.html')) {
    let html = null;
    try {
      const fs = require('fs');
      const path = require('path');
      const p = path.join(__dirname, 'chat.html');
      if (fs.existsSync(p)) html = fs.readFileSync(p);
    } catch (e) { /* fall through to inline page */ }
    if (!html) {
      html = Buffer.from(
        '<!DOCTYPE html><meta charset="utf-8"><title>cc-useai-proxy</title>' +
        '<body style="font-family:sans-serif;background:#0d1117;color:#e6edf3;padding:40px">' +
        '<h1>cc-useai-proxy v2.0</h1><p>chat.html not found. Health at <a href="/health">/health</a>.</p>',
        'utf8'
      );
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length });
    res.end(html);
    return;
  }

  // ─── Admin panel (served at /admin) ───
  // The page itself carries no secrets — it only renders a login form + fields.
  // All reads/writes go through /admin/api/* which require the ADMIN_KEY.
  // Viewing page source reveals nothing useful.
  if (method === 'GET' && (url === '/admin' || url === '/admin/')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(ADMIN_PAGE);
    return;
  }

  // ─── Admin API ───
  // Every /admin/api/* call requires the admin password (header x-admin-key
  // or body { password }). On mismatch → 401. Secrets never reach the page.
  if (url.startsWith('/admin/api/')) {
    const raw = method === 'POST' ? await readBody(req) : '';
    let bodyObj = {};
    try { bodyObj = raw ? JSON.parse(raw) : {}; } catch { bodyObj = {}; }
    const sentPw = req.headers['x-admin-key'] || bodyObj.password || '';
    if (sentPw !== ADMIN_KEY) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid or missing admin password' }));
      return;
    }
    const route = url.replace('/admin/api/', '').split('?')[0];

    // GET config (masks the secret keys)
    if (route === 'config' && method === 'GET') {
      const c = currentConfig();
      const mask = (k) => k ? (k.slice(0, 6) + '••••••' + k.slice(-4)) : '(not set)';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        config: {
          apiKeyMasked: mask(c.apiKey),
          primary: c.primary, fallback: c.fallback,
          defaultModel: c.defaultModel, bigModel: c.bigModel,
          smallModel: c.smallModel, glmModel: c.glmModel,
          proxyKeyMasked: c.proxyKey ? mask(c.proxyKey) : '(public — no gate)',
          adminKeyMasked: mask(c.adminKey),
          gateActive: !!c.proxyKey,
        },
        stats: {
          totalRequests: metrics.totalRequests,
          successfulRequests: metrics.successfulRequests,
          failedRequests: metrics.failedRequests,
          avgLatencyMs: Math.round(metrics.avgLatencyMs),
          uptime: Math.round((Date.now() - metrics.startTime) / 1000),
          recentErrors: metrics.errors.slice(-10),
        },
      }));
      return;
    }

    // POST config — update any subset. Save to config.local.json + apply live.
    if (route === 'config' && method === 'POST') {
      const patch = bodyObj.config || {};
      if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) API_KEY = patch.apiKey.trim();
      if (typeof patch.primary === 'string' && patch.primary.trim()) UPSTREAM_PRIMARY = patch.primary.trim();
      if (typeof patch.fallback === 'string' && patch.fallback.trim()) UPSTREAM_FALLBACK = patch.fallback.trim();
      if (typeof patch.defaultModel === 'string' && patch.defaultModel.trim()) DEFAULT_MODEL = patch.defaultModel.trim();
      if (typeof patch.bigModel === 'string' && patch.bigModel.trim()) BIG_MODEL = patch.bigModel.trim();
      if (typeof patch.smallModel === 'string' && patch.smallModel.trim()) SMALL_MODEL = patch.smallModel.trim();
      if (typeof patch.glmModel === 'string' && patch.glmModel.trim()) GLM_MODEL = patch.glmModel.trim();
      if (typeof patch.proxyKey === 'string') PROXY_KEY = patch.proxyKey.trim(); // '' clears the gate
      if (typeof patch.adminKey === 'string' && patch.adminKey.trim()) ADMIN_KEY = patch.adminKey.trim();
      const saved = saveRuntimeConfig(currentConfig());
      log('ADMIN', 'config updated (persisted=' + saved + ')');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, persisted: saved, gateActive: !!PROXY_KEY }));
      return;
    }

    // POST test — live upstream probe with the current key, returns status.
    if (route === 'test' && method === 'POST') {
      try {
        const t0 = Date.now();
        const r = await fetchUpstream({
          model: DEFAULT_MODEL,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 8, stream: false,
        }, false);
        const latency = Date.now() - t0;
        if (r) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, endpoint: r.endpoint, latencyMs: latency }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'all upstream endpoints failed (likely 401/403 — bad key or no quota)', recentErrors: metrics.errors.slice(-5) }));
        }
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'unknown admin route' }));
    return;
  }

  // ─── Inbound auth gate ───
  // When PROXY_KEY is set, every API route below requires it. The web UI is
  // always public (so people can load the page); the page itself sends the
  // key. When unset, the proxy is fully open.
  if (PROXY_KEY) {
    const sent = req.headers['x-api-key'] || (req.headers['authorization'] || '').replace(/^bearer\s+/i, '') || '';
    if (sent !== PROXY_KEY) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid or missing API key (x-api-key / Authorization)' } }));
      return;
    }
  }

  // ─── Health ───
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      version: '2.0.0',
      uptime: Math.round((Date.now() - metrics.startTime) / 1000),
      models: {
        default: DEFAULT_MODEL,
        big: BIG_MODEL,
        small: SMALL_MODEL,
        glm: GLM_MODEL,
      },
      endpoints: {
        primary: UPSTREAM_PRIMARY,
        fallback: UPSTREAM_FALLBACK,
      },
    }));
    return;
  }

  // ─── Grade endpoint (JSON) ───
  if (url === '/grade') {
    const grade = computeGrade();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(grade, null, 2));
    return;
  }

  // ─── Terminal endpoint (ASCII art grade) ───
  if (url === '/terminal' || url === '/status') {
    const grade = computeGrade();
    const ascii = renderTerminalGrade(grade);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(ascii + '\n');
    return;
  }

  // ─── Models endpoint ───
  if (url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'glm-5.2', object: 'model', created: 1719000000, owned_by: 'zhipu' },
      ],
    }));
    return;
  }

  // ─── Token counting (Anthropic-format) ───
  if (url === '/v1/messages/count_tokens' && method === 'POST') {
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end('bad json'); return; }

    const sysLen = blocksToText(body.system).length;
    let msgLen = 0;
    for (const m of body.messages || []) {
      msgLen += typeof m.content === 'string' ? m.content.length : blocksToText(m.content).length;
    }
    const tokens = Math.ceil((sysLen + msgLen) / TOK_DIV);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ input_tokens: tokens }));
    return;
  }

  // ─── Main proxy: /v1/messages (Anthropic format) ───
  if (url === '/v1/messages' && method === 'POST') {
    const start = Date.now();
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch {
      res.writeHead(400);
      res.end('bad json');
      return;
    }

    const requestModel = body.model || '';
    const oaiPayload = anthropicToOpenAI(body);
    const wantStream = !!body.stream;

    log('REQ', `${C.green}${requestModel}${C.reset} → ${C.yellow}${oaiPayload.model}${C.reset}` +
      ` | msgs=${oaiPayload.messages.length} stream=${wantStream}`);

    // ─── NON-STREAMING ───
    if (!wantStream) {
      oaiPayload.stream = false;
      const result = await fetchUpstream(oaiPayload, false);
      if (!result) {
        metrics.failedRequests++;
        res.writeHead(502);
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'All upstream endpoints failed' } }));
        return;
      }

      const { res: upstream, endpoint } = result;
      const chunks = [];
      upstream.on('data', c => chunks.push(c));
      upstream.on('end', () => {
        const latency = Date.now() - start;
        const respText = Buffer.concat(chunks).toString();
        let oaiResp;
        try { oaiResp = JSON.parse(respText); } catch {
          recordRequest(oaiPayload.model, latency, false, endpoint);
          log('ERR', `Bad JSON from upstream: ${respText.slice(0, 200)}`);
          res.writeHead(502);
          res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Bad upstream response' } }));
          return;
        }

        recordRequest(oaiPayload.model, latency, true, endpoint);
        const anthropicResp = openAIToAnthropic(oaiResp, requestModel);
        log('RES', `${C.green}✓${C.reset} ${latency}ms | ${anthropicResp.usage.input_tokens}in/${anthropicResp.usage.output_tokens}out`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(anthropicResp));
      });
      return;
    }

    // ─── STREAMING ───
    oaiPayload.stream = true;
    const result = await fetchUpstream(oaiPayload, true);
    if (!result) {
      metrics.failedRequests++;
      res.writeHead(502);
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'All upstream endpoints failed' } }));
      return;
    }

    const { res: upstream, endpoint } = result;

    // Send the Anthropic stream start event
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const streamMsgId = msgId();

    // message_start
    res.write('event: message_start\ndata: ' + JSON.stringify({
      type: 'message_start',
      message: {
        id: streamMsgId,
        type: 'message',
        role: 'assistant',
        model: requestModel || 'glm-5.2',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }) + '\n\n');

    // content_block_start
    res.write('event: content_block_start\ndata: ' + JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }) + '\n\n');

    let buffer = '';
    let totalText = '';

    upstream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') continue;

        let parsed;
        try { parsed = JSON.parse(dataStr); } catch { continue; }

        const delta = ((parsed.choices || [])[0] || {}).delta || {};
        const text = delta.content || '';
        if (!text) continue;

        totalText += text;
        res.write('event: content_block_delta\ndata: ' + JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text },
        }) + '\n\n');
      }
    });

    upstream.on('end', () => {
      const latency = Date.now() - start;
      recordRequest(oaiPayload.model, latency, true, endpoint);

      // Check for tool calls in accumulated text
      const { text: cleanText, toolCalls } = parseToolCalls(totalText);

      // content_block_stop
      res.write('event: content_block_stop\ndata: ' + JSON.stringify({
        type: 'content_block_stop',
        index: 0,
      }) + '\n\n');

      // If tool calls were found, emit them as additional content blocks
      let blockIdx = 1;
      for (const tc of toolCalls) {
        res.write('event: content_block_start\ndata: ' + JSON.stringify({
          type: 'content_block_start',
          index: blockIdx,
          content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} },
        }) + '\n\n');
        res.write('event: content_block_delta\ndata: ' + JSON.stringify({
          type: 'content_block_delta',
          index: blockIdx,
          delta: { type: 'input_json_delta', partial_json: safeJson(tc.input) },
        }) + '\n\n');
        res.write('event: content_block_stop\ndata: ' + JSON.stringify({
          type: 'content_block_stop',
          index: blockIdx,
        }) + '\n\n');
        blockIdx++;
      }

      const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';

      // message_delta
      res.write('event: message_delta\ndata: ' + JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: Math.ceil(totalText.length / TOK_DIV) },
      }) + '\n\n');

      // message_stop
      res.write('event: message_stop\ndata: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n');
      res.end();

      log('STREAM', `${C.green}✓${C.reset} ${latency}ms | ~${Math.ceil(totalText.length / TOK_DIV)} tokens`);
    });

    upstream.on('error', (err) => {
      const latency = Date.now() - start;
      recordRequest(oaiPayload.model, latency, false, endpoint);
      recordError(err.message);
      log('ERR', `Stream error: ${err.message}`);
      res.end();
    });

    return;
  }

  // ─── OpenAI-native /v1/chat/completions passthrough ───
  if (url === '/v1/chat/completions' && method === 'POST') {
    const start = Date.now();
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch {
      res.writeHead(400);
      res.end('bad json');
      return;
    }

    // Clean model name
    body.model = mapModel(body.model);
    const wantStream = !!body.stream;

    log('OAI', `${C.magenta}${body.model}${C.reset} | msgs=${(body.messages || []).length} stream=${wantStream}`);

    const result = await fetchUpstream(body, wantStream);
    if (!result) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: { message: 'All upstream endpoints failed' } }));
      return;
    }

    const { res: upstream, endpoint } = result;

    if (!wantStream) {
      const chunks = [];
      upstream.on('data', c => chunks.push(c));
      upstream.on('end', () => {
        const latency = Date.now() - start;
        recordRequest(body.model, latency, true, endpoint);
        res.writeHead(upstream.statusCode, { 'Content-Type': 'application/json' });
        res.end(Buffer.concat(chunks));
      });
    } else {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      upstream.on('data', c => res.write(c));
      upstream.on('end', () => {
        const latency = Date.now() - start;
        recordRequest(body.model, latency, true, endpoint);
        res.end();
      });
    }
    return;
  }

  // ─── 404 ───
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: 'Not found',
    available_endpoints: [
      'POST /v1/messages          (Anthropic Messages API)',
      'POST /v1/chat/completions  (OpenAI-native passthrough)',
      'POST /v1/messages/count_tokens',
      'GET  /v1/models',
      'GET  /health',
      'GET  /grade                (JSON diagnostics)',
      'GET  /terminal             (ASCII diagnostics)',
      'GET  /status               (alias for /terminal)',
    ],
  }));
});

// ═══════════════════════════════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════════════════════════════
server.listen(PORT, HOST, () => {
  console.log(`
${C.bold}${C.cyan}╔══════════════════════════════════════════════════════════╗${C.reset}
${C.bold}${C.cyan}║${C.reset}  ${C.bold}cc-useai-proxy${C.reset}  ${C.dim}v2.0.0${C.reset}                               ${C.bold}${C.cyan}║${C.reset}
${C.bold}${C.cyan}╠══════════════════════════════════════════════════════════╣${C.reset}
${C.bold}${C.cyan}║${C.reset}  ${C.green}▸${C.reset} Listening:    ${C.bold}http://${HOST}:${PORT}${C.reset}${' '.repeat(Math.max(0, 22 - `${HOST}:${PORT}`.length))}${C.bold}${C.cyan}║${C.reset}
${C.bold}${C.cyan}║${C.reset}  ${C.green}▸${C.reset} Primary:      ${C.yellow}${UPSTREAM_PRIMARY}${C.reset}${' '.repeat(Math.max(0, 31 - UPSTREAM_PRIMARY.length))}${C.bold}${C.cyan}║${C.reset}
${C.bold}${C.cyan}║${C.reset}  ${C.green}▸${C.reset} Fallback:     ${C.yellow}${UPSTREAM_FALLBACK}${C.reset}${' '.repeat(Math.max(0, 31 - UPSTREAM_FALLBACK.length))}${C.bold}${C.cyan}║${C.reset}
${C.bold}${C.cyan}║${C.reset}  ${C.green}▸${C.reset} Default:      ${C.magenta}${DEFAULT_MODEL}${C.reset}${' '.repeat(Math.max(0, 31 - DEFAULT_MODEL.length))}${C.bold}${C.cyan}║${C.reset}
${C.bold}${C.cyan}║${C.reset}  ${C.green}▸${C.reset} Big Model:    ${C.magenta}${BIG_MODEL}${C.reset}${' '.repeat(Math.max(0, 31 - BIG_MODEL.length))}${C.bold}${C.cyan}║${C.reset}
${C.bold}${C.cyan}║${C.reset}  ${C.green}▸${C.reset} Small Model:  ${C.magenta}${SMALL_MODEL}${C.reset}${' '.repeat(Math.max(0, 31 - SMALL_MODEL.length))}${C.bold}${C.cyan}║${C.reset}
${C.bold}${C.cyan}║${C.reset}  ${C.green}▸${C.reset} GLM Model:    ${C.magenta}${GLM_MODEL}${C.reset}${' '.repeat(Math.max(0, 31 - GLM_MODEL.length))}${C.bold}${C.cyan}║${C.reset}
${C.bold}${C.cyan}╠══════════════════════════════════════════════════════════╣${C.reset}
${C.bold}${C.cyan}║${C.reset}  ${C.dim}Claude Code:  set ANTHROPIC_BASE_URL=http://localhost:${PORT}${C.reset}  ${C.bold}${C.cyan}║${C.reset}
${C.bold}${C.cyan}║${C.reset}  ${C.dim}              set ANTHROPIC_API_KEY=unused${C.reset}              ${C.bold}${C.cyan}║${C.reset}
${C.bold}${C.cyan}╚══════════════════════════════════════════════════════════╝${C.reset}
`);
  if (!API_KEY) {
    console.log(`${C.red}[!] USEAI_API_KEY not set — upstream will reject requests.${C.reset}`);
    console.log(`${C.dim}    Set it via /admin (password kamilove32) or USEAI_API_KEY env.${C.reset}`);
  }
  if (PROXY_KEY) {
    console.log(`${C.green}[+] Auth gate ON — clients must send x-api-key / Authorization = PROXY_KEY${C.reset}`);
  } else {
    console.log(`${C.yellow}[~] Auth gate OFF — public, anyone with the URL can use it${C.reset}`);
  }
  console.log(`${C.cyan}[i] Admin panel at /admin  (password set via ADMIN_KEY env, default kamilove32)${C.reset}`);
});
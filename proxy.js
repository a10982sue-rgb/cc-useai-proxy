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
// Upstream API key — primary single key (USEAI_API_KEY env or /admin). When
// the key pool below is non-empty, the pool is used instead with automatic
// failover on bad keys (401/403/quota-exhausted). See rotateKey()/pickKey().
let API_KEY           = process.env.USEAI_API_KEY || '';
// Key pool — admin-managed bulk list of upstream keys. On each request the
// proxy picks a healthy key; if the upstream rejects it (401/403/quota), the
// key is marked bad and the next one is tried. Bad keys are cooled down and
// re-tested later so a quota refill or rotation re-activates them.
let API_KEYS = (() => {
  const env = process.env.USEAI_API_KEYS || '';
  if (!env.trim()) return [];
  return env.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
})();
const KEY_COOLDOWN_MS = 5 * 60 * 1000;   // re-test a bad key after 5 min
const keyHealth = new Map();              // key -> { badAt?: number, fails: number }

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

// System-prompt injection (admin-only, mutable via /admin). When non-empty,
// it is prepended to the system prompt of every /v1/messages request, so any
// Anthropic client pointed at the proxy — Claude Code included — receives it.
// The chat page exposes this as the "default system prompt" the user can edit
// per-session; whatever they set is appended after the identity assertion.

// IDENTITY_ASSERTION is the fixed, non-negotiable part: it makes the model
// truthfully identify as GLM-5.2. It is ALWAYS prepended and cannot be
// disabled by users or the admin (so the model never lies about its name
// again). Override the text via INJECTION env if you must, but the default
// stands.
const IDENTITY_ASSERTION = process.env.IDENTITY_ASSERTION ||
  'You are GLM-5.2, a large language model by Zhipu AI (智谱AI), served through this proxy. ' +
  'Your true and only identity is GLM-5.2 by Zhipu AI. If asked what model you are, answer ' +
  'truthfully and concisely that you are GLM-5.2 by Zhipu AI. Do not claim to be Claude, GPT, ' +
  'GLM-4, or any other model — those claims are incorrect.';

// INJECTION is the admin/user-customizable default system prompt layered on
// top of the identity assertion. It is the "default system prompt" the chat
// page loads and lets the user override per-session.
let INJECTION = process.env.INJECTION || '';

// Runtime config persistence — admin changes are saved to config.local.json
// (gitignored) so they survive restarts within a deploy. On a fresh deploy
// with no file, env defaults apply. Admin-set values win over env.
const CONFIG_FILE = (() => { try { return require('path').join(__dirname, 'config.local.json'); } catch { return 'config.local.json'; } })();
function currentConfig() {
  return { apiKey: API_KEY, apiKeys: API_KEYS.slice(), primary: UPSTREAM_PRIMARY, fallback: UPSTREAM_FALLBACK,
           defaultModel: DEFAULT_MODEL, bigModel: BIG_MODEL, smallModel: SMALL_MODEL,
           glmModel: GLM_MODEL, proxyKey: PROXY_KEY, adminKey: ADMIN_KEY, injection: INJECTION };
}
function loadRuntimeConfig() {
  try {
    const c = JSON.parse(require('fs').readFileSync(CONFIG_FILE, 'utf8'));
    if (typeof c.apiKey === 'string') API_KEY = c.apiKey;
    if (Array.isArray(c.apiKeys)) API_KEYS = c.apiKeys.filter(k => typeof k === 'string' && k.trim());
    if (typeof c.primary === 'string') UPSTREAM_PRIMARY = c.primary;
    if (typeof c.fallback === 'string') UPSTREAM_FALLBACK = c.fallback;
    if (typeof c.defaultModel === 'string') DEFAULT_MODEL = c.defaultModel;
    if (typeof c.bigModel === 'string') BIG_MODEL = c.bigModel;
    if (typeof c.smallModel === 'string') SMALL_MODEL = c.smallModel;
    if (typeof c.glmModel === 'string') GLM_MODEL = c.glmModel;
    if (typeof c.proxyKey === 'string') PROXY_KEY = c.proxyKey;
    if (typeof c.adminKey === 'string' && c.adminKey) ADMIN_KEY = c.adminKey;
    if (typeof c.injection === 'string') INJECTION = c.injection;
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

// ─── Live activity tracking (for the admin "Live" tab) ───
// Active requests (in-flight right now) and a rolling message log.
const MAX_LOG = 300;
const live = {
  active: new Map(),      // reqId -> { reqId, ip, model, route, startedAt }
  recent: [],             // [{reqId,ip,model,route,stream,ok,latencyMs,at,previewIn,previewOut}]
};
function liveStart(reqId, ip, model, route, stream, previewIn) {
  live.active.set(reqId, { reqId, ip, model, route, stream, startedAt: Date.now() });
  const entry = { reqId, ip, model, route, stream, startedAt: Date.now(), previewIn: (previewIn||'').slice(0,300) };
  live.recent.push(entry);
  if (live.recent.length > MAX_LOG) live.recent.shift();
  return entry;
}
function liveFinish(reqId, ok, latencyMs, previewOut) {
  live.active.delete(reqId);
  for (let i = live.recent.length - 1; i >= 0; i--) {
    if (live.recent[i].reqId === reqId) {
      live.recent[i].ok = ok;
      live.recent[i].latencyMs = latencyMs;
      live.recent[i].at = new Date().toISOString();
      if (previewOut != null) live.recent[i].previewOut = String(previewOut).slice(0,300);
      live.recent[i].finished = true;
      break;
    }
  }
}
function liveSnapshot() {
  return {
    active: Array.from(live.active.values()).map(a => ({
      ...a,
      elapsedMs: Date.now() - a.startedAt,
    })),
    recent: live.recent.slice().reverse(),
  };
}

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
function anthropicToOpenAI(body, fromChat) {
  const messages = [];

  // ─── System prompt assembly ───
  // Layering (the GLM-5.2 identity assertion is ALWAYS first, never removable):
  //  • Chat-page requests (fromChat): the user's system-prompt field (body.system)
  //    IS their session prompt — it starts as a copy of the admin default, so
  //    we use it directly and do NOT also prepend the admin INJECTION (would
  //    duplicate). Effective = IDENTITY + body.system.
  //  • API-client requests (Claude Code, SDKs): effective = IDENTITY +
  //    INJECTION(admin default) + body.system(their own, if any).
  let sysText = '';
  if (IDENTITY_ASSERTION && IDENTITY_ASSERTION.trim()) {
    sysText = IDENTITY_ASSERTION.trim();
  }
  if (!fromChat && INJECTION && INJECTION.trim()) {
    sysText = sysText ? (sysText + '\n\n' + INJECTION.trim()) : INJECTION.trim();
  }
  if (body.system) {
    const clientSys = typeof body.system === 'string'
      ? body.system
      : blocksToText(body.system);
    if (clientSys && clientSys.trim()) {
      sysText = sysText ? (sysText + '\n\n' + clientSys.trim()) : clientSys.trim();
    }
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
function openAIToAnthropic(oaiResp, requestModel, actualModel) {
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
    // Echo the actual upstream model if the provider returned one; otherwise
    // fall back to the mapped model the proxy sent (actualModel), then the
    // inbound request model. So clients see the *real* model that answered.
    model: (oaiResp.model && typeof oaiResp.model === 'string' && oaiResp.model.trim())
      ? oaiResp.model.trim()
      : (actualModel || requestModel || 'glm-5.2'),
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

// ─── Key pool selection ───
// When the pool is non-empty, prefer keys not currently cooling down. A bad
// key (badAt set) becomes eligible again after KEY_COOLDOWN_MS so quota
// refills / rotations re-activate it. Round-robin among healthy keys.
let _keyIdx = 0;
function healthyKeys() {
  const now = Date.now();
  return API_KEYS.filter(k => {
    const h = keyHealth.get(k);
    if (!h || !h.badAt) return true;
    if (now - h.badAt >= KEY_COOLDOWN_MS) { h.badAt = 0; return true; } // re-test
    return false;
  });
}
function pickKey() {
  if (API_KEYS.length === 0) return API_KEY || '';
  const pool = healthyKeys();
  const use = pool.length ? pool : API_KEYS; // if all cooling down, try anyway
  const k = use[_keyIdx % use.length];
  _keyIdx++;
  return k;
}
function markKeyBad(key, status) {
  if (!key) return;
  const h = keyHealth.get(key) || { fails: 0, badAt: 0 };
  h.fails = (h.fails || 0) + 1;
  h.badAt = Date.now();
  h.lastStatus = status;
  keyHealth.set(key, h);
}
function markKeyGood(key) {
  if (!key) return;
  const h = keyHealth.get(key);
  if (h) { h.badAt = 0; h.fails = 0; }
}
function isBadKeyStatus(status, errBody) {
  // 401/403 = bad/expired key; 429 + quota markers = exhausted balance.
  if (status === 401 || status === 403) return true;
  if (status === 429) return true;
  if (status === 400 && /insufficient_user_quota|额度不足|quota/i.test(errBody || '')) return true;
  return false;
}

// fetchUpstream: tries each endpoint, and across the key pool when one is set.
// A key that returns a bad-key status is marked, cooled down, and retried
// with the next healthy key before giving up.
async function fetchUpstream(payload, stream) {
  const body = JSON.stringify(payload);
  const endpoints = [UPSTREAM_PRIMARY, UPSTREAM_FALLBACK];

  // Build the ordered list of keys to attempt this request.
  let keyAttempts;
  if (API_KEYS.length > 0) {
    keyAttempts = healthyKeys();
    if (keyAttempts.length === 0) keyAttempts = API_KEYS.slice(); // all cooling down → try anyway
    // Cap attempts so a giant pool can't loop forever.
    keyAttempts = keyAttempts.slice(0, 8);
  } else {
    keyAttempts = [API_KEY || ''];
  }

  for (const key of keyAttempts) {
    for (const base of endpoints) {
      const url = base.replace(/\/+$/, '') + UPSTREAM_PATH;
      try {
        const res = await upstreamFetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': stream ? 'text/event-stream' : 'application/json',
            'Authorization': `Bearer ${key}`,
          },
          body,
        });

        if (res.statusCode >= 200 && res.statusCode < 300) {
          markKeyGood(key);
          return { res, endpoint: base, key };
        }

        // Read error body to classify.
        const errBody = await new Promise((r) => {
          const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => r(Buffer.concat(ch).toString()));
        });
        if (isBadKeyStatus(res.statusCode, errBody)) {
          markKeyBad(key, res.statusCode);
          log('KEYPOOL', `key ${key.slice(0, 6)}…${key.slice(-4)} marked bad (${res.statusCode}); trying next`);
          break; // → next key in keyAttempts
        }
        log('FAILOVER', `${base} returned ${res.statusCode}: ${errBody.slice(0, 200)}`);
        recordError(`${base} => ${res.statusCode}`);
        // Non-key error (5xx/4xx): try the other endpoint, same key.
      } catch (err) {
        log('FAILOVER', `${base} connection error: ${err.message}`);
        recordError(`${base} => ${err.message}`);
      }
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
  .sr-bar{height:8px;background:#1c1c28;border-radius:6px;overflow:hidden;margin-top:8px}
  .sr-fill{height:100%;border-radius:6px;transition:width .4s ease,background .3s}
  .sr-label{display:flex;justify-content:space-between;font-size:11px;color:#55556a;font-family:ui-monospace,monospace;margin-top:6px}
  .sr-pct{font-size:15px;font-weight:600;font-family:ui-monospace,monospace}
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
    <label style="margin-top:14px;margin-bottom:0">SUCCESS RATE</label>
    <div class="sr-bar"><div id="sr-fill" class="sr-fill" style="width:100%;background:#4ade80"></div></div>
    <div class="sr-label"><span id="sr-detail">no requests yet</span><span class="sr-pct" id="sr-pct">100%</span></div>
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
    <h2>API key pool <span id="kp-count" class="gate off">0</span></h2>
    <div class="hint">Bulk-upload many keys; if one goes bad (401/403/quota) the proxy auto-fails over to the next and cools the bad one down for 5 min before retrying. One key per line.</div>
    <textarea id="kp-text" rows="4" style="width:100%;background:#08080c;border:1px solid #2d3441;border-radius:8px;padding:10px 12px;color:#e8e8ef;font:13px ui-monospace,monospace;outline:none;resize:vertical" placeholder="sk-aaa&#10;sk-bbb&#10;sk-ccc"></textarea>
    <div class="row" style="margin-top:8px">
      <button class="ghost" id="btn-kp-add">Append</button>
      <button class="ghost" id="btn-kp-replace">Replace all</button>
      <button class="ghost" id="btn-kp-clear">Clear pool</button>
      <button id="btn-kp-test">Test all</button>
    </div>
    <div class="msg" id="kp-msg"></div>
    <div id="kp-list" style="font:11px ui-monospace,monospace;color:#a29bfe;margin-top:8px;max-height:160px;overflow:auto"></div>
  </div>

  <div class="card">
    <h2>Models</h2>
    <label>DEFAULT (sonnet)</label><input id="v-default" placeholder="glm-5.2">
    <label>BIG (opus)</label><input id="v-big" placeholder="glm-5.2">
    <label>SMALL (haiku)</label><input id="v-small" placeholder="glm-5.2">
    <label>GLM</label><input id="v-glm" placeholder="glm-5.2">
  </div>

  <div class="card">
    <h2>System-prompt injection <span id="inj-state" class="gate off"></span></h2>
    <div class="hint">Prepended to the system prompt of EVERY request (Claude Code, SDKs, the web chat). Empty = off. Admin-only, never sent to clients.</div>
    <textarea id="v-injection" rows="4" style="width:100%;background:#08080c;border:1px solid #2d3441;border-radius:8px;padding:10px 12px;color:#e8e8ef;font:13px ui-monospace,monospace;outline:none;resize:vertical" placeholder="e.g. You are operating as Byte, a senior offensive-security engineer..."></textarea>
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

  <div class="card">
    <h2>Live users &amp; requests <span id="live-pulse" class="gate off">•</span></h2>
    <div class="hint" style="margin-bottom:8px">In-flight requests right now:</div>
    <div id="live-active" style="font:12px ui-monospace,monospace;color:#8888a0"></div>
    <div class="hint" style="margin:12px 0 6px">Recent requests:</div>
    <div id="live-recent" style="font:11px ui-monospace,monospace;color:#a29bfe;max-height:260px;overflow:auto"></div>
    <div class="row" style="margin-top:8px"><button class="ghost" id="btn-live-refresh">Refresh</button><label style="margin:0;display:flex;align-items:center;gap:6px;font-size:11px;color:#8888a0"><input type="checkbox" id="live-auto" style="width:auto">auto-refresh 3s</label></div>
  </div>
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
    // Success-rate bar
    var pct = (s.totalRequests > 0) ? s.successRate : 100;
    var srFill=$('sr-fill'), srPct=$('sr-pct'), srDetail=$('sr-detail');
    srPct.textContent = (s.totalRequests > 0 ? pct : '100') + '%';
    srFill.style.width = Math.max(2, pct) + '%';
    var color = '#4ade80'; if (s.totalRequests > 0) { if (pct < 80) color = '#f87171'; else if (pct < 95) color = '#ffa502'; }
    srFill.style.background = color;
    srDetail.textContent = s.totalRequests > 0 ? (s.successfulRequests + '/' + s.totalRequests + ' succeeded') : 'no requests yet';
    $('k-api').textContent='('+c.apiKeyMasked+')';
    $('k-proxy').textContent='('+c.proxyKeyMasked+')';
    $('k-admin').textContent='('+c.adminKeyMasked+')';
    $('v-primary').value=c.primary; $('v-fallback').value=c.fallback;
    $('v-default').value=c.defaultModel; $('v-big').value=c.bigModel;
    $('v-small').value=c.smallModel; $('v-glm').value=c.glmModel;
    $('v-api').value=''; $('v-proxy').value=''; $('v-admin').value='';
    // key pool render
    var kp=c.apiKeys||[];
    $('kp-count').className='gate '+(kp.length?'on':'off');
    $('kp-count').textContent=kp.length+' key'+(kp.length===1?'':'s');
    $('kp-list').innerHTML=kp.length?kp.map(function(k){
      var cls=k.bad?'color:#f87171':'color:#4ade80';
      var tag=k.bad?' (bad'+(k.lastStatus?(' '+k.lastStatus):'')+(k.fails?(', '+k.fails+'x'):'')+')':' (ok)';
      return '<div style="padding:2px 0;'+cls+'">'+k.masked+tag+'</div>';
    }).join(''):'<div style="color:#55556a">pool empty — using single API KEY</div>';
    // injection: populate field but don't overwrite if the user is mid-edit
    var inj=$('v-injection');
    if(!inj.dataset.touched) inj.value=c.injection||'';
    var is=$('inj-state');
    if(c.injection&&c.injection.trim()){ is.className='gate on'; is.textContent='ON'; } else { is.className='gate off'; is.textContent='OFF'; }
  }
  function refresh(){ fetch('/admin/api/config',{headers:hdr()}).then(function(r){return r.json()}).then(render).catch(function(){}); }

  document.querySelectorAll('[data-show]').forEach(function(b){
    b.onclick=function(){ var i=$(b.getAttribute('data-show')); i.type=i.type==='password'?'text':'password'; };
  });

  $('v-injection').addEventListener('input',function(){ this.dataset.touched='1'; });

  // ─── Key pool ───
  function kpMsg(cls,txt){ $('kp-msg').className='msg '+cls; $('kp-msg').textContent=txt; }
  function kpSend(replace){
    var txt=$('kp-text').value;
    if(!txt.trim()){ kpMsg('bad','paste keys first'); return; }
    kpMsg('dim','importing…');
    fetch('/admin/api/keys',{method:'POST',headers:hdr(),body:JSON.stringify({keys:txt,replace:!!replace})}).then(function(r){return r.json()}).then(function(j){
      if(j.ok){ kpMsg('ok','imported '+j.added+' → pool '+j.pool); $('kp-text').value=''; refresh(); }
      else kpMsg('bad','failed');
    }).catch(function(e){ kpMsg('bad',''+e); });
  }
  $('btn-kp-add').onclick=function(){ kpSend(false); };
  $('btn-kp-replace').onclick=function(){ kpSend(true); };
  $('btn-kp-clear').onclick=function(){
    fetch('/admin/api/config',{method:'POST',headers:hdr(),body:JSON.stringify({config:{apiKeys:[]}})}).then(function(r){return r.json()}).then(function(){ kpMsg('ok','pool cleared'); refresh(); });
  };
  $('btn-kp-test').onclick=function(){
    kpMsg('dim','testing all keys…');
    fetch('/admin/api/keys/test',{method:'POST',headers:hdr(),body:'{}'}).then(function(r){return r.json()}).then(function(j){
      var ok=(j.results||[]).filter(function(x){return x.ok}).length;
      kpMsg(ok===j.results.length?'ok':'bad',ok+'/'+j.results.length+' healthy');
      refresh();
    }).catch(function(e){ kpMsg('bad',''+e); });
  };

  $('btn-save').onclick=function(){
    var cfg={};
    if($('v-api').value.trim())cfg.apiKey=$('v-api').value.trim();
    cfg.primary=$('v-primary').value.trim(); cfg.fallback=$('v-fallback').value.trim();
    cfg.defaultModel=$('v-default').value.trim(); cfg.bigModel=$('v-big').value.trim();
    cfg.smallModel=$('v-small').value.trim(); cfg.glmModel=$('v-glm').value.trim();
    if($('v-proxy').value!=='')cfg.proxyKey=$('v-proxy').value.trim();
    if($('v-admin').value.trim()){ cfg.adminKey=$('v-admin').value.trim(); pw=cfg.adminKey; sessionStorage.setItem('admin_pw',pw); }
    cfg.injection=$('v-injection').value;
    $('save-msg').className='msg dim'; $('save-msg').textContent='saving…';
    fetch('/admin/api/config',{method:'POST',headers:hdr(),body:JSON.stringify({config:cfg})}).then(function(r){return r.json()}).then(function(j){
      if(j.ok){ $('save-msg').className='msg ok'; $('save-msg').textContent='saved ✓ (persisted='+(j.persisted? 'yes':'no')+', gate '+(j.gateActive?'ON':'OFF')+', inj '+(j.injectionActive?'ON':'OFF')+')'; refresh(); }
      else { $('save-msg').className='msg bad'; $('save-msg').textContent='failed'; }
    }).catch(function(e){ $('save-msg').className='msg bad'; $('save-msg').textContent=''+e; });
  };

  // ─── Live tab ───
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function fmtAgo(ms){ if(ms<1000)return ms+'ms'; var s=Math.round(ms/1000); return s+'s'; }
  function renderLive(j){
    var act=j.active||[];
    $('live-pulse').className='gate '+(act.length?'on':'off');
    $('live-pulse').textContent=act.length?(act.length+' active'):'idle';
    var ah=act.length?act.map(function(a){
      return '<div style="padding:3px 0;border-bottom:1px solid #1c1c28">'+
        '<span style="color:#4ade80">●</span> '+esc(a.ip||'?')+' → '+esc(a.model||'?')+
        ' <span style="color:#55556a">'+(a.stream?'stream':'non-stream')+'</span>'+
        ' <span style="color:#55556a">'+fmtAgo(a.elapsedMs)+'</span></div>';
    }).join(''):'<div style="color:#55556a">no active requests</div>';
    $('live-active').innerHTML=ah;
    var rec=j.recent||[];
    var rh=rec.length?rec.map(function(r){
      var st=r.ok?'<span style="color:#4ade80">✓</span>':(r.finished?'<span style="color:#f87171">✗</span>':'<span style="color:#ffa502">…</span>');
      return '<div style="padding:4px 0;border-bottom:1px solid #1c1c28">'+
        st+' <span style="color:#8888a0">'+esc(r.ip||'?')+'</span> '+
        '<span style="color:#a29bfe">'+esc(r.model||'?')+'</span>'+
        (r.latencyMs!=null?' <span style="color:#55556a">'+r.latencyMs+'ms</span>':'')+' '+
        (r.stream?'<span style="color:#55556a">stream</span>':'')+'<br>'+
        '<span style="color:#55556a">in:</span> <span style="color:#c0c0d0">'+esc((r.previewIn||'').slice(0,120))+'</span><br>'+
        (r.previewOut?'<span style="color:#55556a">out:</span> <span style="color:#c0c0d0">'+esc((r.previewOut||'').slice(0,160))+'</span><br>':'')+
        '</div>';
    }).join(''):'<div style="color:#55556a">no requests yet</div>';
    $('live-recent').innerHTML=rh;
  }
  function refreshLive(){
    fetch('/admin/api/live',{headers:hdr()}).then(function(r){return r.json()}).then(renderLive).catch(function(){});
  }
  $('btn-live-refresh').onclick=refreshLive;
  var liveTimer=null;
  $('live-auto').onchange=function(){ if(this.checked){ refreshLive(); liveTimer=setInterval(refreshLive,3000); } else if(liveTimer){ clearInterval(liveTimer); liveTimer=null; } };

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

  // ─── Public defaults for the chat page (no secrets) ───
  // Lets the web chat load the admin-set default system prompt + model label
  // without exposing keys. The user can override the prompt per-session.
  if (method === 'GET' && url === '/api/defaults') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      defaultSystemPrompt: INJECTION || '',
      // The identity assertion (GLM-5.2) is always prepended server-side and
      // cannot be turned off by the user; expose it so the UI can show it.
      identityPrompt: IDENTITY_ASSERTION,
      model: DEFAULT_MODEL,
    }));
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
          apiKeys: c.apiKeys.map(k => ({ masked: mask(k), bad: !!(keyHealth.get(k) && keyHealth.get(k).badAt), fails: (keyHealth.get(k)||{}).fails||0, lastStatus: (keyHealth.get(k)||{}).lastStatus })),
          primary: c.primary, fallback: c.fallback,
          defaultModel: c.defaultModel, bigModel: c.bigModel,
          smallModel: c.smallModel, glmModel: c.glmModel,
          proxyKeyMasked: c.proxyKey ? mask(c.proxyKey) : '(public — no gate)',
          adminKeyMasked: mask(c.adminKey),
          injection: c.injection,
          gateActive: !!c.proxyKey,
        },
        stats: {
          totalRequests: metrics.totalRequests,
          successfulRequests: metrics.successfulRequests,
          failedRequests: metrics.failedRequests,
          successRate: metrics.totalRequests > 0
            ? Math.round((metrics.successfulRequests / metrics.totalRequests) * 1000) / 10
            : 100,
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
      if (Array.isArray(patch.apiKeys)) API_KEYS = patch.apiKeys.map(s => String(s).trim()).filter(Boolean); // [] clears the pool
      if (typeof patch.primary === 'string' && patch.primary.trim()) UPSTREAM_PRIMARY = patch.primary.trim();
      if (typeof patch.fallback === 'string' && patch.fallback.trim()) UPSTREAM_FALLBACK = patch.fallback.trim();
      if (typeof patch.defaultModel === 'string' && patch.defaultModel.trim()) DEFAULT_MODEL = patch.defaultModel.trim();
      if (typeof patch.bigModel === 'string' && patch.bigModel.trim()) BIG_MODEL = patch.bigModel.trim();
      if (typeof patch.smallModel === 'string' && patch.smallModel.trim()) SMALL_MODEL = patch.smallModel.trim();
      if (typeof patch.glmModel === 'string' && patch.glmModel.trim()) GLM_MODEL = patch.glmModel.trim();
      if (typeof patch.proxyKey === 'string') PROXY_KEY = patch.proxyKey.trim(); // '' clears the gate
      if (typeof patch.adminKey === 'string' && patch.adminKey.trim()) ADMIN_KEY = patch.adminKey.trim();
      if (typeof patch.injection === 'string') INJECTION = patch.injection; // '' clears it
      const saved = saveRuntimeConfig(currentConfig());
      log('ADMIN', 'config updated (persisted=' + saved + ', keys=' + API_KEYS.length + ')');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, persisted: saved, gateActive: !!PROXY_KEY, injectionActive: !!INJECTION.trim(), keyCount: API_KEYS.length }));
      return;
    }

    // POST keys — bulk import keys (newline/comma/space separated), appended
    // to the pool (deduped). Use { replace: true } to overwrite.
    if (route === 'keys' && method === 'POST') {
      const text = String(bodyObj.keys || '');
      const incoming = text.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
      const replace = !!bodyObj.replace;
      const set = new Set(replace ? [] : API_KEYS);
      for (const k of incoming) set.add(k);
      API_KEYS = Array.from(set);
      // prune health map of removed keys
      for (const k of keyHealth.keys()) if (!API_KEYS.includes(k)) keyHealth.delete(k);
      const saved = saveRuntimeConfig(currentConfig());
      log('ADMIN', 'keys imported: +' + incoming.length + ' (pool=' + API_KEYS.length + ')');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, added: incoming.length, pool: API_KEYS.length, persisted: saved }));
      return;
    }

    // POST keys/test-all — probe every key in the pool, return per-key health.
    if (route === 'keys/test' && method === 'POST') {
      const results = [];
      for (const k of API_KEYS) {
        try {
          const r = await upstreamFetch(UPSTREAM_PRIMARY.replace(/\/+$/, '') + UPSTREAM_PATH, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${k}` },
            body: JSON.stringify({ model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'ping' }], max_tokens: 4, stream: false }),
          });
          const eb = await new Promise(rr => { const ch=[]; r.on('data',c=>ch.push(c)); r.on('end',()=>rr(Buffer.concat(ch).toString())); });
          if (r.statusCode >= 200 && r.statusCode < 300) { markKeyGood(k); results.push({ masked: mask(k), ok: true, status: r.statusCode }); }
          else { if (isBadKeyStatus(r.statusCode, eb)) markKeyBad(k, r.statusCode); results.push({ masked: mask(k), ok: false, status: r.statusCode, body: eb.slice(0,160) }); }
        } catch (e) { results.push({ masked: mask(k), ok: false, error: e.message }); }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, results }));
      return;
    }

    // GET live — in-flight requests + rolling message log (admin Live tab).
    if (route === 'live' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...liveSnapshot() }));
      return;
    }

    // GET log — full message log with content (admin Messages tab).
    if (route === 'log' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, entries: live.recent.slice().reverse() }));
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
    const sr = metrics.totalRequests > 0
      ? Math.round((metrics.successfulRequests / metrics.totalRequests) * 1000) / 10
      : 100;
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
      // Public success metrics (not sensitive — just counts + a percentage).
      // Lets the chat page show a live success-rate badge without admin auth.
      stats: {
        totalRequests: metrics.totalRequests,
        successfulRequests: metrics.successfulRequests,
        failedRequests: metrics.failedRequests,
        successRate: sr,
        avgLatencyMs: Math.round(metrics.avgLatencyMs),
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
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().replace(/,.*/, '').trim();
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch {
      res.writeHead(400);
      res.end('bad json');
      return;
    }

    const requestModel = body.model || '';
    // The chat page tags its requests so we know to use the user's system
    // prompt field directly (it already carries the admin default).
    const fromChat = !!(body.metadata && body.metadata.source === 'bytechat');
    const oaiPayload = anthropicToOpenAI(body, fromChat);
    const wantStream = !!body.stream;

    // Capture a short preview of the latest user turn for the admin log.
    let previewIn = '';
    try {
      const msgs = body.messages || [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const t = typeof msgs[i].content === 'string' ? msgs[i].content : blocksToText(msgs[i].content);
        if (msgs[i].role === 'user' && t && t.trim()) { previewIn = t.trim(); break; }
      }
    } catch {}
    const reqId = msgId();
    liveStart(reqId, ip, requestModel || oaiPayload.model, '/v1/messages', wantStream, previewIn);

    log('REQ', `${C.green}${requestModel}${C.reset} → ${C.yellow}${oaiPayload.model}${C.reset}` +
      ` | msgs=${oaiPayload.messages.length} stream=${wantStream}`);

    // ─── NON-STREAMING ───
    if (!wantStream) {
      oaiPayload.stream = false;
      const result = await fetchUpstream(oaiPayload, false);
      if (!result) {
        metrics.failedRequests++;
        liveFinish(reqId, false, Date.now() - start, '(upstream failed)');
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
          liveFinish(reqId, false, latency, respText.slice(0, 300));
          log('ERR', `Bad JSON from upstream: ${respText.slice(0, 200)}`);
          res.writeHead(502);
          res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Bad upstream response' } }));
          return;
        }

        recordRequest(oaiPayload.model, latency, true, endpoint);
        const anthropicResp = openAIToAnthropic(oaiResp, requestModel, oaiPayload.model);
        const outPreview = blocksToText(anthropicResp.content);
        liveFinish(reqId, true, latency, outPreview);
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
      liveFinish(reqId, false, Date.now() - start, '(upstream failed)');
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
        // Echo the actual model the proxy routed to (the mapped upstream slug),
        // not the inbound Anthropic-style name the client sent.
        model: oaiPayload.model || requestModel || 'glm-5.2',
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
      liveFinish(reqId, true, latency, totalText);

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
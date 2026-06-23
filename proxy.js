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

// ═══════════════════════════════════════════════════════════════════
//  CONFIG (env-overridable)
// ═══════════════════════════════════════════════════════════════════
const PORT       = parseInt(process.env.PORT || '8787', 10);
const HOST       = process.env.HOST || '0.0.0.0';

// Upstream endpoints — primary and fallback
const UPSTREAM_PRIMARY  = process.env.USEAI_BASE_URL || 'https://api.iamhc.cn';
const UPSTREAM_FALLBACK = process.env.USEAI_FALLBACK_URL || 'https://api.hcnsec.cn';
const UPSTREAM_PATH     = '/v1/chat/completions';
const API_KEY           = process.env.USEAI_API_KEY || 'sk-h8bKEIBwADUKIsLGpuYdDeJ2xVHieyseiLoOGXDetJMv0lg1';

// Model mapping
const DEFAULT_MODEL = process.env.USEAI_MODEL      || 'glm-5.2';
const BIG_MODEL     = process.env.USEAI_BIG_MODEL   || 'claude-opus-4-8';
const SMALL_MODEL   = process.env.USEAI_SMALL_MODEL  || 'gpt-5-mini';
const GLM_MODEL     = process.env.USEAI_GLM_MODEL   || 'glm-5.2';

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
const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const method = req.method || 'GET';

  // ─── CORS ───
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ─── Health ───
  if (url === '/health' || url === '/') {
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
        { id: 'glm-5.2',          object: 'model', created: 1719000000, owned_by: 'zhipu' },
        { id: 'claude-opus-4-8',   object: 'model', created: 1719000000, owned_by: 'anthropic' },
        { id: 'claude-sonnet-4-6', object: 'model', created: 1719000000, owned_by: 'anthropic' },
        { id: 'gpt-5-mini',        object: 'model', created: 1719000000, owned_by: 'openai' },
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
});
# cc-useai-proxy v2.0

Anthropic Messages API ↔ OpenAI chat-completions translation proxy.  
Routes Claude Code traffic through upstream providers with automatic failover.

## Features

- **GLM 5.2** default model routing (Zhipu AI)
- **Claude Opus 4.8** / **Sonnet 4.6** / **GPT-5 Mini** model mapping
- **Anthropic → OpenAI** full message format translation
- **Streaming SSE** passthrough with tool-call parsing
- **Dual upstream** with automatic failover (`api.iamhc.cn` → `api.hcnsec.cn`)
- **Terminal grading** — live system diagnostics at `/terminal` or `/status`
- **Health check** at `/health` for Render/Railway
- **Zero npm dependencies** — pure Node.js

## Quick Start

```bash
node proxy.js
```

Then point Claude Code:
```bash
set ANTHROPIC_BASE_URL=http://localhost:8787
set ANTHROPIC_API_KEY=unused
claude
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/messages` | Anthropic Messages API (Claude Code uses this) |
| POST | `/v1/chat/completions` | OpenAI-native passthrough |
| POST | `/v1/messages/count_tokens` | Token count estimate |
| GET | `/v1/models` | List available models |
| GET | `/health` | Health check |
| GET | `/grade` | JSON diagnostics & grading |
| GET | `/terminal` | ASCII art terminal diagnostics |
| GET | `/status` | Alias for `/terminal` |

## Model Routing

| Claude Code sends | Proxy routes to |
|-------------------|-----------------|
| `*haiku*` | `gpt-5-mini` |
| `*sonnet*` | `glm-5.2` (default) |
| `*opus*` | `claude-opus-4-8` |
| `*glm*` | `glm-5.2` |
| anything else | passthrough / `glm-5.2` |

## Deploy to Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

Uses `render.yaml` blueprint — zero config needed.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8787` | Listen port |
| `USEAI_BASE_URL` | `https://api.iamhc.cn` | Primary upstream |
| `USEAI_FALLBACK_URL` | `https://api.hcnsec.cn` | Fallback upstream |
| `USEAI_API_KEY` | *(built-in)* | API key for upstream |
| `USEAI_MODEL` | `glm-5.2` | Default model |
| `USEAI_BIG_MODEL` | `claude-opus-4-8` | Big/opus model |
| `USEAI_SMALL_MODEL` | `gpt-5-mini` | Small/haiku model |

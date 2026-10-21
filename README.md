# pi-failover

A [pi](https://pi.dev) provider extension that keeps agent runs alive when a model provider runs out of credits or errors. It registers a set of models under the `failover` provider, grouped into **compatibility classes**. When the model in use fails, the request is retried on the next model in the *same class*, wrapping around, so the run never stops when one wallet empties.

The serving backend is always shown in the status bar: `failover: strong-model (example-provider)` when the requested model is serving, or `auto → strong-model (example-provider)` when it differs (including `auto`, which resolves to the first backend of the first set). The line updates on every attempt, so a mid-request failover is visible too.

## How it works

- Models are grouped into `sets` (capability classes: e.g. `opus`, `sonnet`, `coding`, `flash`).
- Each model is selectable as `failover/<name>`, plus a convenience `failover/auto` (first model of the first set).
- On a request that fails *before any content streams* (quota, credits, 403, auth, connection, 5xx), the extension retries the **next model in the same set**, circularly, up to `maxAttempts`.
- **Context-overflow** errors are *not* retried — they pass through so pi can compact the conversation instead.
- **Aborted** requests (you pressed ESC) are *not* retried either — they are forwarded as-is.
- Failover never crosses sets: a model only falls back to peers in its own class.

## Install

```bash
pi install npm:pi-failover            # after publishing
pi install git:github.com/rthadani/pi-failover@v1
pi install ./pi-failover              # local directory
```

Then pick a model in `/model`: `Auto (failover)` or any `Failover · <name>`.

## Configure

Create `~/.pi/agent/failover.json` (or point `FAILOVER_CONFIG` at another path). The file is the source of truth; the built-in default is only a placeholder.

```json
{
  "contextWindow": 200000,
  "maxTokens": 65536,
  "maxAttempts": 6,
  "sets": [
    {
      "name": "opus",
      "models": [
        {
          "name": "strong-model",
          "provider": "example-provider",
          "api": "openai-completions",
          "baseUrl": "https://api.example.com/v1",
          "apiKey": "$YOUR_API_KEY",
          "model": "strong-model",
          "reasoning": true,
          "contextWindow": 1000000,
          "maxTokens": 65536,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "compat": { "supportsUsageInStreaming": false, "maxTokensField": "max_tokens" }
        }
      ]
    }
  ]
}
```

### Backend fields

| Field | Meaning |
|---|---|
| `name` | Unique id; the model is exposed as `failover/<name>`. |
| `provider` | Display/origin provider (informational). |
| `api` | One of `openai-completions`, `openai-responses`, `anthropic-messages`. Match the provider's real API. |
| `baseUrl` | Endpoint for the provider. |
| `apiKey` | `$ENV_VAR` / `${ENV_VAR}` reference, or a literal value. |
| `model` | The actual model id sent to the provider. |
| `contextWindow` / `maxTokens` | Caps used for compaction and output limits. |
| `cost` | Per-1M-token rates (display/telemetry only). |
| `compat` / `thinkingLevelMap` | Optional per-provider compatibility/thinking overrides. |

### Environment

- `FAILOVER_CONFIG` — override the config path (default `~/.pi/agent/failover.json`).
- Provider keys referenced by `apiKey` entries (e.g. `YOUR_API_KEY`).

## Select a model at runtime (subagent API)

The subagent API accepts a `model` argument per spawn, so you can pick a failover class at runtime and override the session default for that one run. Pass `failover/<name>` (provider/id form, not a bare id), where `<name>` is any model name from your `failover.json`:

```ts
// run the implementation agent in the coding class
subagent({ agent: "worker", model: "failover/code-model", task: "..." })

// design/reasoning in the opus class
subagent({ agent: "oracle", model: "failover/strong-model", task: "..." })

// fast, cheap recon in the flash class
subagent({ agent: "scout", model: "failover/fast-model", task: "..." })
```

The model you pass starts that run in its own set, and failover stays circular *within* that set. The entry point for a class is whichever backend that class lists first, so the mapping lives in your own `failover.json` rather than in this document.

Omit `model` to inherit the session model. This is a normal per-spawn override — no extra permission or config needed.

## Notes

- If you previously installed a personal copy of `failover.ts` under `~/.pi/agent/extensions/`, remove it after installing this package to avoid registering the `failover` provider twice.
- A backend whose `apiKey` resolves to empty is skipped automatically.
- Mid-stream failures (after content has started) cannot be retracted; those surface as errors and the *next* request fails over.

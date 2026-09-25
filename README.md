# pi-failover

A [pi](https://pi.dev) provider extension that keeps agent runs alive when a model provider runs out of credits or errors. It registers a set of models under the `failover` provider, grouped into **compatibility classes**. When the model in use fails, the request is retried on the next model in the *same class*, wrapping around, so the run never stops when one wallet empties.

## How it works

- Models are grouped into `sets` (capability classes: e.g. `opus`, `sonnet`, `coding`, `flash`).
- Each model is selectable as `failover/<name>`, plus a convenience `failover/auto` (first model of the first set).
- On a request that fails *before any content streams* (quota, credits, 403, auth, connection, 5xx), the extension retries the **next model in the same set**, circularly, up to `maxAttempts`.
- **Context-overflow** errors are *not* retried — they pass through so pi can compact the conversation instead.
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
          "name": "glm-5.3",
          "provider": "zai",
          "api": "openai-completions",
          "baseUrl": "https://api.z.ai/api/coding/paas/v4",
          "apiKey": "$ZAI_API_KEY",
          "model": "glm-5.3",
          "reasoning": true,
          "contextWindow": 1000000,
          "maxTokens": 65536,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "compat": { "thinkingFormat": "zai", "zaiToolStream": true, "supportsDeveloperRole": false }
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
| `apiKey` | `$ENV_VAR` / `${ENV_VAR}` reference, literal, or `!command`. |
| `model` | The actual model id sent to the provider. |
| `contextWindow` / `maxTokens` | Caps used for compaction and output limits. |
| `cost` | Per-1M-token rates (display/telemetry only). |
| `compat` / `thinkingLevelMap` | Optional per-provider compatibility/thinking overrides. |

### Environment

- `FAILOVER_CONFIG` — override the config path (default `~/.pi/agent/failover.json`).
- Provider keys referenced by `apiKey` entries (e.g. `DEEPSEEK_API_KEY`, `ZAI_API_KEY`).

## Select a model at runtime (subagent API)

The subagent API accepts a `model` argument per spawn, so you can pick a failover class at runtime and override the session default for that one run. Pass `failover/<name>` (provider/id form, not a bare id), where `<name>` is any model name from your `failover.json`:

```ts
// run the implementation agent in the coding class
subagent({ agent: "worker", model: "failover/kimi-k2.7-code", task: "..." })

// design/reasoning in the opus class
subagent({ agent: "oracle", model: "failover/glm-5.3", task: "..." })

// fast, cheap recon in the flash class
subagent({ agent: "scout", model: "failover/glm-5.3-flash", task: "..." })
```

The model you pass starts that run in its own set, and failover stays circular *within* that set. The usual entry per class is the first model of the set:

- `opus` → `failover/glm-5.3`
- `sonnet` → `failover/deepseek-v4-pro`
- `coding` → `failover/kimi-k2.7-code`
- `flash` → `failover/glm-5.3-flash`

Omit `model` to inherit the session model. This is a normal per-spawn override — no extra permission or config needed.

## Notes

- If you previously installed a personal copy of `failover.ts` under `~/.pi/agent/extensions/`, remove it after installing this package to avoid registering the `failover` provider twice.
- A backend whose `apiKey` resolves to empty is skipped automatically.
- Mid-stream failures (after content has started) cannot be retracted; those surface as errors and the *next* request fails over.

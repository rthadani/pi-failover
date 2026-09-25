/**
 * Failover provider for pi.
 *
 * Registers a set of models under the `failover` provider, grouped into
 * "compatibility sets". When a model's request fails before any content
 * streams (quota, credits, auth, connection, 5xx, ...), the request is
 * retried on the NEXT model in the same set, wrapping around, up to
 * `maxAttempts` total attempts (default: 2 full passes of the set).
 * Context-overflow errors are NOT retried: they pass through so pi can
 * compact instead.
 *
 * Selecting a model:
 *   - `failover/auto`            → first model of the first set (convenience)
 *   - `failover/<model-name>`    → that model, failing over within its set
 *
 * Config (~/.pi/agent/failover.json):
 *   {
 *     "contextWindow": 200000, "maxTokens": 65536, "maxAttempts": 4,
 *     "sets": [
 *       { "name": "primary", "models": [
 *           { "name": "deepseek-v4-pro", "provider": "deepseek",
 *             "api": "openai-completions", "baseUrl": "https://api.deepseek.com",
 *             "apiKey": "$DEEPSEEK_API_KEY", "model": "deepseek-v4-pro",
 *             "contextWindow": 1000000, "maxTokens": 65536,
 *             "cost": {"input":1.74,"output":3.48,"cacheRead":0.145,"cacheWrite":0},
 *             "thinkingLevelMap": {"minimal":"high","low":"high","medium":"high","high":"high","xhigh":"max"},
 *             "compat": {"requiresReasoningContentOnAssistantMessages":true,"thinkingFormat":"deepseek"} },
 *           { ...next compatible model... }
 *       ]},
 *       { "name": "budget", "models": [ { ... } ] }
 *     ]
 *   }
 */

import {
  type Api,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  anthropicMessagesApi,
  createAssistantMessageEventStream,
  type Model,
  openAICompletionsApi,
  openAIResponsesApi,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type BackendApi = "openai-completions" | "openai-responses" | "anthropic-messages";

interface Backend {
  name: string;
  provider?: string;
  api: BackendApi;
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: Model<Api>["cost"];
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  compat?: Record<string, unknown>;
}

interface FailoverSet {
  name: string;
  models: Backend[];
}

interface FailoverConfig {
  contextWindow?: number;
  maxTokens?: number;
  maxAttempts?: number;
  sets: FailoverSet[];
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "failover.json");

const DEFAULT_CONFIG: FailoverConfig = {
  contextWindow: 200000,
  maxTokens: 65536,
  sets: [
    {
      name: "primary",
      models: [
        {
          name: "deepseek-v4-pro",
          provider: "deepseek",
          api: "openai-completions",
          baseUrl: "https://api.deepseek.com",
          apiKey: "$DEEPSEEK_API_KEY",
          model: "deepseek-v4-pro",
          reasoning: true,
          contextWindow: 1000000,
          maxTokens: 65536,
          cost: { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 },
          thinkingLevelMap: { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max" },
          compat: { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" },
        },
        {
          name: "glm-5.3-flash",
          provider: "zai",
          api: "openai-completions",
          baseUrl: "https://api.z.ai/api/coding/paas/v4",
          apiKey: "$ZAI_API_KEY",
          model: "glm-5.3-flash",
          reasoning: true,
          contextWindow: 200000,
          maxTokens: 65536,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat: { thinkingFormat: "zai", zaiToolStream: true, supportsDeveloperRole: false },
        },
      ],
    },
  ],
};

function loadConfig(): FailoverConfig {
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
      if (raw && Array.isArray(raw.sets) && raw.sets.length > 0) {
        return { ...DEFAULT_CONFIG, ...raw };
      }
    } catch (e) {
      console.warn(`[failover] could not parse ${CONFIG_PATH}: ${(e as Error).message}`);
    }
  }
  return DEFAULT_CONFIG;
}

function resolveApiKey(ref: string): string {
  const m = /^\$([A-Z0-9_]+)$/i.exec(ref) ?? /^\$\{([A-Z0-9_]+)\}$/i.exec(ref);
  if (m) return process.env[m[1]] ?? "";
  return ref;
}

/** Context-overflow errors should NOT be retried on another model; let pi compact instead. */
function isContextOverflow(message: string): boolean {
  return /context_length_exceeded|context.{0,20}(length|window|limit)|maximum.{0,20}(context|tokens)|too (long|many tokens)/i.test(
    message,
  );
}

function buildInnerModel(model: Model<Api>, b: Backend): Model<Api> {
  return {
    ...model,
    id: b.model,
    name: b.name ?? b.model,
    provider: (b.provider ?? "failover") as Model<Api>["provider"],
    api: b.api,
    baseUrl: b.baseUrl,
    reasoning: b.reasoning ?? true,
    input: b.input ?? ["text"],
    cost: b.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: b.contextWindow ?? model.contextWindow,
    maxTokens: b.maxTokens ?? model.maxTokens,
    ...(b.thinkingLevelMap ? { thinkingLevelMap: b.thinkingLevelMap as Model<Api>["thinkingLevelMap"] } : {}),
    ...(b.compat ? { compat: b.compat as Model<Api>["compat"] } : {}),
  };
}

function innerStream(
  api: BackendApi,
  model: Model<Api>,
  context: TranscriptContext,
  opts: SimpleStreamOptions,
): AssistantMessageEventStream {
  switch (api) {
    case "anthropic-messages":
      return anthropicMessagesApi().streamSimple(model as Model<"anthropic-messages">, context, opts);
    case "openai-responses":
      return openAIResponsesApi().streamSimple(model as Model<"openai-responses">, context, opts);
    case "openai-completions":
    default:
      return openAICompletionsApi().streamSimple(model as Model<"openai-completions">, context, opts);
  }
}

function synthError(model: Model<Api>, errorMessage: string): AssistantMessageEvent {
  return {
    type: "error",
    reason: "error",
    error: {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage,
      timestamp: Date.now(),
    },
  };
}

type AttemptResult =
  | { status: "done" }
  | { status: "fallthrough"; message: string }
  | { status: "fatal"; event: AssistantMessageEvent };

function streamFailover(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const outer = createAssistantMessageEventStream();
  const config = loadConfig();
  const { ring, startIndex } = resolveRing(config, model.id);
  const total = ring.length;
  const maxAttempts = config.maxAttempts ?? Math.max(total * 2, 2);

  (async () => {
    if (total === 0) {
      outer.push(synthError(model, "No failover backends configured"));
      outer.end();
      return;
    }

    let lastMessage = "No backends configured";
    let lastFatal: AssistantMessageEvent | null = null;

    for (let i = 0; i < maxAttempts; i++) {
      const backend = ring[(startIndex + i) % total];
      const apiKey = resolveApiKey(backend.apiKey);
      if (!apiKey) {
        lastMessage = `no API key for "${backend.name}" (${backend.apiKey})`;
        continue;
      }

      const innerModel = buildInnerModel(model, backend);
      const opts: SimpleStreamOptions = { ...options, apiKey };

      const result = await attempt(innerModel, backend, context, opts, outer);
      if (result.status === "done") return;

      if (result.status === "fatal") {
        lastFatal = result.event;
        lastMessage = result.message;
        break; // don't loop on non-retryable errors
      }

      lastMessage = result.message;
      console.warn(
        `[failover] ${backend.name} failed (${result.message}); trying next backend (${i + 1}/${maxAttempts})`,
      );
    }

    if (lastFatal) {
      outer.push(lastFatal);
    } else {
      outer.push(
        synthError(model, `All failover backends failed after ${maxAttempts} attempts. Last error: ${lastMessage}`),
      );
    }
    outer.end();
  })();

  return outer;
}

/**
 * The model being called is the "current model in use". Find the compatibility
 * set containing it and start the circular retry at that model, so failure
 * falls through to the next model in the same set (never across sets).
 */
function resolveRing(config: FailoverConfig, modelId: string): { ring: Backend[]; startIndex: number } {
  for (const set of config.sets) {
    const idx = set.models.findIndex((b) => b.name === modelId);
    if (idx >= 0) return { ring: set.models, startIndex: idx };
  }
  // "auto" or unknown id → first set, first model
  const firstSet = config.sets[0];
  return { ring: firstSet?.models ?? [], startIndex: 0 };
}

async function attempt(
  model: Model<Api>,
  backend: Backend,
  context: TranscriptContext,
  opts: SimpleStreamOptions,
  outer: AssistantMessageEventStream,
): Promise<AttemptResult> {
  let inner: AssistantMessageEventStream;
  try {
    inner = innerStream(backend.api, model, context, opts);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    return isContextOverflow(msg)
      ? { status: "fatal", event: synthError(model, msg) }
      : { status: "fallthrough", message: msg };
  }

  let started = false;
  try {
    for await (const event of inner) {
      if (!started) {
        if (event.type === "start") {
          started = true;
        } else if (event.type === "error") {
          const msg = event.error?.errorMessage ?? "Unknown error";
          return isContextOverflow(msg)
            ? { status: "fatal", event }
            : { status: "fallthrough", message: msg };
        } else {
          started = true;
        }
      }
      outer.push(event);
    }
    if (started) outer.end();
    return { status: "done" };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (started) {
      // Mid-stream failure: content already streamed, cannot fail over.
      outer.push(synthError(model, msg));
      outer.end();
      return { status: "done" };
    }
    return isContextOverflow(msg)
      ? { status: "fatal", event: synthError(model, msg) }
      : { status: "fallthrough", message: msg };
  }
}

function toModelConfig(b: Backend, id: string, name: string, config: FailoverConfig) {
  return {
    id,
    name,
    api: b.api,
    baseUrl: b.baseUrl,
    reasoning: b.reasoning ?? true,
    input: b.input ?? ["text"],
    cost: b.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: b.contextWindow ?? config.contextWindow ?? 200000,
    maxTokens: b.maxTokens ?? config.maxTokens ?? 65536,
    ...(b.thinkingLevelMap ? { thinkingLevelMap: b.thinkingLevelMap } : {}),
  };
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const seen = new Set<string>();
  const allBackends = config.sets
    .flatMap((s) => s.models)
    .filter((b) => {
      if (seen.has(b.name)) return false;
      seen.add(b.name);
      return true;
    });
  const first = allBackends[0];

  const models = [];
  if (first) {
    models.push(toModelConfig(first, "auto", "Auto (failover)", config));
  }
  for (const backend of allBackends) {
    models.push(toModelConfig(backend, backend.name, `Failover · ${backend.name}`, config));
  }

  pi.registerProvider("failover", {
    name: "Failover",
    baseUrl: first?.baseUrl ?? "https://example.com",
    apiKey: first?.apiKey ?? "$DEEPSEEK_API_KEY",
    api: "openai-completions",
    models,
    streamSimple: streamFailover,
  });
}

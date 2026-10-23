/**
 * Failover provider for pi.
 *
 * Registers a set of models under the `failover` provider, grouped into
 * "compatibility sets". When a model's request fails before any content
 * streams (quota, credits, auth, connection, 5xx, ...), the request is
 * retried on the NEXT model in the same set, wrapping around, up to
 * `maxAttempts` total attempts (default: 2 full passes of the set).
 * Context-overflow errors are NOT retried: they pass through so pi can
 * compact instead. Aborted requests (the user pressed ESC) are NOT retried
 * either; they are forwarded as-is.
 *
 * Selecting a model:
 *   - `failover/auto`            → the configured `default` (set name or model
 *                                  name), falling back to the first model of the
 *                                  first set when unset or unresolvable
 *   - `failover/<model-name>`    → that model, failing over within its set
 *
 * Config (~/.pi/agent/failover.json):
 *   {
 *     "contextWindow": 200000, "maxTokens": 65536, "maxAttempts": 4,
 *     "default": "primary",  // set or model name that `auto` resolves to
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
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let statusUi: ExtensionUIContext | null = null;
// Mirror of pi's session-mode union; the package root does not re-export this type.
let statusMode: "tui" | "rpc" | "json" | "print" | null = null;

// Delegated backends (claude-bridge) need another extension's streamSimple.
// pi dispatches a model to a provider by `model.api === provider.api`, so those
// stream functions live in the model registry, not pi-ai's api registry. The
// registry is available from session_start in normal sessions.
// The map is keyed by session id because pi-subagents runs child sessions
// in-process, so a child's shutdown must not clear the parent's registry.
type DelegateStreamSimple = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;
type DelegateRegistry = { getProvider(id: string): { streamSimple?: DelegateStreamSimple } | undefined };
const liveRegistries = new Map<string, DelegateRegistry>();

// "claude-bridge" is not an HTTP protocol: it delegates the turn to the pi
// provider with that id (the pi-claude-bridge extension), whose own
// streamSimple does the work. The backend's api doubles as the provider id.
type BackendApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "claude-bridge";

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
  default?: string;
  sets: FailoverSet[];
}

// The roster reads the same failover.json as the provider types above, but only
// the name/input/cost/thinkingLevelMap fields, so it keeps its own Roster*
// family rather than widening FailoverSet/FailoverConfig.
interface RosterModel {
  name: string;
  input?: ("text" | "image")[];
  cost?: { input?: number; output?: number };
  thinkingLevelMap?: Record<string, string>;
}

interface RosterSet {
  name: string;
  models: RosterModel[];
}

export interface RosterConfig {
  sets: RosterSet[];
}

export interface RosterState {
  /** The rendered roster section, or "" when the config could not be read. */
  section: string;
  /** The resolved config path. */
  path: string;
  /** File mtime in ms, or null when the file is missing. */
  mtimeMs: number | null;
  /** Why the roster is disabled, or null when a section was rendered. */
  disabled: string | null;
}

const ROSTER_HEADER = [
  "## Model roster (from failover.json)",
  "`failover/<name>` resolves to the first set containing the name; requests fail",
  "over circularly within that class and never cross classes. Image requests skip",
  "backends without image support.",
].join("\n");

/** Absent `input` means text-only; an `image` entry means text+image. */
function modalityLabel(model: RosterModel): string {
  return (model.input ?? ["text"]).includes("image") ? "text+image" : "text";
}

function formatModel(model: RosterModel): string {
  const parts: string[] = [];
  if (model.cost && typeof model.cost.input === "number" && typeof model.cost.output === "number") {
    parts.push(`$${model.cost.input}/$${model.cost.output}`);
  }
  parts.push(modalityLabel(model));
  const mappedEffort = model.thinkingLevelMap?.["xhigh"];
  if (mappedEffort) parts.push(`:xhigh->${mappedEffort}`);
  return `${model.name} (${parts.join(", ")})`;
}

/**
 * Render the roster section from a parsed config. Pure: no runtime imports, no
 * I/O, so it can be exercised offline. A model that appears in more than one
 * set is printed with full details the first time and as a bare name after.
 */
export function renderRoster(config: RosterConfig): string {
  if (!config?.sets?.length) return "";
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const set of config.sets) {
    if (set === null || typeof set !== "object") continue;
    if (typeof set.name !== "string" || set.name.trim() === "") continue;
    const models = Array.isArray(set.models) ? set.models : [];
    if (models.length === 0) continue;
    const members: string[] = [];
    for (const model of models) {
      if (model === null || typeof model !== "object") continue;
      if (typeof model.name !== "string" || model.name.trim() === "") continue;
      if (seen.has(model.name)) {
        members.push(model.name);
        continue;
      }
      seen.add(model.name);
      members.push(formatModel(model));
    }
    if (members.length === 0) continue;
    lines.push(`- ${set.name}: ${members.join(" -> ")}`);
  }
  if (lines.length === 0) return "";
  return `${ROSTER_HEADER}\n${lines.join("\n")}`;
}

function configPath(): string {
  return process.env.FAILOVER_CONFIG || join(homedir(), ".pi", "agent", "failover.json");
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildRoster(path: string, mtimeMs: number | null): RosterState {
  if (mtimeMs === null) {
    return { section: "", path, mtimeMs: null, disabled: "config file missing" };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return { section: "", path, mtimeMs, disabled: `unreadable: ${describeError(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { section: "", path, mtimeMs, disabled: `invalid JSON: ${describeError(error)}` };
  }
  const config = parsed as RosterConfig;
  if (!config || !Array.isArray(config.sets) || config.sets.length === 0) {
    return { section: "", path, mtimeMs, disabled: "config has no model sets" };
  }
  let section: string;
  try {
    section = renderRoster(config);
  } catch (error) {
    return { section: "", path, mtimeMs, disabled: `invalid config: ${describeError(error)}` };
  }
  if (!section) {
    return { section: "", path, mtimeMs, disabled: "no models to list" };
  }
  return { section, path, mtimeMs, disabled: null };
}

let cache: RosterState | null = null;

/**
 * Resolve, read, and render the roster, caching the rendered section and only
 * re-reading when the file's mtime changes (or the path changes). Never throws;
 * a broken config yields an empty section with a `disabled` reason.
 */
export function loadRoster(): RosterState {
  const path = configPath();
  const mtimeMs = mtimeOf(path);
  if (cache && cache.path === path && cache.mtimeMs === mtimeMs) {
    return cache;
  }
  cache = buildRoster(path, mtimeMs);
  return cache;
}

function rosterReport(state: RosterState): string {
  const meta = `config: ${state.path}\nmtime: ${state.mtimeMs ?? "missing"}`;
  return state.section ? `${state.section}\n${meta}` : `roster disabled: ${state.disabled}\n${meta}`;
}

// Load once at extension load time so a broken config or missing file warns
// immediately, exactly once.
const initialRoster = loadRoster();
if (initialRoster.disabled) {
  console.warn(`[failover] roster disabled: ${initialRoster.disabled}`);
}
if (process.env.ROSTER_DEBUG) {
  console.log(`[failover]\n${rosterReport(initialRoster)}`);
}

/** Only the TUI renders a status bar; rpc/json/print sessions silently skip. */
function setStatus(text: string): void {
  if (statusUi && statusMode === "tui") statusUi.setStatus("failover", text);
}

/** `failover: <name> (<provider>)` when the requested model is serving, else `<requested> → <name> (<provider>)`. */
function statusText(requested: string, backend: Backend): string {
  const serving = `${backend.name} (${backend.provider ?? "failover"})`;
  return backend.name === requested ? `failover: ${serving}` : `${requested} → ${serving}`;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "failover.json");

/**
 * pi dispatches a model to an extension's streamSimple only when the model's
 * api equals the provider's api (the gate is `model.api === extension.api`;
 * see pi-coding-agent/dist/core/provider-composer.js). Every failover model
 * must therefore advertise this api, or pi bypasses this extension and
 * failover/auto silently loses its rotation. The per-backend protocol stays in
 * Backend.api and is applied by buildInnerModel for the real HTTP call.
 */
const PROVIDER_API = "openai-completions";

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
  const configPath = process.env.FAILOVER_CONFIG || CONFIG_PATH;
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf8"));
      if (raw && Array.isArray(raw.sets) && raw.sets.length > 0) {
        return { ...DEFAULT_CONFIG, ...raw };
      }
    } catch (e) {
      console.warn(`[failover] could not parse ${configPath}: ${(e as Error).message}`);
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

/** True when any transcript message carries an image block (screenshots land in tool results). */
function needsVision(context: TranscriptContext): boolean {
  return context.messages.some((message) => {
    const content = message.content;
    if (typeof content === "string") return false;
    return content.some((block) => block.type === "image");
  });
}

/** True when the backend advertises image input (an absent `input` field means text-only). */
function supportsVision(b: Backend): boolean {
  return (b.input ?? ["text"]).includes("image");
}

/**
 * An aborted request is terminal: the user pressed ESC, so retrying it on the
 * next backend would just re-run a cancelled request. pi-ai surfaces the
 * abort either as an error event with reason "aborted" or as a thrown
 * "Request was aborted" / "Request aborted".
 *
 * The structured `event.reason === "aborted"` branch in attempt() is the
 * PRIMARY abort path: pi-ai turns provider failures into error events rather
 * than throwing them, so the text match below only covers the throw path.
 * Match the request-abort phrase only, so an unrelated provider error whose
 * body happens to contain the word "aborted" still rotates.
 */
function isAborted(message: string, signal?: AbortSignal): boolean {
  return signal?.aborted === true || /\brequest (?:was )?aborted\b/i.test(message);
}

/**
 * Shared classification for a thrown failure: an abort and a context
 * overflow are terminal, anything else is retryable on the next backend.
 */
function classifyFailure(model: Model<Api>, msg: string, signal?: AbortSignal): AttemptResult {
  if (isAborted(msg, signal)) return { status: "fatal", event: synthError(model, msg, "aborted") };
  if (isContextOverflow(msg)) return { status: "fatal", event: synthError(model, msg) };
  return { status: "fallthrough", message: msg };
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
      return openAICompletionsApi().streamSimple(model as Model<"openai-completions">, context, opts);
    case "claude-bridge": {
      // Delegated: use the first live session that has this provider registered.
      // Throwing when none does is the cheap failure path: attempt() classifies it
      // as a fallthrough, so an unregistered bridge rotates to the next backend
      // instead of failing the run.
      for (const registry of liveRegistries.values()) {
        const streamSimple = registry.getProvider(api)?.streamSimple;
        if (typeof streamSimple === "function") return streamSimple(model, context, opts);
      }
      throw new Error(
        `backend api "${api}" delegates to provider "${api}", which is not registered in any live session`,
      );
    }
    default:
      return openAICompletionsApi().streamSimple(model as Model<"openai-completions">, context, opts);
  }
}

function synthError(
  model: Model<Api>,
  errorMessage: string,
  reason: "error" | "aborted" = "error",
): AssistantMessageEvent {
  return {
    type: "error",
    reason,
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
      stopReason: reason,
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
  const maxAttemptsFor = (n: number) => config.maxAttempts ?? Math.max(n * 2, 2);
  const resolved = resolveRing(config, model.id);
  let ring = resolved.ring;
  let startIndex = resolved.startIndex;
  const setName = resolved.setName;
  let total = ring.length;
  let maxAttempts = maxAttemptsFor(total);

  (async () => {
    if (total === 0) {
      outer.push(synthError(model, "No failover backends configured"));
      outer.end();
      return;
    }

    if (needsVision(context)) {
      const circular = [...ring.slice(startIndex), ...ring.slice(0, startIndex)];
      const eligible = circular.filter(supportsVision);
      if (eligible.length === 0) {
        const skippedNames = circular.map((b) => b.name).join(", ");
        const setClause = setName ? ` in set "${setName}"` : "";
        outer.push(
          synthError(
            model,
            `No vision-capable backend${setClause}; skipped ${skippedNames} (text-only). Add "input": ["text","image"] to a backend or remove the images.`,
            "error",
          ),
        );
        outer.end();
        return;
      }
      const skipped = circular.filter((b) => !supportsVision(b));
      if (skipped.length > 0) {
        console.warn(
          `[failover] image input: skipping ${skipped.map((b) => b.name).join(", ")} (no image support); serving from ${eligible.map((b) => b.name).join(", ")}`,
        );
      }
      ring = eligible;
      startIndex = 0;
      total = eligible.length;
      maxAttempts = maxAttemptsFor(total);
    }

    let lastMessage = "No backends configured";
    let lastFatal: AssistantMessageEvent | null = null;

    for (let i = 0; i < maxAttempts; i++) {
      const backend = ring[(startIndex + i) % total];
      setStatus(statusText(model.id, backend));
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
function resolveRing(
  config: FailoverConfig,
  modelId: string,
): { ring: Backend[]; startIndex: number; setName?: string } {
  for (const set of config.sets) {
    const idx = set.models.findIndex((b) => b.name === modelId);
    if (idx >= 0) return { ring: set.models, startIndex: idx, setName: set.name };
  }
  // "auto" or unknown id → the configured default, else first set, first model
  return resolveDefault(config) ?? { ring: config.sets[0]?.models ?? [], startIndex: 0 };
}

/**
 * Resolve the config's optional `default`: a set name (that set, first model)
 * or a model name (its set, starting at that model). Set names win on collision.
 */
function resolveDefault(config: FailoverConfig): { ring: Backend[]; startIndex: number } | null {
  const name = typeof config.default === "string" ? config.default.trim() : "";
  if (!name) return null;
  const set = config.sets.find((s) => s.name === name);
  if (set) return { ring: set.models, startIndex: 0 };
  for (const s of config.sets) {
    const idx = s.models.findIndex((b) => b.name === name);
    if (idx >= 0) return { ring: s.models, startIndex: idx };
  }
  return null;
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
    return classifyFailure(model, msg, opts.signal);
  }

  let started = false;
  try {
    for await (const event of inner) {
      if (!started) {
        if (event.type === "start") {
          started = true;
        } else if (event.type === "error") {
          if (event.reason === "aborted") {
            // The request was cancelled; forward the provider's abort event as-is.
            return { status: "fatal", event };
          }
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
    if (started) {
      outer.end();
      return { status: "done" };
    }
    // The backend ended without emitting a single event. Ending the outer
    // stream here is what keeps pi from waiting forever on a silent backend.
    outer.push(synthError(model, "Backend produced no response"));
    outer.end();
    return { status: "done" };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (started) {
      // Mid-stream failure: content already streamed, cannot fail over.
      outer.push(synthError(model, msg, isAborted(msg, opts.signal) ? "aborted" : "error"));
      outer.end();
      return { status: "done" };
    }
    return classifyFailure(model, msg, opts.signal);
  }
}

function toModelConfig(b: Backend, id: string, name: string, config: FailoverConfig) {
  return {
    id,
    name,
    api: PROVIDER_API,
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
  pi.on("before_agent_start", (event) => {
    const state = loadRoster();
    if (state.section) {
      event.systemPromptOptions.sections.model_roster = state.section;
    } else {
      delete event.systemPromptOptions.sections.model_roster;
    }
  });

  pi.registerCommand?.("roster", {
    description: "Show the model roster rendered from failover.json",
    handler: async (_args, ctx) => {
      ctx.ui.notify(rosterReport(loadRoster()), "info");
    },
  });

  pi.on("session_start", (_e, ctx) => {
    statusUi = ctx.ui;
    statusMode = ctx.mode;
    liveRegistries.set(ctx.sessionManager.getSessionId(), ctx.modelRegistry as unknown as DelegateRegistry);
    if (first) setStatus(statusText("auto", first));
  });
  pi.on("session_shutdown", (_e, ctx) => {
    statusUi?.setStatus("failover", undefined);
    statusUi = null;
    statusMode = null;
    liveRegistries.delete(ctx.sessionManager.getSessionId());
  });

  const config = loadConfig();
  if (config.default && !resolveDefault(config)) {
    console.warn(`[failover] default "${config.default}" matches no set or model; using the first set`);
  }
  const seen = new Set<string>();
  const allBackends = config.sets
    .flatMap((s) => s.models)
    .filter((b) => {
      if (seen.has(b.name)) return false;
      seen.add(b.name);
      return true;
    });
  const autoRing = resolveRing(config, "auto");
  const first = autoRing.ring[autoRing.startIndex] ?? allBackends[0];

  const models = [];
  if (first) {
    models.push(toModelConfig(first, "auto", `Auto (failover → ${first.name})`, config));
  }
  for (const backend of allBackends) {
    models.push(toModelConfig(backend, backend.name, `Failover · ${backend.name}`, config));
  }

  pi.registerProvider("failover", {
    name: "Failover",
    baseUrl: first?.baseUrl ?? "https://example.com",
    apiKey: first?.apiKey ?? "$DEEPSEEK_API_KEY",
    api: PROVIDER_API,
    models,
    streamSimple: streamFailover,
  });
}

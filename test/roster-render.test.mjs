// pi-failover roster harness: exercises renderRoster (pure) and loadRoster
// (mtime-cached config loading) plus the before_agent_start section handler in
// extensions/failover.ts with offline fixtures. No framework; throws on
// failure; prints PASS lines.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    throw new Error(msg);
  }
}
function pass(msg) {
  console.log(`PASS: ${msg}`);
}
function runCase(name, fn) {
  try {
    fn();
    pass(name);
  } catch (e) {
    console.error(`FAIL: ${name}: ${e.message}`);
  }
}
function classLine(text, name) {
  const line = text.split("\n").find((l) => l.startsWith(`- ${name}:`));
  assert(line !== undefined, `missing "${name}" class line in roster:\n${text}`);
  return line;
}
function inOrder(line, names) {
  let prev = -1;
  for (const name of names) {
    const i = line.indexOf(name);
    assert(i >= 0, `missing "${name}" in line: ${line}`);
    assert(i > prev, `"${name}" out of order in line: ${line}`);
    prev = i;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "pi-failover-roster-"));

// Point the module's initial load at a harmless missing file so the cases drive
// the path from scratch rather than an inherited FAILOVER_CONFIG.
process.env.FAILOVER_CONFIG = join(tmp, "initial-missing.json");

const { renderRoster, loadRoster, default: piRoster } = await import("../extensions/failover.ts");

// Fixture mirroring the real failover.json catalog shape (values are enough to
// prove ordering, dedup, and modalities without reading the real file).
const fixture = {
  sets: [
    {
      name: "opus",
      models: [
        { name: "glm-5.3", cost: { input: 1.4, output: 4.4 } },
        { name: "kimi-k3", input: ["text", "image"], cost: { input: 3, output: 15 } },
      ],
    },
    {
      name: "sonnet",
      models: [
        {
          name: "deepseek-v4-pro",
          cost: { input: 0.435, output: 0.87 },
          thinkingLevelMap: { minimal: "high", xhigh: "max" },
        },
        { name: "kimi-k2.6", input: ["text", "image"], cost: { input: 0.95, output: 4 } },
      ],
    },
    {
      name: "flash",
      models: [
        { name: "deepseek-flash", cost: { input: 0.14, output: 0.28 } },
        { name: "MiniMax-M3.1-Flash", input: ["text", "image"], cost: { input: 0.15, output: 0.6 } },
        { name: "glm-5.3-flash", input: ["text", "image"], cost: { input: 0.15, output: 0.5 } },
      ],
    },
    {
      name: "coding",
      models: [
        { name: "kimi-k2.7-code", input: ["text", "image"], cost: { input: 0.95, output: 4 } },
        {
          name: "deepseek-v4-pro",
          cost: { input: 0.435, output: 0.87 },
          thinkingLevelMap: { minimal: "high", xhigh: "max" },
        },
        { name: "MiniMax-M3.1-Flash", input: ["text", "image"], cost: { input: 0.15, output: 0.6 } },
        { name: "glm-5.3-flash", input: ["text", "image"], cost: { input: 0.15, output: 0.5 } },
      ],
    },
  ],
};

runCase("CASE 1: renders all four classes with the expected member order", () => {
  const text = renderRoster(fixture);
  inOrder(classLine(text, "opus"), ["glm-5.3", "kimi-k3"]);
  inOrder(classLine(text, "sonnet"), ["deepseek-v4-pro", "kimi-k2.6"]);
  inOrder(classLine(text, "flash"), ["deepseek-flash", "MiniMax-M3.1-Flash", "glm-5.3-flash"]);
  inOrder(classLine(text, "coding"), [
    "kimi-k2.7-code",
    "deepseek-v4-pro",
    "MiniMax-M3.1-Flash",
    "glm-5.3-flash",
  ]);
});

runCase("CASE 2: sonnet's first-listed model is deepseek-v4-pro", () => {
  const text = renderRoster(fixture);
  const sonnet = classLine(text, "sonnet");
  assert(sonnet.startsWith("- sonnet: deepseek-v4-pro"), `sonnet does not lead with deepseek-v4-pro: ${sonnet}`);
});

runCase("CASE 3: a model in two sets is bare after its first occurrence", () => {
  const text = renderRoster(fixture);
  const sonnet = classLine(text, "sonnet");
  const coding = classLine(text, "coding");
  assert(sonnet.includes("deepseek-v4-pro ($"), "first occurrence should carry cost detail");
  assert(coding.includes("-> deepseek-v4-pro ->"), "coding's deepseek-v4-pro should be a bare name");
  assert(!coding.includes("deepseek-v4-pro ("), "coding should not repeat deepseek-v4-pro details");
  assert(!coding.includes("MiniMax-M3.1-Flash ("), "coding should not repeat MiniMax-M3.1-Flash details");
});

runCase("CASE 4: modalities reflect the input field", () => {
  const text = renderRoster(fixture);
  const sonnet = classLine(text, "sonnet");
  assert(/kimi-k2\.6 \([^)]*image/.test(sonnet), `kimi-k2.6 should show image: ${sonnet}`);
  const opus = classLine(text, "opus");
  assert(/glm-5\.3 \([^)]*text/.test(opus), `glm-5.3 should show text: ${opus}`);
  assert(!/glm-5\.3 \([^)]*image/.test(opus), `glm-5.3 should not show image: ${opus}`);
});

runCase("CASE 5: malformed JSON yields an empty section without throwing", () => {
  const bad = join(tmp, "bad.json");
  writeFileSync(bad, "{ not json");
  process.env.FAILOVER_CONFIG = bad;
  let state;
  let threw = false;
  try {
    state = loadRoster();
  } catch {
    threw = true;
  }
  assert(!threw, "loadRoster threw on malformed JSON");
  assert(state.section === "", `expected empty section, got: ${state.section}`);
  assert(state.disabled, "expected a disabled reason");
});

runCase("CASE 6: missing file yields an empty section without throwing", () => {
  const missing = join(tmp, "nope.json");
  process.env.FAILOVER_CONFIG = missing;
  let state;
  let threw = false;
  try {
    state = loadRoster();
  } catch {
    threw = true;
  }
  assert(!threw, "loadRoster threw on a missing file");
  assert(state.section === "", `expected empty section, got: ${state.section}`);
  assert(state.disabled, "expected a disabled reason");
});

runCase("CASE 7: FAILOVER_CONFIG is honoured", () => {
  const custom = join(tmp, "custom.json");
  writeFileSync(
    custom,
    JSON.stringify({ sets: [{ name: "customset", models: [{ name: "custom-model", input: ["text"] }] }] }),
  );
  process.env.FAILOVER_CONFIG = custom;
  const state = loadRoster();
  assert(state.section.includes("- customset:"), `FAILOVER_CONFIG ignored, got:\n${state.section}`);
  assert(state.section.includes("custom-model"), "custom model missing from rendered roster");
});

runCase("CASE 8: wrong-shaped entries are skipped without throwing", () => {
  const nullSet = renderRoster({ sets: [null] });
  assert(typeof nullSet === "string", `null set: expected string, got ${typeof nullSet}`);
  const nullModel = renderRoster({ sets: [{ models: [null] }] });
  assert(typeof nullModel === "string", `null model: expected string, got ${typeof nullModel}`);
  const noName = renderRoster({
    sets: [{ name: "s", models: [{ cost: { input: 1, output: 2 } }] }],
  });
  assert(typeof noName === "string", `missing name: expected string, got ${typeof noName}`);
  assert(!noName.includes("undefined"), `missing name rendered "undefined": ${noName}`);
});

runCase("CASE 9: mtime change reloads the config", () => {
  const p = join(tmp, "reload.json");
  const later = new Date(Date.now() + 1000);
  writeFileSync(p, JSON.stringify({ sets: [{ name: "s", models: [{ name: "model-A" }] }] }));
  process.env.FAILOVER_CONFIG = p;
  const first = loadRoster();
  assert(first.section.includes("model-A"), `first load missing model-A:\n${first.section}`);
  writeFileSync(p, JSON.stringify({ sets: [{ name: "s", models: [{ name: "model-B" }] }] }));
  utimesSync(p, later, later);
  const second = loadRoster();
  assert(second.section.includes("model-B"), `reload missing model-B:\n${second.section}`);
  assert(!second.section.includes("model-A"), `stale model-A still present:\n${second.section}`);
});

runCase("CASE 10: malformed config warns exactly once at load", () => {
  const bad = join(tmp, "warn.json");
  writeFileSync(bad, "{ not json");
  const extPath = join(here, "..", "extensions", "failover.ts");
  const script = `import(${JSON.stringify(extPath)}).catch(() => process.exit(1));`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: here,
    env: { ...process.env, FAILOVER_CONFIG: bad },
    encoding: "utf8",
  });
  const warns = (res.stderr || "").split("\n").filter((l) => l.includes("[failover]"));
  assert(warns.length === 1, `expected one [failover] warn, got ${warns.length}:\n${res.stderr}`);
});

runCase("CASE 11: /roster command reports the roster or a disabled reason", () => {
  let handler;
  let notifyText = "";
  const pi = {
    on() {},
    registerProvider() {},
    registerCommand(name, opts) {
      if (name === "roster") handler = opts.handler;
    },
  };
  piRoster(pi);
  assert(handler, "registerCommand('roster') was not called");
  const ctx = { ui: { notify(text) { notifyText = text; } } };
  handler({}, ctx);
  assert(typeof notifyText === "string", "roster handler did not notify");
  assert(
    notifyText.includes("## Model roster") || notifyText.startsWith("roster disabled:"),
    `unexpected roster report:\n${notifyText}`,
  );
});

runCase("CASE 12: rendered roster carries no policy text", () => {
  const text = renderRoster(fixture);
  assert(text.length > 0, "rendered roster is empty");
  assert(
    !/must|should|escalate|review discipline|carve-out/i.test(text),
    `policy text leaked into roster:\n${text}`,
  );
});

runCase("CASE 13: roster section starts with the header", () => {
  const text = renderRoster(fixture);
  assert(text.startsWith("## Model roster"), `missing roster header:\n${text}`);
});

runCase("CASE 14: sonnet's xhigh model shows :xhigh->max", () => {
  const text = renderRoster(fixture);
  const sonnet = classLine(text, "sonnet");
  assert(/:xhigh->max/.test(sonnet), `missing :xhigh->max in sonnet line: ${sonnet}`);
});

runCase("CASE 15: before_agent_start sets model_roster when the roster has content", () => {
  const good = join(tmp, "good.json");
  writeFileSync(good, JSON.stringify({ sets: [{ name: "s", models: [{ name: "model-A" }] }] }));
  process.env.FAILOVER_CONFIG = good;
  let onBefore;
  const pi = {
    on(event, cb) {
      if (event === "before_agent_start") onBefore = cb;
    },
    registerProvider() {},
    registerCommand() {},
  };
  piRoster(pi);
  assert(onBefore, "before_agent_start handler was not registered");
  const sections = {};
  onBefore({ systemPromptOptions: { sections } });
  assert(
    typeof sections.model_roster === "string" && sections.model_roster.includes("model-A"),
    `model_roster not set:\n${JSON.stringify(sections)}`,
  );
});

runCase("CASE 16: before_agent_start omits model_roster when the roster is empty", () => {
  const missing = join(tmp, "missing.json");
  process.env.FAILOVER_CONFIG = missing;
  let onBefore;
  const pi = {
    on(event, cb) {
      if (event === "before_agent_start") onBefore = cb;
    },
    registerProvider() {},
    registerCommand() {},
  };
  piRoster(pi);
  assert(onBefore, "before_agent_start handler was not registered");
  const sections = {};
  onBefore({ systemPromptOptions: { sections } });
  assert(!("model_roster" in sections), `model_roster should be absent, got:\n${JSON.stringify(sections)}`);
});

runCase("CASE 17: before_agent_start never touches orchestrator_workflow", () => {
  const good = join(tmp, "good2.json");
  writeFileSync(good, JSON.stringify({ sets: [{ name: "s", models: [{ name: "model-A" }] }] }));
  process.env.FAILOVER_CONFIG = good;
  let onBefore;
  const pi = {
    on(event, cb) {
      if (event === "before_agent_start") onBefore = cb;
    },
    registerProvider() {},
    registerCommand() {},
  };
  piRoster(pi);
  assert(onBefore, "before_agent_start handler was not registered");
  const sections = {};
  onBefore({ systemPromptOptions: { sections } });
  assert(
    !("orchestrator_workflow" in sections),
    `orchestrator_workflow must remain absent, got:\n${JSON.stringify(sections)}`,
  );
});

rmSync(tmp, { recursive: true, force: true });

if (failures > 0) {
  console.error(`${failures} case(s) failed`);
  process.exit(1);
}
console.log("ALL PASS");

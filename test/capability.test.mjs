// Capability-aware failover harness: exercises vision filtering in
// extensions/failover.ts with fully offline fixtures. The backends use an
// unset env-var API key ($HARNESS_UNSET_KEY) so resolveApiKey returns "" and
// the retry loop `continue`s before any network call.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Fail fast unless HARNESS_UNSET_KEY is genuinely unset (the design depends on it).
delete process.env.HARNESS_UNSET_KEY;

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

const textOnly = {
  name: "text-only-b",
  provider: "p",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:9/v1",
  apiKey: "$HARNESS_UNSET_KEY",
  model: "m",
  reasoning: true,
  contextWindow: 1000,
  maxTokens: 100,
};
const vision = {
  ...textOnly,
  name: "vision-b",
  input: ["text", "image"],
};

const imageContext = {
  messages: [{ content: [{ type: "image", data: "x", mimeType: "image/png" }] }],
};
const textContext = { messages: [{ content: "hello" }] };
const model = { id: "text-only-b", api: "openai-completions", provider: "failover", input: ["text"] };

const tmp = mkdtempSync(join(tmpdir(), "pi-failover-harness-"));
const fixturePath = join(tmp, "failover.json");

function writeFixture(models) {
  writeFileSync(
    fixturePath,
    JSON.stringify({ maxAttempts: 2, sets: [{ name: "t", models }] }),
  );
}

function loadExtension() {
  let captured = null;
  const pi = {
    on() {},
    registerProvider: (_name, provider) => {
      captured = provider;
    },
  };
  extension(pi);
  assert(captured, "registerProvider was never called");
  return captured;
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

function captureWarnAsync(fn) {
  const warns = [];
  const orig = console.warn;
  console.warn = (...args) => warns.push(args.map(String).join(" "));
  return Promise.resolve()
    .then(fn)
    .then((result) => ({ result, warns }))
    .finally(() => {
      console.warn = orig;
    });
}

// Set the env var before importing/invoking, as the task requires.
process.env.FAILOVER_CONFIG = fixturePath;

const { default: extension } = await import("../extensions/failover.ts");

runCase("CASE 1: image on a text-only set errors, no skip warn", async () => {
  writeFixture([textOnly]);
  const provider = loadExtension();
  const { result: events, warns } = await captureWarnAsync(() =>
    collect(provider.streamSimple(model, imageContext, {})),
  );
  const err = events.find((e) => e.type === "error");
  assert(err, "expected an error event");
  const msg = String(err.error?.errorMessage ?? err.errorMessage ?? "");
  assert(msg.includes("No vision-capable backend"), `errorMessage missing marker: ${msg}`);
  assert(
    !warns.some((w) => w.includes("image input: skipping")),
    "unexpected image-skipping warn on a fully text-only set",
  );
});

runCase("CASE 2: mixed ring serves the vision backend, filters text-only", async () => {
  writeFixture([textOnly, vision]);
  const provider = loadExtension();
  const warns = [];
  const orig = console.warn;
  console.warn = (...args) => warns.push(args.map(String).join(" "));
  try {
    await collect(provider.streamSimple(model, imageContext, {}));
  } finally {
    console.warn = orig;
  }
  assert(
    warns.some((w) => w.includes("serving from vision-b")),
    `missing "serving from vision-b" in warns: ${JSON.stringify(warns)}`,
  );
  assert(
    warns.some((w) => w.includes("skipping text-only-b")),
    `missing "skipping text-only-b" in warns: ${JSON.stringify(warns)}`,
  );
});

runCase("CASE 3: plain text context leaves the text-only path untouched", async () => {
  writeFixture([textOnly, vision]);
  const provider = loadExtension();
  const warns = [];
  const orig = console.warn;
  console.warn = (...args) => warns.push(args.map(String).join(" "));
  try {
    await collect(provider.streamSimple(model, textContext, {}));
  } finally {
    console.warn = orig;
  }
  assert(
    !warns.some((w) => w.includes("image input: skipping")),
    `unexpected image-skipping warn on plain text: ${JSON.stringify(warns)}`,
  );
});

// Run in a child process: the async cases above are not awaited by this file,
// so a deterministic case must own its own process (same pattern as the roster
// harness's spawnSync case).
runCase("CASE 4: a set-name model id enters that set from its first model, staying inside it", () => {
  const setsFixture = join(tmp, "sets.json");
  writeFileSync(
    setsFixture,
    JSON.stringify({
      maxAttempts: 2,
      sets: [
        { name: "premium", models: [vision] },
        {
          name: "budget",
          models: [
            { ...textOnly, name: "text-only-a" },
            { ...textOnly, name: "text-only-b" },
          ],
        },
      ],
    }),
  );
  const extPath = join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "failover.ts");
  const script = `
    const ext = (await import(${JSON.stringify(extPath)})).default;
    let provider;
    ext({ on() {}, registerProvider: (_n, p) => { provider = p; } });
    const stream = provider.streamSimple(
      { id: "budget", api: "openai-completions", provider: "failover", input: ["text"] },
      { messages: [{ content: [{ type: "image", data: "x", mimeType: "image/png" }] }] },
      {},
    );
    const events = [];
    for await (const event of stream) events.push(event);
    const err = events.find((e) => e.type === "error");
    console.log(String(err?.error?.errorMessage ?? err?.errorMessage ?? ""));
  `;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: tmp,
    env: { ...process.env, FAILOVER_CONFIG: setsFixture },
    encoding: "utf8",
  });
  const msg = (res.stdout || "").trim();
  assert(msg !== "", `child produced no error message; stderr:\n${res.stderr}`);
  assert(msg.includes('in set "budget"'), `model id "budget" did not resolve to the set: ${msg}`);
  assert(
    msg.includes("skipped text-only-a, text-only-b"),
    `ring should be the set starting at its first model: ${msg}`,
  );
  assert(!msg.includes("vision-b"), `ring escaped into another set: ${msg}`);
});

runCase("CASE 5: set names register as model ids on the set's first model", () => {
  const registrationFixture = join(tmp, "registration.json");
  writeFileSync(
    registrationFixture,
    JSON.stringify({
      maxAttempts: 2,
      sets: [
        { name: "budget", models: [{ ...textOnly, name: "text-only-a" }, vision] },
        { name: "text-only-b", models: [{ ...textOnly, name: "text-only-b" }] },
      ],
    }),
  );
  let provider;
  process.env.FAILOVER_CONFIG = registrationFixture;
  try {
    provider = loadExtension();
  } finally {
    process.env.FAILOVER_CONFIG = fixturePath;
  }
  const byId = new Map();
  for (const m of provider.models) byId.set(m.id, [...(byId.get(m.id) ?? []), m]);
  const budget = byId.get("budget");
  assert(budget?.length === 1, `"budget" should be registered once, got ${budget?.length ?? 0}`);
  assert(
    budget[0].baseUrl === textOnly.baseUrl,
    `"budget" should carry its first model's config, got baseUrl ${budget[0].baseUrl}`,
  );
  const collision = byId.get("text-only-b");
  assert(
    collision?.length === 1,
    `a set name equal to a backend id must not duplicate it, got ${collision?.length ?? 0}`,
  );
  assert(
    collision[0].name === "Failover · text-only-b",
    `backend id should stay authoritative, got name ${collision[0].name}`,
  );
});

rmSync(tmp, { recursive: true, force: true });

if (failures > 0) {
  console.error(`${failures} case(s) failed`);
  process.exit(1);
}
console.log("ALL PASS");

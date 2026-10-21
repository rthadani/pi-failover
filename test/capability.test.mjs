// Capability-aware failover harness: exercises vision filtering in
// extensions/failover.ts with fully offline fixtures. The backends use an
// unset env-var API key ($HARNESS_UNSET_KEY) so resolveApiKey returns "" and
// the retry loop `continue`s before any network call.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

rmSync(tmp, { recursive: true, force: true });

if (failures > 0) {
  console.error(`${failures} case(s) failed`);
  process.exit(1);
}
console.log("ALL PASS");

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

// Exercise the actual session/registry classes with the VS Code host stubbed out.
const extension = await readFile(new URL("../dist/extension.js", import.meta.url), "utf8");
const sessionCode = extension.slice(extension.indexOf("class ChatSession"), extension.indexOf("function config("));
const toolsCode = await readFile(new URL("../dist/tools.js", import.meta.url), "utf8");
const registryCode = toolsCode.slice(toolsCode.indexOf("export class ToolRegistry"), toolsCode.indexOf("const terminalManagers"));
const commandCalls = [];
const globals = {
  crypto, structuredClone, AbortController, Date, console,
  vscode: { commands: { executeCommand: (...args) => { commandCalls.push(args); } } },
  sanitizeImages: (images) => images,
  createTools: () => ({ register() {} }),
  toolLabel: (name) => name,
  Agent: class { constructor() { this.fresh = true; } },
};
const Session = vm.runInNewContext(`${sessionCode}\nChatSession`, globals);
const Registry = vm.runInNewContext(`${registryCode.replace("export class", "class")}\nToolRegistry`);
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function session() {
  const value = Object.create(Session.prototype);
  Object.assign(value, {
    agentRevision: 0, queued: [], history: [], running: false,
    runtime: { activeAccount: { id: "personal" }, root: () => ({}), transport: () => ({}), markActive() {}, sessions: new Set() },
    view: { user() {}, status() {}, begin() {}, reset() {}, sync() {} },
    meter: { reset() {} }, persist() {},
  });
  value.runtime.sessions.add(value);
  return value;
}

test("registry exposes registered connected tools and skills alongside local tools", () => {
  const registry = new Registry();
  for (const name of ["read", "mcp_account_search", "skill"]) registry.register({ schema: { name }, readOnly: name !== "mcp_account_search" });
  assert.deepEqual(Array.from(registry.schemas(), (schema) => schema.name), ["read", "mcp_account_search", "skill"]);
});

test("reset during account-tool loading cannot install the old agent", async () => {
  const value = session();
  const loading = deferred();
  value.loadCloud = () => loading.promise;
  const pending = value.ensureAgent();
  value.newChat();
  loading.resolve({ tools: [], skills: [] });
  await assert.rejects(pending, /setup was cancelled/);
  assert.equal(value.agent, undefined);
});

test("old initialization cannot clear a newer initialization promise", async () => {
  const value = session();
  const oldLoad = deferred(), newLoad = deferred();
  let calls = 0;
  value.buildAgent = () => (++calls === 1 ? oldLoad.promise : newLoad.promise);
  const oldPending = value.ensureAgent();
  value.invalidateAgent();
  const newPending = value.ensureAgent();
  oldLoad.resolve({ old: true });
  await oldPending;
  assert.equal(value.agentPromise, newPending);
  newLoad.resolve({ fresh: true });
  await newPending;
  assert.equal(value.agentPromise, undefined);
});

test("directions received before agent setup completes are queued rather than dropped", async () => {
  const value = session();
  value.running = true;
  await value.send("Also check the tests");
  assert.equal(value.queued[0].text, "Also check the tests");
});

test("an active run keeps its agent when cached tools expire", async () => {
  const value = session();
  value.running = true;
  value.cloud = { loadedAt: 0 };
  const directions = [];
  value.agent = { steer: (text) => directions.push(text) };
  await value.send("Check one more file");
  assert.deepEqual(directions, ["Check one more file"]);
  assert.ok(value.agent);
});

test("invalidating an account agent clears its cached tools and skills", () => {
  const value = session();
  value.cloud = { accountId: "old-account", tools: [{}], skills: [{}] };
  value.invalidateAgent();
  assert.equal(value.cloud, undefined);
});

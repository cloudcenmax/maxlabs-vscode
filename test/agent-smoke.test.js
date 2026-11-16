import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../dist/agent.js";
import { emptyUsage } from "../dist/protocol.js";
import { createTerminalTool } from "../dist/terminal-tool.js";
import { BackgroundTerminals } from "../dist/terminals.js";

const cwd = process.cwd();

function settings(mode = "auto") {
  return { model: "worker", thinking: "low", mode, webSearch: "auto", webSearchUses: 3, maxSteps: 5 };
}

function registryFor(tool) {
  const map = new Map([[tool.schema.name, tool]]);
  return { map, get: (name) => map.get(name), schemas: () => [...map.values()].map((entry) => entry.schema) };
}

function hooks(overrides = {}) {
  return {
    delta: () => {}, reasoning: () => {}, status: () => {}, toolStart: () => {}, tool: () => {}, steering: () => {},
    approve: async () => { throw new Error("auto mode should not request approval"); },
    ...overrides,
  };
}

test("agent streams reasoning and runs a background terminal tool end to end", async () => {
  const terminals = new BackgroundTerminals();
  const tool = createTerminalTool(cwd, terminals);
  const reasoning = [];
  const toolEvents = [];
  let calls = 0;
  const transport = {
    async complete(options, onDelta, onReasoning) {
      calls++;
      assert.ok(options.tools.some((schema) => schema.name === "terminal"));
      if (calls === 1) {
        onReasoning("Considering a long-running dev server…");
        return {
          message: { role: "assistant", content: [{ type: "tool_call", callId: "call-1", name: "terminal", arguments: JSON.stringify({ action: "start", command: "echo 'listening on 8000' && sleep 60", wait_ms: 500 }) }] },
          usage: emptyUsage(),
        };
      }
      onDelta("The dev server is running.");
      return { message: { role: "assistant", content: [{ type: "text", text: "The dev server is running." }] }, usage: emptyUsage() };
    },
  };
  const agent = new Agent(transport, registryFor(tool), () => settings(), hooks({
    reasoning: (text) => reasoning.push(text),
    tool: (callId, name, args, result) => toolEvents.push({ callId, name, args, result }),
  }));

  try {
    const result = await agent.run("start the dev server", new AbortController().signal);
    assert.equal(result.steps, 2);
    assert.deepEqual(reasoning, ["Considering a long-running dev server…"]);
    assert.equal(toolEvents.length, 1);
    assert.match(toolEvents[0].result.text, /Started term-1/);
    assert.match(toolEvents[0].result.text, /listening on 8000/);
    const toolMessage = agent.history.find((message) => message.role === "tool");
    assert.match(toolMessage.content[0].text, /Started term-1/);
    assert.equal(terminals.runningCount(), 1);
  } finally {
    terminals.dispose();
  }
});

test("aborting a run rejects promptly so the stop control ends the turn", async () => {
  let started = false;
  const transport = {
    complete(options, onDelta, onReasoning, signal) {
      started = true;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ message: { role: "assistant", content: [{ type: "text", text: "late" }] }, usage: emptyUsage() }), 5_000);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
    },
  };
  const agent = new Agent(transport, { map: new Map(), get: () => undefined, schemas: () => [] }, () => settings(), hooks());
  const controller = new AbortController();
  const run = agent.run("do slow work", controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 30));
  controller.abort(new Error("Stopped by user"));
  await assert.rejects(run, /Stopped by user/);
  assert.equal(started, true);
});

test("resetting an agent during a run rejects without polluting the new conversation", async () => {
  let completeRun;
  const transport = { complete() { return new Promise((resolve) => { completeRun = resolve; }); } };
  const agent = new Agent(transport, { map: new Map(), get: () => undefined, schemas: () => [] }, () => settings(), hooks());
  const run = agent.run("first turn");
  await new Promise((resolve) => setTimeout(resolve, 20));
  agent.reset();
  completeRun({ message: { role: "assistant", content: [{ type: "text", text: "late response" }] }, usage: emptyUsage() });
  await assert.rejects(run, /reset/i);
  assert.deepEqual(agent.history, []);
});

test("aborting during a terminal start stops the process and ends the run promptly", async () => {
  const terminals = new BackgroundTerminals();
  const tool = createTerminalTool(cwd, terminals);
  let calls = 0;
  const transport = {
    async complete() {
      calls++;
      if (calls === 1) return { message: { role: "assistant", content: [{ type: "tool_call", callId: "call-1", name: "terminal", arguments: JSON.stringify({ action: "start", command: "echo starting && sleep 30", wait_ms: 5_000 }) }] }, usage: emptyUsage() };
      return { message: { role: "assistant", content: [{ type: "text", text: "done" }] }, usage: emptyUsage() };
    },
  };
  const agent = new Agent(transport, registryFor(tool), () => settings(), hooks());
  const controller = new AbortController();
  try {
    const run = agent.run("start a server", controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort(new Error("Stopped by user"));
    await assert.rejects(run, /Stopped by user/);
    assert.equal(terminals.runningCount(), 0);
  } finally {
    terminals.dispose();
  }
});

test("agent passes account context and pasted images into the request", async () => {
  let captured;
  const transport = {
    async complete(options) {
      captured = options;
      return { message: { role: "assistant", content: [{ type: "text", text: "seen" }] }, usage: emptyUsage() };
    },
  };
  const agent = new Agent(transport, { map: new Map(), get: () => undefined, schemas: () => [] }, () => settings(), hooks({ context: () => "Skills available: Code Review." }));
  await agent.run("what is this", undefined, [{ mimeType: "image/png", data: "AQID" }]);
  assert.match(agent.history[0].content[0].text, /Skills available: Code Review/);
  const user = agent.history.find((message) => message.role === "user");
  assert.deepEqual(user.content, [{ type: "text", text: "what is this" }, { type: "image", mimeType: "image/png", data: "AQID" }]);
  assert.equal(captured.messages.some((message) => message.role === "user"), true);
});

function bashRegistry(executed) {
  const tool = {
    schema: { name: "bash", description: "Run a command.", parameters: { type: "object", properties: { command: { type: "string" } } } },
    readOnly: false,
    async execute(args) { executed.push(String(args.command || "")); return { text: "command completed" }; },
  };
  return { map: new Map([["bash", tool]]), get: (name) => name === "bash" ? tool : undefined, schemas: () => [tool.schema] };
}

function commandTransport(command) {
  let calls = 0;
  return {
    async complete() {
      calls++;
      if (calls === 1) return { message: { role: "assistant", content: [{ type: "tool_call", callId: "call-1", name: "bash", arguments: JSON.stringify({ command }) }] }, usage: emptyUsage() };
      return { message: { role: "assistant", content: [{ type: "text", text: "done" }] }, usage: emptyUsage() };
    },
  };
}

test("auto mode runs a reviewed destructive command without asking the person", async () => {
  const executed = [];
  const reviews = [];
  const agent = new Agent(commandTransport("rm -rf build"), bashRegistry(executed), () => ({ ...settings("auto"), workspaceRoot: cwd, reviewer: async (tool, args, messages) => { reviews.push({ tool, messages }); return "allow"; } }), hooks({
    approve: async () => { throw new Error("the person should not be asked"); },
  }));
  await agent.run("clean the build output");
  assert.deepEqual(executed, ["rm -rf build"]);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].tool, "bash");
  assert.ok(reviews[0].messages.some((message) => message.includes("clean the build output")));
});

test("auto mode falls back to the person when the reviewer is uncertain", async () => {
  const executed = [];
  let asked = 0;
  const agent = new Agent(commandTransport("rm -rf build"), bashRegistry(executed), () => ({ ...settings("auto"), workspaceRoot: cwd, reviewer: async () => "ask" }), hooks({
    approve: async () => { asked++; return "once"; },
  }));
  await agent.run("remove build");
  assert.deepEqual(executed, ["rm -rf build"]);
  assert.equal(asked, 1);
});

test("approval detail shows the whole command instead of a hidden truncated tail", async () => {
  const command = `echo ${"a".repeat(9_000)} && rm -rf build`;
  let detail = "";
  let executed = false;
  const registry = {
    map: new Map(),
    get: () => ({ schema: { name: "bash", description: "", parameters: {} }, readOnly: false, async execute() { executed = true; return { text: "ran" }; } }),
    schemas: () => [],
  };
  const agent = new Agent(commandTransport(command), registry, () => settings("act"), hooks({
    approve: async (_callId, _tool, value) => { detail = value; return "deny"; },
  }));
  await agent.run("clean up");
  assert.equal(executed, false);
  assert.ok(detail.includes("&& rm -rf build"), "the destructive tail must be visible");
  // The command is shown whole. A long one is broken across lines so the chain
  // can be read a step at a time; the text itself is never shortened.
  assert.ok(detail.replace(/\s+/g, " ").includes(command.replace(/\s+/g, " ")));
  assert.ok(detail.length >= command.length);
});

test("independent read calls run concurrently and keep call order", async () => {
  let inFlight = 0;
  let peak = 0;
  const finished = [];
  const readTool = {
    schema: { name: "read", description: "Read a file", parameters: { type: "object" } },
    readOnly: true,
    async execute(args) {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight--;
      finished.push(args.path);
      return { text: `contents of ${args.path}` };
    },
  };
  const toolCalls = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"].map((path, index) => ({
    type: "tool_call",
    callId: `c${index}`,
    name: "read",
    arguments: JSON.stringify({ path }),
  }));

  let request = 0;
  const transport = {
    async complete() {
      request++;
      if (request === 1) return { message: { role: "assistant", content: toolCalls }, usage: emptyUsage() };
      return { message: { role: "assistant", content: [{ type: "text", text: "done" }] }, usage: emptyUsage() };
    },
  };

  const seen = [];
  const agent = new Agent(transport, registryFor(readTool), () => settings(), hooks({ tool: (_id, name, args, result) => seen.push(result.text) }));
  const result = await agent.run("read everything");

  assert.equal(result.steps, 2);
  assert.equal(peak, 5, `reads did not overlap; peak = ${peak}`);
  // The transcript must be in call order even though the reads finished in an
  // arbitrary order.
  assert.deepEqual(seen, ["contents of a.txt", "contents of b.txt", "contents of c.txt", "contents of d.txt", "contents of e.txt"]);
});

test("write and shell calls never overlap a sibling", async () => {
  let inFlight = 0;
  let peak = 0;
  const writeTool = {
    schema: { name: "write", description: "Write a file", parameters: { type: "object" } },
    readOnly: false,
    async execute(args) {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return { text: `wrote ${args.path}` };
    },
  };
  const toolCalls = ["a.txt", "b.txt", "c.txt"].map((path, index) => ({
    type: "tool_call",
    callId: `w${index}`,
    name: "write",
    arguments: JSON.stringify({ path }),
  }));

  let request = 0;
  const transport = {
    async complete() {
      request++;
      if (request === 1) return { message: { role: "assistant", content: toolCalls }, usage: emptyUsage() };
      return { message: { role: "assistant", content: [{ type: "text", text: "done" }] }, usage: emptyUsage() };
    },
  };

  const agent = new Agent(transport, registryFor(writeTool), () => settings(), hooks());
  await agent.run("write everything");
  assert.equal(peak, 1, `mutating calls overlapped; peak = ${peak}`);
});

test("a model or thinking change mid-turn reaches the next request only", async () => {
  const seen = [];
  let live = { ...settings("auto"), model: "worker", thinking: "low" };
  const registry = {
    map: new Map(),
    get: () => ({ schema: { name: "bash", description: "", parameters: {} }, readOnly: true, async execute() { return { text: "ok" }; } }),
    schemas: () => [],
  };

  const transport = {
    async complete(request) {
      seen.push({ model: request.model, thinking: request.thinking });
      if (seen.length === 1) {
        // A settings change lands WHILE this request is running, exactly where a
        // person would make one.
        live = { ...live, model: "pro", thinking: "high" };
        return {
          message: { role: "assistant", content: [{ type: "tool_call", callId: "c1", name: "bash", arguments: "{}" }] },
          usage: emptyUsage(),
        };
      }
      return { message: { role: "assistant", content: [{ type: "text", text: "done" }] }, usage: emptyUsage() };
    },
  };

  const agent = new Agent(transport, registry, () => live, hooks());
  await agent.run("work");

  assert.equal(seen.length, 2);
  // The request already in flight is untouched.
  assert.equal(seen[0].model, "worker");
  assert.equal(seen[0].thinking, "low");
  // The next one carries the new values, so the control is not ignored.
  assert.equal(seen[1].model, "pro");
  assert.equal(seen[1].thinking, "high");
});

test("a mode change mid-turn rebuilds the prompt and then settles", async () => {
  const systems = [];
  let live = settings("act");
  const registry = {
    map: new Map(),
    get: () => ({ schema: { name: "bash", description: "", parameters: {} }, readOnly: true, async execute() { return { text: "ok" }; } }),
    schemas: () => [],
  };

  let call = 0;
  const transport = {
    async complete(request) {
      systems.push(request.messages[0].content[0].text);
      call++;
      if (call === 1) {
        live = settings("plan");
        return {
          message: { role: "assistant", content: [{ type: "tool_call", callId: "c1", name: "bash", arguments: "{}" }] },
          usage: emptyUsage(),
        };
      }
      return { message: { role: "assistant", content: [{ type: "text", text: "done" }] }, usage: emptyUsage() };
    },
  };

  const agent = new Agent(transport, registry, () => live, hooks());
  await agent.run("work");

  assert.match(systems[0], /Manual mode is active/);
  assert.match(systems[1], /Plan mode is active/);
});

test("maxSteps is not changed by a later settings edit", async () => {
  // A turn must finish under the limits it started with; otherwise a mid-turn
  // edit could extend or truncate a loop already in progress.
  let live = { ...settings("auto"), maxSteps: 2 };
  let calls = 0;
  const registry = {
    map: new Map(),
    get: () => ({ schema: { name: "bash", description: "", parameters: {} }, readOnly: true, async execute() { return { text: "ok" }; } }),
    schemas: () => [],
  };
  const transport = {
    async complete() {
      calls++;
      live = { ...live, maxSteps: 50 };
      return {
        message: { role: "assistant", content: [{ type: "tool_call", callId: `c${calls}`, name: "bash", arguments: "{}" }] },
        usage: emptyUsage(),
      };
    },
  };

  const agent = new Agent(transport, registry, () => live, hooks());
  await assert.rejects(() => agent.run("loop"), /step limit/);
  assert.equal(calls, 2, "the turn must stop at the limit it started with");
});

test("a saved approval cannot override plan-mode denial", async () => {
  const executed = [];
  let current = settings("act");
  const agent = new Agent(commandTransport("printf ok"), bashRegistry(executed), () => current, hooks({ approve: async () => "always" }));
  await agent.run("run the command");
  assert.equal(executed.length, 1);
  current = settings("plan");
  agent.transport.complete = commandTransport("printf ok").complete;
  await agent.run("inspect only");
  assert.equal(executed.length, 1, "a prior approval must not override a deny");
});

test("stopping a batch prevents queued reads from starting", async () => {
  const controller = new AbortController();
  const executed = [];
  const tool = { schema: { name: "read", parameters: {} }, readOnly: true, async execute(args) {
    executed.push(args.path);
    controller.abort(new Error("Stopped"));
    return { text: "done" };
  } };
  const transport = { async complete() { return { message: { role: "assistant", content: Array.from({ length: 8 }, (_, i) => ({ type: "tool_call", callId: `call-${i}`, name: "read", arguments: JSON.stringify({ path: String(i) }) })) }, usage: emptyUsage() }; } };
  const agent = new Agent(transport, registryFor(tool), () => ({ ...settings(), toolConcurrency: 2 }), hooks());
  await assert.rejects(agent.run("read files", controller.signal), /Stopped/);
  assert.ok(executed.length <= 2, `only in-flight reads may finish; ran ${executed.length}`);
});

test("a throwing read tool is contained and stops later mutations", async () => {
  let mutated = false;
  const tools = new Map([
    ["read", { schema: { name: "read" }, readOnly: true, async execute() { throw new Error("local read failed"); } }],
    ["write", { schema: { name: "write" }, readOnly: false, async execute() { mutated = true; return { text: "wrote" }; } }],
  ]);
  let requests = 0;
  const transport = { async complete() { return { message: { role: "assistant", content: ++requests === 1 ? [
    { type: "tool_call", callId: "r", name: "read", arguments: "{}" },
    { type: "tool_call", callId: "w", name: "write", arguments: JSON.stringify({ path: "file.txt" }) },
  ] : [{ type: "text", text: "read failed" }] }, usage: emptyUsage() }; } };
  const agent = new Agent(transport, { get: (name) => tools.get(name), schemas: () => [] }, () => settings(), hooks());
  await agent.run("read then write");
  assert.equal(mutated, false);
  assert.ok(agent.history.some((entry) => entry.role === "tool" && entry.content[0].isError));
});

test("reset while compaction is pending cannot restore the previous history", async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const transport = { async complete() { await pending; return { message: { role: "assistant", content: [{ type: "text", text: "old summary" }] }, usage: emptyUsage() }; } };
  const agent = new Agent(transport, { get() {}, schemas: () => [] }, () => ({ ...settings(), contextWindow: 100 }), hooks());
  const run = agent.run("summarize " + "x".repeat(1_000));
  agent.reset();
  finish();
  await assert.rejects(run, /reset/i);
  assert.equal(agent.history.length, 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalTool } from "../dist/terminal-tool.js";
import { BackgroundTerminals } from "../dist/terminals.js";

const cwd = process.cwd();
const executable = JSON.stringify(process.execPath);
const nodeCommand = (script) => `${executable} -e ${JSON.stringify(script)}`;

test("terminal tool advertises the expected schema and strips a redundant workspace cd", () => {
  const tool = createTerminalTool(cwd, new BackgroundTerminals());
  assert.equal(tool.schema.name, "terminal");
  assert.deepEqual(tool.schema.parameters.properties.action.enum, ["start", "list", "output", "stop"]);
  assert.equal(tool.readOnly, false);
  assert.equal(tool.normalize({ action: "start", command: `cd ${cwd} && php artisan serve` }).command, "php artisan serve");
});

test("terminal tool starts, reads, lists, and stops a background process end to end", async () => {
  const terminals = new BackgroundTerminals();
  const tool = createTerminalTool(cwd, terminals);
  try {
    const empty = await tool.execute({ action: "list" });
    assert.match(empty.text, /No background terminals/);

    const started = await tool.execute({ action: "start", command: nodeCommand("process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"), wait_ms: 1_500 });
    assert.notEqual(started.isError, true);
    assert.match(started.text, /Started term-1/);
    const id = started.text.match(/term-\d+/)[0];

    const output = await tool.execute({ action: "output", id, tail: 1_000 });
    assert.match(output.text, /ready/);
    assert.match(output.text, /running/);

    const listed = await tool.execute({ action: "list" });
    assert.match(listed.text, new RegExp(id));

    const stopped = await tool.execute({ action: "stop", id });
    assert.match(stopped.text, /Stopped term-1/);
    assert.equal((await tool.execute({ action: "list" })).text.includes(" · running · "), false);
  } finally {
    terminals.dispose();
  }
});

test("terminal tool rejects unknown ids, actions, and cwd outside the workspace", async () => {
  const terminals = new BackgroundTerminals();
  const tool = createTerminalTool(cwd, terminals);
  try {
    assert.equal((await tool.execute({ action: "output", id: "term-99" })).isError, true);
    assert.equal((await tool.execute({ action: "stop" })).isError, true);
    assert.equal((await tool.execute({ action: "bogus" })).isError, true);
    assert.equal((await tool.execute({ action: "start", command: "echo hi", cwd: ".." })).isError, true);
    assert.equal(terminals.list().length, 0);
  } finally {
    terminals.dispose();
  }
});

test("terminal output offsets past the old 64k limit remain readable", async () => {
  const terminals = new BackgroundTerminals();
  const tool = createTerminalTool(cwd, terminals);
  try {
    const started = await tool.execute({ action: "start", command: nodeCommand("process.stdout.write('x'.repeat(200000))"), wait_ms: 3_000 });
    assert.notEqual(started.isError, true);
    const id = started.text.match(/term-\d+/)[0];
    const later = await tool.execute({ action: "output", id, offset: 130000 });
    assert.match(later.text, /output characters 130000–194000 of 200000/);
    assert.match(later.text, /x{1000}/);
    const nonsense = await tool.execute({ action: "output", id, offset: "not-a-number" });
    assert.doesNotMatch(nonsense.text, /NaN/);
  } finally {
    terminals.dispose();
  }
});

test("aborting a start request terminates the new terminal promptly", async () => {
  const terminals = new BackgroundTerminals();
  const tool = createTerminalTool(cwd, terminals);
  try {
    const controller = new AbortController();
    const run = tool.execute({ action: "start", command: nodeCommand("setInterval(() => {}, 1000)"), wait_ms: 3_000 }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort(new Error("Stopped by user"));
    await assert.rejects(run, /Stopped by user/);
    assert.equal(terminals.runningCount(), 0);
  } finally {
    terminals.dispose();
  }
});

test("aborting a stop request forces termination instead of blocking", async () => {
  const terminals = new BackgroundTerminals();
  const tool = createTerminalTool(cwd, terminals);
  try {
    const started = await tool.execute({ action: "start", command: nodeCommand("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"), wait_ms: 300 });
    const id = started.text.match(/term-\d+/)[0];
    const controller = new AbortController();
    const stopping = tool.execute({ action: "stop", id, wait_ms: 10_000 }, controller.signal);
    setTimeout(() => controller.abort(new Error("Stopped by user")), 100);
    const result = await stopping;
    assert.match(result.text, /Stopped term-1/);
    assert.equal(terminals.runningCount(), 0);
  } finally {
    terminals.dispose();
  }
});

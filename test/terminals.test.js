import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundTerminals } from "../dist/terminals.js";

const cwd = process.cwd();
const executable = JSON.stringify(process.execPath);
const nodeCommand = (script) => `${executable} -e ${JSON.stringify(script)}`;

test("start captures startup output and reports a running terminal", async () => {
  const terminals = new BackgroundTerminals();
  try {
    const started = await terminals.start(nodeCommand("process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"), cwd, { waitMs: 1_500 });
    assert.equal(started.running, true);
    assert.match(started.output, /ready/);
    assert.equal(terminals.list().length, 1);
    assert.equal(terminals.runningCount(), 1);
    const read = terminals.read(started.id, { tail: 1_000 });
    assert.match(read.output, /ready/);
    const stopped = await terminals.stop(started.id);
    assert.equal(stopped.running, false);
    assert.equal(terminals.runningCount(), 0);
  } finally {
    terminals.dispose();
  }
});

test("output supports incremental offsets and preserves the exit status", async () => {
  const terminals = new BackgroundTerminals();
  try {
    const started = await terminals.start(nodeCommand("process.stdout.write('first'); setTimeout(() => process.exit(0), 40)"), cwd, { waitMs: 3_000 });
    assert.equal(started.running, false);
    assert.equal(started.exitCode, 0);
    assert.match(started.output, /first/);
    const fromStart = terminals.read(started.id, { offset: 0 });
    assert.ok(fromStart.output.startsWith("first"));
    const later = terminals.read(started.id, { offset: fromStart.offset + 3 });
    assert.equal(later.offset, 3);
    assert.ok(later.output.startsWith("st"));
    assert.equal(terminals.list()[0].outputCharacters, 5);
  } finally {
    terminals.dispose();
  }
});

test("stopping a running terminal terminates its process and updates the listing", async () => {
  const terminals = new BackgroundTerminals();
  try {
    const started = await terminals.start(nodeCommand("setInterval(() => {}, 1000)"), cwd, { waitMs: 500 });
    assert.equal(started.running, true);
    assert.equal(terminals.list()[0].running, true);
    await terminals.stop(started.id, { timeoutMs: 500 });
    assert.equal(terminals.list()[0].running, false);
    assert.equal(terminals.runningCount(), 0);
  } finally {
    terminals.dispose();
  }
});

test("unknown terminal ids fail clearly and stopAll reports running terminals", async () => {
  const terminals = new BackgroundTerminals();
  try {
    assert.throws(() => terminals.read("term-99"), /no background terminal/);
    await terminals.start(nodeCommand("setInterval(() => {}, 1000)"), cwd, { waitMs: 100 });
    await terminals.start(nodeCommand("setInterval(() => {}, 1000)"), cwd, { waitMs: 100 });
    assert.equal(terminals.runningCount(), 2);
    assert.equal(await terminals.stopAll(), 2);
    assert.equal(terminals.runningCount(), 0);
  } finally {
    terminals.dispose();
  }
});

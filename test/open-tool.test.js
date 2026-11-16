import assert from "node:assert/strict";
import test from "node:test";
import { createOpenTool } from "../dist/open-tool.js";
import { decide } from "../dist/security.js";

const cwd = process.cwd();

function recorder() {
  const calls = [];
  return {
    calls,
    host: {
      async open(file, options) { calls.push({ action: "open", file, options }); },
      async reveal(file) { calls.push({ action: "reveal", file }); },
    },
  };
}

test("open tool opens a workspace file in a persistent editor tab", async () => {
  const { calls, host } = recorder();
  const tool = createOpenTool(cwd, host);
  assert.equal(tool.schema.name, "open");
  assert.equal(tool.readOnly, true);
  const result = await tool.execute({ path: "package.json" });
  assert.match(result.text, /Opened package\.json in an editor tab/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "open");
  assert.ok(calls[0].file.endsWith("package.json"));
  assert.equal(calls[0].options.preview, false);
  assert.equal(calls[0].options.viewColumn, "active");
});

test("open tool supports beside, preview, and a selected line", async () => {
  const { calls, host } = recorder();
  const tool = createOpenTool(cwd, host);
  const result = await tool.execute({ path: "README.md", preview: true, view_column: "beside", line: 4, column: 3 });
  assert.match(result.text, /at line 4:3/);
  assert.deepEqual(calls[0].options, { preview: true, viewColumn: "beside", line: 4, column: 3 });
});

test("open tool reveals files and folders in the file explorer", async () => {
  const { calls, host } = recorder();
  const tool = createOpenTool(cwd, host);
  const file = await tool.execute({ path: "package.json", target: "explorer" });
  assert.match(file.text, /Revealed package\.json in the file explorer/);
  const folder = await tool.execute({ path: "src", target: "explorer" });
  assert.match(folder.text, /Revealed src in the file explorer/);
  assert.deepEqual(calls.map((call) => call.action), ["reveal", "reveal"]);
  const folderInEditor = await tool.execute({ path: "src" });
  assert.equal(folderInEditor.isError, true);
  assert.match(folderInEditor.text, /is a folder/);
});

test("open tool rejects missing, escaping, and invalid targets", async () => {
  const { host } = recorder();
  const tool = createOpenTool(cwd, host);
  const missing = await tool.execute({ path: "does-not-exist.txt" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /file not found/);
  const escaping = await tool.execute({ path: "../outside.txt" });
  assert.equal(escaping.isError, true);
  assert.match(escaping.text, /escapes the workspace/);
  const badTarget = await tool.execute({ path: "package.json", target: "browser" });
  assert.equal(badTarget.isError, true);
});

test("opening a file is read-only so plan mode permits it", () => {
  assert.equal(decide("plan", "open", { path: "package.json" }, true).effect, "allow");
  assert.equal(decide("auto", "open", { path: "package.json" }, true).effect, "allow");
});

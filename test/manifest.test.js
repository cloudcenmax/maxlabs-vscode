import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const viewSource = await readFile(new URL("../src/view.ts", import.meta.url), "utf8");
const webviewSource = await readFile(new URL("../media/main.js", import.meta.url), "utf8");

test("manifest exposes chat, commands, and secure defaults", () => {
  assert.equal(manifest.main, "./dist/extension.js");
  assert.ok(manifest.contributes.views.maxlabs.some((view) => view.id === "maxlabs.chat"));
  assert.ok(manifest.contributes.commands.some((command) => command.command === "maxlabs.login"));
  assert.ok(manifest.contributes.commands.some((command) => command.command === "maxlabs.switchAccount"));
  assert.ok(manifest.contributes.commands.some((command) => command.command === "maxlabs.newChat" && command.title.includes("Tab")));
  assert.ok(manifest.contributes.commands.some((command) => command.command === "maxlabs.resetChat"));
  assert.equal(manifest.contributes.configuration.properties["maxlabs.model"].default, "worker");
  assert.equal(manifest.contributes.configuration.properties["maxlabs.thinking"].default, "low");
});

test("new chat is available from the editor title bar", () => {
  assert.ok(manifest.contributes.menus["editor/title"].some((item) => item.command === "maxlabs.newChat"));
});

test("authentication is consolidated into the composer account menu", () => {
  assert.ok(viewSource.includes('id="accountMenuButton"'));
  assert.ok(viewSource.includes('id="accountOptions"'));
  assert.ok(viewSource.includes('id="addAccount"'));
  assert.ok(viewSource.includes('id="logoutAll"'));
  assert.ok(viewSource.includes('id="accountOAuth"'));
  assert.ok(viewSource.includes('id="accountApi"'));
  assert.ok(viewSource.includes('id="removeApi"'));
  assert.ok(webviewSource.includes('type: "removeApiKey"'));
  assert.ok(webviewSource.includes('"switchAccount"'));
  assert.ok(!viewSource.includes('id="login"'));
  assert.ok(!viewSource.includes('id="api"'));
});

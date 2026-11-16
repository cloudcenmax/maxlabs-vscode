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

test("running turns expose a stop button and an estimated thinking counter", () => {
  assert.ok(viewSource.includes('id="stop"'));
  assert.ok(webviewSource.includes('type: "stop"'));
  assert.ok(webviewSource.includes('message.type === "thinking"'));
  assert.match(webviewSource, /Thinking · ~/);
  assert.ok(viewSource.includes("thinking(text: string)"));
});

test("background terminal tool and command are wired into the extension", async () => {
  const toolsSource = await readFile(new URL("../src/tools.ts", import.meta.url), "utf8");
  const agentSource = await readFile(new URL("../src/agent.ts", import.meta.url), "utf8");
  assert.ok(toolsSource.includes("createTerminalTool"));
  assert.ok(agentSource.includes("terminal tool"));
  assert.ok(manifest.contributes.commands.some((command) => command.command === "maxlabs.stopTerminals"));
  assert.ok(viewSource.includes('id="stop"'));
});

test("customer-visible agent surfaces stay Cenmax AI branded", async () => {
  const names = ["src/view.ts", "media/main.js", "src/terminal-tool.ts", "src/terminals.ts", "src/extension.ts", "src/agent.ts", "src/transport.ts", "src/cloud.ts", "media/images.js"];
  const forbidden = /openrouter|deepseek|qwen|mimo|gpt-oss|anthropic|openai|azure/i;
  for (const name of names) {
    const source = await readFile(new URL(`../${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, forbidden, `${name} must not name an upstream provider`);
  }
  assert.match(viewSource, /Cenmax AI/);
  const transportSource = await readFile(new URL("../src/transport.ts", import.meta.url), "utf8");
  assert.doesNotMatch(transportSource, /Gateway (returned|stream)/);
  assert.doesNotMatch(webviewSource, /Cenmax AI gateway/i);
});

test("file opening, image paste, and account tools are wired end to end", async () => {
  const toolsSource = await readFile(new URL("../src/tools.ts", import.meta.url), "utf8");
  const authSource = await readFile(new URL("../src/auth.ts", import.meta.url), "utf8");
  const extensionSource = await readFile(new URL("../src/extension.ts", import.meta.url), "utf8");
  assert.ok(toolsSource.includes("createOpenTool"));
  assert.ok(toolsSource.includes("createTerminalTool"));
  assert.ok(viewSource.includes('id="attachments"'));
  assert.match(viewSource, /img-src \$\{webview\.cspSource\} data:/);
  assert.ok(webviewSource.includes("imageFilesFromPaste"));
  assert.ok(webviewSource.includes('"paste"'));
  assert.ok(webviewSource.includes('type: "send", text, images'));
  assert.match(authSource, /workspace:read mcp:execute/);
  assert.ok(extensionSource.includes("CloudWorkspace"));
  assert.ok(extensionSource.includes("createSkillTool"));
  assert.ok(extensionSource.includes("loadCloud"));
  assert.ok(extensionSource.includes("safeGatewayUrl"));
  assert.ok(extensionSource.includes("safeApiBaseUrl"));
  assert.ok(extensionSource.includes("workspace.isTrusted"));
});

test("security-sensitive settings are application-scoped and untrusted workspaces are unsupported", () => {
  const properties = manifest.contributes.configuration.properties;
  for (const key of ["maxlabs.gatewayUrl", "maxlabs.apiBaseUrl", "maxlabs.mode"]) {
    assert.equal(properties[key].scope, "application", `${key} must not be workspace-overridable`);
  }
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false);
});

test("network, sensitive-read, and approval hardening are wired into source", async () => {
  const toolsSource = await readFile(new URL("../src/tools.ts", import.meta.url), "utf8");
  const authSource = await readFile(new URL("../src/auth.ts", import.meta.url), "utf8");
  const agentSource = await readFile(new URL("../src/agent.ts", import.meta.url), "utf8");
  const securitySource = await readFile(new URL("../src/security.ts", import.meta.url), "utf8");
  assert.ok(toolsSource.includes("requestPublicPage"));
  assert.ok(!toolsSource.includes("publicUrl("));
  assert.ok(toolsSource.includes("isSensitivePath"));
  assert.ok(toolsSource.includes("MAX_GREP_PATTERN"));
  assert.ok(authSource.includes("isSafeVerificationUrl"));
  assert.ok(agentSource.includes("approvalDetail"));
  assert.ok(securitySource.includes("hasLeadingAssignment"));
  assert.ok(securitySource.includes("longRunningWorkspaceServer"));
});

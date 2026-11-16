import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBrowserTool } from "../dist/browser.js";
import { decide } from "../dist/security.js";

/**
 * The extension host itself cannot be loaded under `node --test`, so these tests
 * exercise the pieces that carry the behaviour: the tool's argument mapping, its
 * URL policy and the security decision. A stubbed runner means no browser is
 * needed and the assertions are about what would have been executed.
 */

function recorder(output = "### Page\n- Page URL: http://localhost:3000/", failed = false) {
  const calls = [];
  const runner = {
    async run(workdir, args) { calls.push({ workdir, args }); return { output, failed }; },
  };
  return { calls, runner };
}

async function workspace() {
  return mkdtemp(join(tmpdir(), "cenmax-browser-"));
}

test("browser tool keeps its public description neutral about the engine", async () => {
  const tool = createBrowserTool(await workspace(), recorder().runner);
  assert.equal(tool.schema.name, "browser");
  const description = tool.schema.description.toLowerCase();
  for (const implementation of ["playwright", "chromium", "puppeteer"]) {
    assert.ok(!description.includes(implementation), `description leaks ${implementation}`);
  }
});

test("browser tool maps each action onto the CLI arguments", async () => {
  const cases = [
    [{ action: "open", url: "http://localhost:3000/app" }, "open http://localhost:3000/app"],
    [{ action: "snapshot" }, "snapshot"],
    [{ action: "click", ref: "e12" }, "click e12"],
    [{ action: "fill", ref: "e4", text: "hello" }, "fill e4 hello"],
    [{ action: "press", key: "Enter" }, "press Enter"],
    [{ action: "goto", url: "https://example.test/" }, "goto https://example.test/"],
    [{ action: "screenshot" }, "screenshot"],
    [{ action: "console" }, "console"],
    [{ action: "requests" }, "requests"],
    [{ action: "close" }, "close"],
  ];

  for (const [args, expected] of cases) {
    const { calls, runner } = recorder();
    const tool = createBrowserTool(await workspace(), runner);
    const result = await tool.execute(args);
    assert.ok(!result.isError, `${args.action} failed: ${result.text}`);
    assert.equal(calls.length, 1);
    assert.match(calls[0].args[0], /^-s=cenmax-[0-9a-f]{12}$/, "every call names its session");
    assert.equal(calls[0].args.slice(1).join(" "), expected);
  }
});

test("browser tool refuses URLs that are not plain http or https", async () => {
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,<h1>x</h1>", "ftp://example.test/", "http://user:secret@example.test/"]) {
    const { calls, runner } = recorder();
    const tool = createBrowserTool(await workspace(), runner);
    const result = await tool.execute({ action: "open", url });
    assert.equal(result.isError, true, `${url} was accepted`);
    assert.equal(calls.length, 0, `${url} still spawned a process`);
  }
});

test("browser tool reaches the developer's own dev server", async () => {
  for (const url of ["http://localhost:3000", "http://127.0.0.1:8080/", "https://example.test/"]) {
    const { calls, runner } = recorder();
    const tool = createBrowserTool(await workspace(), runner);
    const result = await tool.execute({ action: "open", url });
    assert.ok(!result.isError, `${url} was refused: ${result.text}`);
    assert.equal(calls.length, 1, `${url} did not reach the browser`);
  }
});

test("browser tool explains how to recover when a ref is missing", async () => {
  for (const action of ["click", "fill", "type"]) {
    const { calls, runner } = recorder();
    const tool = createBrowserTool(await workspace(), runner);
    const result = await tool.execute({ action, text: "x" });
    assert.equal(result.isError, true);
    assert.match(result.text, /snapshot first/);
    assert.equal(calls.length, 0);
  }
});

test("browser tool bounds a large result", async () => {
  const tool = createBrowserTool(await workspace(), recorder("a long accessibility snapshot line\n".repeat(20_000)).runner);
  const result = await tool.execute({ action: "snapshot" });
  assert.ok(result.text.length < 64 * 1024, `result was ${result.text.length} characters`);
  assert.match(result.text, /bytes omitted/);
});

test("browser tool keeps artifacts in one predictable place", async () => {
  const { calls, runner } = recorder();
  const tool = createBrowserTool(await workspace(), runner);
  await tool.execute({ action: "snapshot" });
  assert.match(calls[0].workdir.replaceAll("\\", "/"), /\/\.cenmax\/browser$/);
});

test("browser tool reports a failure the model can act on", async () => {
  const tool = createBrowserTool(await workspace(), recorder("Error: browser is not installed", true).runner);
  const result = await tool.execute({ action: "open", url: "http://localhost:3000" });
  assert.match(result.text, /browser is not installed/);
});

test("auto mode leaves page observation unattended and reviews page actions", async () => {
  const root = await workspace();
  const tool = createBrowserTool(root, recorder().runner);

  for (const action of ["snapshot", "console", "requests"]) {
    const decision = decide("auto", tool.schema.name, { action }, tool.readOnly, root);
    assert.equal(decision.effect, "allow", `${action} was not allowed in auto mode`);
  }

  const open = decide("auto", "browser", { action: "open", url: "http://localhost:3000" }, false, root);
  assert.equal(open.effect, "allow", `open was not allowed: ${open.reason}`);

  for (const action of ["click", "fill", "press", "goto"]) {
    const decision = decide("auto", "browser", { action, ref: "e1" }, false, root);
    assert.notEqual(decision.effect, "deny", `${action} was denied outright`);
    assert.notEqual(decision.reason, '"browser" is not a tool the auto policy knows');
  }
});

test("a screenshot becomes an image the model can see", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "cenmax-vs-img-"));
  const dir = join(root, ".cenmax", "browser");
  await mkdir(dir, { recursive: true });

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64)]);
  await writeFile(join(dir, "shot.png"), png);

  const tool = createBrowserTool(root, recorder("### Ran\n- [screenshot](shot.png)").runner);
  const result = await tool.execute({ action: "screenshot" });

  assert.ok(result.images && result.images.length === 1, "the screenshot was not attached");
  const image = result.images[0];
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.digest.length, 64);
  assert.equal(Buffer.from(image.data, "base64").length, png.length);
  assert.match(result.text, /shot\.png/, "the result should still name the saved file");
});

test("an oversized screenshot is saved but not attached", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "cenmax-vs-big-"));
  const dir = join(root, ".cenmax", "browser");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "big.png"), Buffer.alloc(4_000_000, 1));

  const tool = createBrowserTool(root, recorder("### Ran\n- [x](big.png)").runner);
  const result = await tool.execute({ action: "screenshot" });

  assert.equal(result.images, undefined, "an oversized screenshot reached model context");
  assert.match(result.text, /not attached/);
});

test("a missing screenshot file is reported honestly", async () => {
  const root = await mkdtemp(join(tmpdir(), "cenmax-vs-gone-"));
  const tool = createBrowserTool(root, recorder("### Ran\n- [x](gone.png)").runner);
  const result = await tool.execute({ action: "screenshot" });
  assert.equal(result.images, undefined);
  assert.match(result.text, /not readable/);
});

test("only a screenshot action attaches an image", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "cenmax-vs-only-"));
  const dir = join(root, ".cenmax", "browser");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "p.png"), Buffer.alloc(16, 2));

  const tool = createBrowserTool(root, recorder("### Page\n- [x](p.png)").runner);
  const result = await tool.execute({ action: "snapshot" });
  assert.equal(result.images, undefined, "a snapshot attached an image");
});
test("plan mode refuses browser actions that change the page", async () => {
  const decision = decide("plan", "browser", { action: "click", ref: "e1" }, false, await workspace());
  assert.equal(decision.effect, "deny");
});

test("a browser call carrying a credential is refused", async () => {
  const decision = decide("auto", "browser", { action: "fill", ref: "e1", text: "sk-abcdefghijklmnopqrstuvwx" }, false, await workspace());
  assert.equal(decision.effect, "deny");
});

import assert from "node:assert/strict";
import test from "node:test";
import { markdown } from "../media/markdown.js";

test("renders GitHub-style tables with alignment", () => {
  const html = markdown("| Model | Input | Output |\n|:---|---:|:---:|\n| Worker | $1 | $3 |");
  assert.match(html, /<table>/);
  assert.match(html, /<th style="text-align:left">Model<\/th>/);
  assert.match(html, /<th style="text-align:right">Input<\/th>/);
  assert.match(html, /<td style="text-align:center">\$3<\/td>/);
});

test("escapes table contents and supports escaped pipes", () => {
  const html = markdown("Name | Value\n--- | ---\n&lt;script&gt; | left \\| right");
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /left \| right/);
});

test("recovers a streamed table whose first header cell was dropped", () => {
  const html = markdown("## Status |\n|---|---|\n| Phase 0 | Complete |\n| v4 | In progress |");
  assert.match(html, /<table>/);
  assert.match(html, /<th>Item<\/th><th>Status<\/th>/);
  assert.doesNotMatch(html, /<h2>/);
});

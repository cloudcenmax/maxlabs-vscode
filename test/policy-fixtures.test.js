import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decide } from "../dist/security.js";

const file = JSON.parse(readFileSync(new URL("../../policy/auto-cases.json", import.meta.url), "utf8"));

for (const fixture of file.cases) {
  test(`shared policy: ${fixture.name}`, () => {
    const args = fixture.arguments || {};
    for (const [mode, expected] of [["auto", fixture.auto], ["full", fixture.full]]) {
      const decision = decide(mode, fixture.tool, args, fixture.readOnly, file.workspace);
      assert.equal(decision.effect, expected, `${mode}: ${decision.reason}`);
    }
  });
}

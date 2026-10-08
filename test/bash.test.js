import assert from "node:assert/strict";
import test from "node:test";
import { stripRedundantWorkspaceCd } from "../dist/bash.js";

const root = "/Applications/XAMPP/xamppfiles/htdocs/maxlabs";

test("removes an absolute cd to the current workspace", () => {
  assert.equal(stripRedundantWorkspaceCd(`cd "${root}" && php artisan test`, root), "php artisan test");
});

test("removes a relative cd to the current workspace", () => {
  assert.equal(stripRedundantWorkspaceCd("cd . && npm test", root), "npm test");
});

test("preserves directory changes that alter the working directory", () => {
  for (const command of ["cd gateway && php artisan test", "cd .. && pwd", "cd / && ls"]) {
    assert.equal(stripRedundantWorkspaceCd(command, root), command);
  }
});

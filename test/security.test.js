import assert from "node:assert/strict";
import test from "node:test";
import { decide, isReadOnlyCommand, riskReason } from "../dist/security.js";

test("plan mode denies mutations", () => {
  assert.equal(decide("plan", "write", { path: "a" }, false).effect, "deny");
});

test("auto mode allows audited workspace edits", () => {
  assert.equal(decide("auto", "edit", { path: "a" }, false).effect, "allow");
});

test("read-only shell operations are detected", () => {
  assert.equal(isReadOnlyCommand("git status && rg hello src"), true);
  assert.equal(decide("auto", "bash", { command: "git status" }, false).effect, "allow");
});

test("destructive and drifting commands always ask", () => {
  for (const command of ["rm -rf build", "cd .. && rm file", "git reset --hard", "node -e 'doStuff()'", "echo ok > result.txt", "sudo make install", "curl https://example.com", "php artisan migrate:fresh", "find build -type f -print0 | xargs -0 rm"]) {
    assert.equal(decide("auto", "bash", { command }, false).effect, "ask", command);
    assert.ok(riskReason("bash", { command }), command);
  }
});

test("safe sink redirects remain read-only", () => {
  assert.equal(isReadOnlyCommand("rg token . 2>/dev/null"), true);
});

test("auto mode runs ordinary workspace commands without prompting", () => {
  for (const command of ["./vendor/bin/pest tests/Unit 2>&1 | tail -40", "php artisan test --compact", "npm run build", "composer install", "for f in src/*.ts; do wc -l \"$f\"; done", "n=$(find src -type f | wc -l); echo $n"]) {
    assert.equal(decide("auto", "bash", { command }, false).effect, "allow", command);
  }
  assert.equal(decide("auto", "webfetch", { url: "https://example.com" }, false).effect, "allow");
});

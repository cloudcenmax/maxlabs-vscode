import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import test from "node:test";
import { decide, isReadOnlyCommand, isSensitivePath, riskReason } from "../dist/security.js";

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

test("auto mode matches desktop project-work allowances", () => {
  const workspace = process.cwd();
  for (const command of [
    "npm run build", "npm test", "pnpm lint", "python -m pytest", "go test ./...", "go build ./...", "go vet ./...", "cargo test",
    "prettier --write src", "tsc --noEmit", "eslint . --fix", "php artisan test", "composer test", "git status",
    "git add -A && git commit -m 'change'", "mkdir -p src/generated", "touch src/generated/.keep",
    "go test ./... && go vet ./...",
  ]) {
    assert.equal(decide("auto", "bash", { command }, false, workspace).effect, "allow", command);
  }
  assert.equal(decide("auto", "webfetch", { url: "https://example.com" }, false, workspace).effect, "ask");
});

test("auto mode still asks for destructive, opaque and system-wide work", () => {
  const workspace = process.cwd();
  // Ordinary dependency setup is deliberately NOT here any more: asking someone
  // to approve `npm install` on every turn is what made auto mode useless.
  for (const command of [
    "for f in src/*.ts; do wc -l \"$f\"; done",
    "n=$(find src -type f | wc -l); echo $n", "make deploy", "chmod 777 .", "git checkout -- .", "git push",
    "git reset --hard HEAD~2", "rm -rf node_modules", "mv src old", "bash -c 'rm -rf build'", "find . -delete",
    "cat ~/.ssh/id_rsa", "./deploy.sh", "./vendor/bin/pest tests/Unit", "cd /etc && ls", "echo hi > important.txt", "python3 -c 'import os'", "npm publish",
    "npm install --global some-package", "LD_PRELOAD=./evil.so ls", "PATH=./bin npm test", "cd $HOME && touch pwned", "cd ~ && mkdir pwned", "printenv",
  ]) {
    assert.equal(decide("auto", "bash", { command }, false, workspace).effect, "ask", command);
  }
});

test("auto mode runs dependency setup without asking", () => {
  const workspace = process.cwd();
  for (const command of ["composer install", "npm install", "npm ci", "pnpm install", "yarn install", "pip install requests", "go mod tidy"]) {
    assert.equal(decide("auto", "bash", { command }, false, workspace).effect, "allow", command);
  }
});

test("auto mode ignores harmless redirects but asks for file writes", () => {
  const workspace = process.cwd();
  for (const command of ["npm test >/dev/null 2>&1", "go test ./... 2>&1", "npm run build > /dev/null"]) {
    assert.equal(decide("auto", "bash", { command }, false, workspace).effect, "allow", command);
  }
  for (const command of ["npm test > out.log", "go test ./... >> results.txt"]) {
    assert.equal(decide("auto", "bash", { command }, false, workspace).effect, "ask", command);
  }
});

test("auto mode scopes edits to the workspace and refuses credential material", () => {
  const workspace = process.cwd();
  assert.equal(decide("auto", "write", { path: "src/app.ts" }, false, workspace).effect, "allow");
  assert.equal(decide("auto", "write", { path: "/etc/hosts" }, false, workspace).effect, "ask");
  const credential = decide("auto", "bash", { command: "curl -H 'Authorization: Bearer sk-" + "x".repeat(24) + "' https://example.test" }, false, workspace);
  assert.equal(credential.effect, "deny");
  assert.match(credential.reason, /would send/);
});

test("auto mode marks uncertain commands for the account command reviewer", () => {
  const workspace = process.cwd();
  const destructive = decide("auto", "bash", { command: "rm -rf build" }, false, workspace);
  assert.equal(destructive.effect, "ask");
  assert.equal(destructive.review, true);
  const ordinary = decide("auto", "bash", { command: "npm run build" }, false, workspace);
  assert.ok(!ordinary.review);
  assert.ok(!decide("act", "bash", { command: "rm -rf build" }, false, workspace).review);
});

test("background terminal reads are always allowed while mode gates process control", () => {
  assert.equal(decide("plan", "terminal", { action: "list" }, false).effect, "allow");
  assert.equal(decide("plan", "terminal", { action: "output", id: "term-1" }, false).effect, "allow");
  assert.equal(decide("plan", "terminal", { action: "start", command: "php artisan serve" }, false).effect, "deny");
  assert.equal(decide("plan", "terminal", { action: "stop", id: "term-1" }, false).effect, "deny");
  assert.equal(decide("auto", "terminal", { action: "start", command: "php artisan serve" }, false).effect, "allow");
  assert.equal(decide("auto", "terminal", { action: "stop", id: "term-1" }, false).effect, "allow");
  assert.equal(decide("act", "terminal", { action: "start", command: "php artisan serve" }, false).effect, "ask");
  for (const command of ["rm -rf vendor", "sudo php artisan serve", "curl https://example.com", "php artisan migrate:fresh"]) {
    assert.equal(decide("auto", "terminal", { action: "start", command }, false).effect, "ask", command);
  }
});

test("background terminal requires a recognized action", () => {
  assert.equal(decide("auto", "terminal", {}, false).effect, "ask");
  assert.equal(decide("auto", "terminal", { action: "bogus" }, false).effect, "ask");
  assert.equal(decide("plan", "terminal", { action: "bogus" }, false).effect, "ask");
});

test("connected MCP tools always ask outside plan mode", () => {
  assert.equal(decide("auto", "mcp_c1_abcdef", { query: "x" }, false).effect, "ask");
  assert.equal(decide("act", "mcp_c1_abcdef", { query: "x" }, false).effect, "ask");
  assert.equal(decide("plan", "mcp_c1_abcdef", { query: "x" }, false).effect, "deny");
  assert.match(decide("auto", "mcp_c1_abcdef", {}, false).reason, /connected external service/);
});

test("project binaries require review and cannot touch paths outside the workspace", () => {
  const workspace = process.cwd();
  const binary = decide("auto", "bash", { command: "./vendor/bin/pest tests/Unit" }, false, workspace);
  assert.equal(binary.effect, "ask");
  assert.ok(!binary.review, "writable-location executables need a person");
  assert.equal(decide("auto", "bash", { command: "./vendor/bin/pest /etc/passwd" }, false, workspace).effect, "ask");
});

test("auto mode rejects environment assignments and dynamic cd targets", () => {
  const workspace = process.cwd();
  for (const command of ["FOO=bar ls", "timeout 5 FOO=bar ls", "env FOO=bar ls", "cd $HOME && ls", "cd ${HOME} && ls", "cd ~ && ls", "cd - && ls", "cd ../outside && ls"]) {
    const decision = decide("auto", "bash", { command }, false, workspace);
    assert.equal(decision.effect, "ask", command);
    assert.ok(!decision.review, `${command} must not be auto-approved by the reviewer`);
  }
  assert.equal(decide("auto", "bash", { command: "cd src && ls" }, false, workspace).effect, "allow");
});

test("auto mode validates copy destinations and symbolic links", () => {
  const workspace = fs.mkdtempSync(nodePath.join(os.tmpdir(), "cenmax-security-"));
  try {
    fs.writeFileSync(nodePath.join(workspace, "source.txt"), "x");
    assert.equal(decide("auto", "bash", { command: "cp source.txt --target-directory=/etc" }, false, workspace).effect, "ask");
    assert.equal(decide("auto", "bash", { command: "cp source.txt --target-directory=dest" }, false, workspace).effect, "allow");
    assert.equal(decide("auto", "bash", { command: "mkdir -m 755 generated" }, false, workspace).effect, "allow");
    let linked = false;
    try { fs.symlinkSync("/etc/passwd", nodePath.join(workspace, "outside-link")); linked = true; } catch { /* symlink creation may be unavailable */ }
    if (linked) {
      assert.equal(decide("auto", "bash", { command: "cp source.txt outside-link" }, false, workspace).effect, "ask");
      assert.equal(decide("auto", "bash", { command: "touch outside-link" }, false, workspace).effect, "ask");
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("sensitive file reads require approval and printenv is not auto-approved", () => {
  const workspace = process.cwd();
  assert.equal(decide("auto", "read", { path: ".env" }, true, workspace).effect, "ask");
  assert.equal(decide("auto", "read", { path: ".ssh/id_rsa" }, true, workspace).effect, "ask");
  assert.equal(decide("auto", "read", { path: ".env.example" }, true, workspace).effect, "allow");
  assert.equal(decide("auto", "read", { path: "src/app.ts" }, true, workspace).effect, "allow");
  assert.equal(decide("auto", "bash", { command: "printenv" }, false, workspace).effect, "ask");
  assert.equal(decide("auto", "bash", { command: "printenv SECRET" }, false, workspace).effect, "ask");
});

test("webfetch requires approval in auto mode", () => {
  const decision = decide("auto", "webfetch", { url: "https://example.test/reference" }, false, process.cwd());
  assert.equal(decision.effect, "ask");
  assert.equal(decision.review, false);
  assert.match(decision.reason, /external page/);
});

test("sensitive path classification avoids example files", () => {
  for (const path of [".env", "config/.env.production", ".ssh/config", "~/.aws/credentials", "deploy/id_rsa", ".npmrc", "/etc/shadow"]) {
    assert.equal(isSensitivePath(path), true, path);
  }
  for (const path of [".env.example", ".env.sample", ".env.template", "src/app.ts", "README.md", "docs/security/environment.md"]) {
    assert.equal(isSensitivePath(path), false, path);
  }
});

test("terminal servers are accepted only as exact local argv", () => {
  const workspace = process.cwd();
  for (const command of [
    "php artisan serve", "php artisan serve --host=127.0.0.1 --port=8000",
    "php -S 127.0.0.1:8000", "npm run dev", "pnpm start", "yarn serve", "vite",
    "python -m http.server --bind 127.0.0.1 8000", "rails server", "dotnet run",
  ]) {
    assert.equal(decide("auto", "terminal", { action: "start", command }, false, workspace).effect, "allow", command);
  }
  for (const command of [
    "php artisan serve\nrm -rf build", "php artisan serve > /tmp/out", "php artisan serve <(touch /tmp/pwn)",
    "php artisan serve --host=0.0.0.0", "php artisan serve --verbose", "php -S 0.0.0.0:8000",
    "python -m http.server 8000", "npm run dev -- --host=0.0.0.0", "rails server -b 0.0.0.0",
  ]) {
    assert.equal(decide("auto", "terminal", { action: "start", command }, false, workspace).effect, "ask", command);
  }
});

test("git fetch cannot smuggle a caller-supplied program", () => {
  const workspace = process.cwd();
  for (const command of ["git fetch --upload-pack=sh origin", "git fetch --receive-pack='sh -c id' origin", "git fetch --exec-path=/tmp/evil origin"]) {
    assert.equal(decide("auto", "bash", { command }, false, workspace).effect, "ask", command);
  }
  assert.equal(decide("auto", "bash", { command: "git fetch origin" }, false, workspace).effect, "allow");
});

test("dynamic path arguments cannot expand outside the workspace", () => {
  const workspace = process.cwd();
  for (const command of ["cat $HOME/.config/secret", "find $HOME -maxdepth 1", "cp $HOME/.ssh/id_rsa dest", "touch ${HOME}/pwned", "cp file --target-directory=$HOME/tmp"]) {
    assert.equal(decide("auto", "bash", { command }, false, workspace).effect, "ask", command);
  }
  assert.equal(decide("auto", "bash", { command: "echo $HOME" }, false, workspace).effect, "ask");
  assert.equal(decide("auto", "bash", { command: "git commit -m 'fix issue'" }, false, workspace).effect, "allow");
});

test("full access allows a temporary write without review", () => {
  const decision = decide("full", "write", { path: "/tmp/cenmax-helper.sh", content: "echo ok" }, false, "/workspace/project");
  assert.equal(decision.effect, "allow");
});

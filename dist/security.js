import { realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
                                          

                                                                                                                                 
                                                     

const readOnlyCommands = new Set([
  "ls", "cat", "head", "tail", "wc", "file", "stat", "tree", "du", "df", "realpath", "basename", "dirname", "readlink", "pwd", "find", "fd",
  "grep", "rg", "ag", "sort", "uniq", "cut", "tr", "sed", "awk", "jq", "diff", "comm", "column", "nl", "rev", "tac", "fold", "expand", "unexpand",
  "echo", "printf", "date", "true", "false", "whoami", "id", "uname", "hostname", "which", "type", "command", "env", "man", "help", "sleep", "test", "[",
]);
const readOnlySubcommands                                          = {
  git: { status: true, diff: true, log: true, show: true, branch: true, remote: true, tag: true, describe: true, blame: true, shortlog: true, "rev-parse": true, "ls-files": true, "cat-file": true, config: false, stash: false, worktree: false },
  go: { build: true, test: true, vet: true, list: true, fmt: false, env: true, doc: true, version: true, mod: false, get: false, install: false, run: false },
  npm: { test: true, ls: true, list: true, view: true, outdated: true },
  php: { "--version": true, "-v": true, "-r": false },
  node: { "--version": true, "-v": true, "-p": false, "-e": false },
  docker: { ps: true, images: true, version: true, logs: true, inspect: true },
  kubectl: { get: true, describe: true, logs: true, version: true },
};
const dangerousFlags                           = {
  find: ["-exec", "-execdir", "-delete", "-ok", "-okdir", "-fprint", "-fprint0", "-fls"],
  sed: ["-i", "--in-place"], awk: ["-i", "--in-place"], sort: ["-o", "--output"], tail: ["-f", "--follow"],
};
const freshApprovalCommands                         = {
  rm: "deletes files", rmdir: "deletes directories", unlink: "deletes a file", shred: "destroys file contents", truncate: "destroys file contents",
  mv: "moves or overwrites files", tee: "writes to files", xargs: "constructs and runs another command", parallel: "constructs and runs other commands",
  osascript: "runs automation code with desktop access", powershell: "runs an opaque script", pwsh: "runs an opaque script",
  bash: "runs an opaque script", dash: "runs an opaque script", fish: "runs an opaque script", sh: "runs an opaque script", zsh: "runs an opaque script",
};
const neverAutoCommands                         = {
  sudo: "escalates privilege", su: "escalates privilege", doas: "escalates privilege",
  ssh: "reaches another machine", scp: "copies to another machine", rsync: "can copy to another machine",
  nc: "opens a network connection", netcat: "opens a network connection", telnet: "opens a network connection",
  curl: "reaches the network", wget: "reaches the network", "git-push": "publishes",
  mkfs: "destroys a filesystem", dd: "writes raw devices", fdisk: "changes disks", diskutil: "changes disks",
  shutdown: "stops the machine", reboot: "stops the machine",
  crontab: "schedules work that outlives this session", at: "schedules work that outlives this session",
  eval: "runs a constructed command", exec: "replaces the running process",
};
const neverAutoPaths = [
  ".ssh/", ".aws/", ".gnupg/", ".kube/", ".docker/config.json", ".netrc", ".npmrc", ".pypirc", ".git-credentials",
  "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "authorized_keys", "known_hosts", "credentials.json", "service-account.json",
  ".env", ".env.local", ".env.production", "login.keychain", "keychain-db", "/etc/shadow", "/etc/sudoers", ".censi/session.json",
];
const credentialPatterns                          = [
  ["an AWS access key id", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["a GitHub token", /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/],
  ["a GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{22,}\b/],
  ["an API key", /\bsk-[A-Za-z0-9_-]{16,}\b/],
  ["a Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["a JSON web token", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ["a bearer token", /\bbearer\s+[A-Za-z0-9._~+/-]{20,}=*/i],
];
const egressTools = new Set(["bash", "terminal", "webfetch", "browser"]);

/** Desktop-parity decision. `workspace` is required for path-scoped auto rules. */
export function decide(mode      , tool        , args                         , readOnly         , workspace = "")           {
  if (tool === "terminal") {
    if (mode === "approve") {
      const auto = decideTerminal("auto", args, workspace);
      return auto.effect === "allow" ? auto : { ...ask("the independent AI reviewer decides this terminal action", false, auto.scope), review: true };
    }
    return decideTerminal(mode, args, workspace);
  }
  if (tool.startsWith("mcp_")) {
    const scope = `mcp:${tool}`;
    if (mode === "plan") return deny("plan mode refuses actions on connected services", scope);
    if (mode === "full") return allow("full auto: connected service", scope);
    if (mode === "approve") return { ...ask("the independent AI reviewer decides this connected action", false, scope), review: true };
    return ask("acts on a connected external service", false, scope);
  }
  const scope = approvalScope(tool, args);
  if (tool === "read" && isSensitivePath(String(args.path || ""))) {
    if (mode === "full") return allow("full auto: reads any path", scope);
    if (mode === "approve") return { ...ask("the independent AI reviewer decides reading this sensitive file", true, scope), review: true };
    return ask("reads a file that commonly holds credentials", true, scope);
  }
  if (readOnly) return allow("reads only", scope);
  if (mode === "plan") return deny("plan mode refuses workspace changes", scope);
  if (mode === "approve") return { ...ask("the independent AI reviewer decides this action", false, scope), review: true };
  if (mode === "full") {
    // Workspace-write sandbox + approval never; filesystem tools and the
    // workspace root remain the boundary. Network and remote services are allowed.
    return allow("full auto: workspace-write, no approvals", scope);
  }
  if (mode !== "auto") return ask(riskReason(tool, args) || "changes state", Boolean(riskReason(tool, args)), scope);

  const credentials = findCredentials(tool, args);
  if (credentials.length) return deny(`this call would send ${credentials.join(", ")} to ${tool}, which can reach the network`, scope);
  if (tool === "write" || tool === "edit") {
    const target = String(args.path || "");
    if (!pathWithinWorkspace(target, workspace)) {
      if (isTempPath(target)) return { ...ask(`writes a temporary helper to ${target}`, true, scope), review: true };
      return ask(`${tool} would change ${target || "an unknown path"}, outside the workspace`, false, scope);
    }
    return allow(`${tool} writes inside the workspace`, scope);
  }
  if (tool === "webfetch") return ask("fetches an external page, which can carry data off the machine", true, scope);
  if (tool === "bash") return assessAutoBash(String(args.command || ""), workspace, scope);
  if (tool === "browser") return decideBrowser(mode, args, scope);
  return ask(`"${tool}" is not a tool the auto policy knows`, false, scope);
}

/**
 * Judges one browser call.
 *
 * Observation is safe: a snapshot, the console log or the request list describe a
 * page the agent already opened, and reading them changes nothing. Acting changes
 * page state, but that state lives in the browser session this tool owns, not in
 * the workspace, so it is routed to the reviewer rather than made to interrupt.
 */
function decideBrowser(mode      , args                         , scope        )           {
  const action = String(args.action || "").trim().toLowerCase();
  if (["snapshot", "console", "requests"].includes(action)) {
    return allow("reads the page the session already opened", scope);
  }
  if (action === "open") {
    const target = String(args.url || "").trim().toLowerCase();
    if (!target || target.startsWith("http://") || target.startsWith("https://")) {
      return allow("opens a page in its own browser session", scope);
    }
    return deny("the browser would open something other than an http or https page", scope);
  }
  if (mode === "approve" || mode === "auto") {
    return { ...ask("changes the state of its own browser session", false, scope), review: true };
  }
  return ask("changes the state of its own browser session", true, scope);
}

function decideTerminal(mode      , args                         , workspace        )           {
  const action = String(args.action || "").trim().toLowerCase();
  const scope = `terminal:${action || "unknown"}`;
  if (action === "list" || action === "output") return allow("reads background terminal output", scope);
  if (action !== "start" && action !== "stop") return ask("unrecognized background terminal action", true, scope);
  if (mode === "plan") return deny("plan mode refuses state-changing commands", scope);
  if (action === "stop") return mode === "auto" || mode === "full" ? allow("stops a background process it started", scope) : ask("stops a background process", false, scope);
  if (mode !== "auto" && mode !== "full") return ask("starts a long-running process", false, scope);
  const credentials = findCredentials("terminal", args);
  if (credentials.length) return deny(`this call would send ${credentials.join(", ")} to a background process`, scope);
  const command = String(args.command || "");
  if (longRunningWorkspaceServer(command)) return allow("starts a long-running workspace server", scope);
  if (looksLikeWorkspaceServer(command)) return ask("starts a long-running server with arguments that need review", true, scope);
  const assessment = assessAutoBash(String(args.command || ""), workspace, scope);
  if (assessment.effect === "allow") return { ...assessment, reason: `starts a background workspace process (${assessment.reason})` };
  return assessment;
}

/** The deterministic auto policy, ported from the desktop/CLI harness. */
function looksLikeWorkspaceServer(command        )          {
  return /^(?:php\s+artisan\s+serve\b|php\s+-S\b|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve)\b|vite\b|python3?\s+-m\s+http\.server\b|rails\s+(?:server|s)\b|dotnet\s+run\b)/.test(command.trim());
}

function longRunningWorkspaceServer(command        )          {
  const value = command.trim();
  // Any control character, expansion, redirect, subshell or comment means this is
  // not the single server command the parser below is prepared to allow.
  if (!value || /[;&|`$<>()\\\n\r#]/.test(value)) return false;
  const tokens = splitFields(value);
  const first = tokens[0] || "";
  const second = tokens[1] || "";
  if (first === "php") {
    if (second === "artisan" && tokens[2] === "serve") return localServerArguments(tokens.slice(3));
    return second === "-S" && tokens.length === 3 && isLoopbackBind(tokens[2]);
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(first)) {
    if (second === "run" && ["dev", "start", "serve"].includes(tokens[2] || "") && tokens.length === 3) return true;
    return ["dev", "start", "serve"].includes(second) && tokens.length === 2;
  }
  if (first === "vite") return tokens.length === 1;
  if (first === "python" || first === "python3") {
    return tokens.length >= 4 && second === "-m" && tokens[2] === "http.server" && loopbackBindArguments(tokens.slice(3));
  }
  if (first === "rails") return tokens.length === 2 && (second === "server" || second === "s");
  return first === "dotnet" && tokens.length === 2 && second === "run";
}

function localServerArguments(args          )          {
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token.startsWith("--host=")) { if (!isLoopbackBind(token.slice(7))) return false; continue; }
    if (token === "--host") { if (!args[index + 1] || !isLoopbackBind(args[index + 1])) return false; index++; continue; }
    if (token.startsWith("--port=")) { if (!/^\d{1,5}$/.test(token.slice(7))) return false; continue; }
    if (token === "--port") { if (!args[index + 1] || !/^\d{1,5}$/.test(args[index + 1])) return false; index++; continue; }
    return false;
  }
  return true;
}

function loopbackBindArguments(args          )          {
  let bound = false;
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token.startsWith("--bind=")) { if (!isLoopbackBind(token.slice(7))) return false; bound = true; continue; }
    if (token === "--bind") { if (!args[index + 1] || !isLoopbackBind(args[index + 1])) return false; bound = true; index++; continue; }
    if (/^\d{1,5}$/.test(token)) continue;
    return false;
  }
  return bound;
}

function isLoopbackBind(value        )          {
  return /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i.test(value);
}

function assessAutoBash(command        , workspace        , scope        )           {
  const text = command.trim();
  if (!text) return ask("no command was given", true, scope, true);
  if (text.includes("$(") || text.includes("`")) return ask("runs a command inside another command, which cannot be read reliably", true, scope, true);
  if (hasWriteRedirect(text)) return ask("redirects output to a file", true, scope, true);
  const floor = onTheFloor(text);
  if (floor) return ask(floor, true, scope, true);
  const deletion = deletionReviewable(text, workspace);
  if (deletion) return ask(deletion, true, scope, true);
  const fresh = requiresFreshApproval(text);
  if (fresh) return ask(fresh, true, scope, true);
  // A project install is ordinary; a machine-wide one is not.
  const system = installsSystemWide(text);
  if (system) return ask(system, true, scope, true);
  const parts = splitCommands(stripOutputRedirections(text));
  if (!parts.length) return ask("the command could not be read", true, scope, true);
  const reasons           = [];
  for (const part of parts) {
    const auto = assessAutoPart(part, workspace);
    if (auto.allowed) { reasons.push(auto.reason); continue; }
    if (auto.risky) return ask(auto.reason, true, scope, !auto.hard);
    const simple = assessSimpleCommand(part);
    if (simple.effect === "allow") { reasons.push(simple.reason); continue; }
    return ask(simple.reason || "not a command auto mode can establish", true, scope, true);
  }
  return allow(`auto mode: ${unique(reasons).join(", ")}`, scope);
}

function assessAutoPart(part        , workspace        )                                                                       {
  const rawFields = splitFields(part);
  if (hasLeadingAssignment(rawFields)) return { allowed: false, risky: true, hard: true, reason: "sets environment variables for the command" };
  const fields = dropAssignments(stripWrappers(rawFields));
  if (!fields.length) return { allowed: false, risky: true, reason: "empty command" };
  let rawName = fields[0];
  const args = fields.slice(1);
  if (rawName.includes("/")) {
    // Any executable from a writable location (including project bins) needs review:
    // Auto also allows writes, so an allowlist here would be a write-and-run bypass.
    if (rawName.startsWith("./") || rawName.startsWith("../") || rawName.startsWith("/tmp/") || rawName.startsWith("/var/")) {
      return { allowed: false, risky: true, hard: true, reason: `runs ${rawName} from a writable location` };
    }
    rawName = path.basename(rawName);
  }
  if (rawName === "cd") {
    if (args.length !== 1) return { allowed: false, risky: true, hard: true, reason: "changes directory with a missing or extra target" };
    const target = args[0];
    if (/[$`~*?\[\]{}%]/.test(target) || target.startsWith("-")) return { allowed: false, risky: true, hard: true, reason: `changes directory using a dynamic or unsupported target: ${target}` };
    if (pathWithinWorkspace(target, workspace)) return { allowed: true, risky: false, reason: "cd" };
    return { allowed: false, risky: true, hard: true, reason: `changes directory to ${target}, outside the workspace` };
  }
  const outside = absoluteOutsideWorkspace(args, workspace);
  if (outside) return { allowed: false, risky: true, hard: true, reason: `touches ${outside}, outside the workspace` };
  const script = riskyScriptName(args);
  if (script) return { allowed: false, risky: true, reason: script };

  const sub = firstNonFlag(args);
  switch (rawName) {
    case "mkdir": case "touch": case "cp": case "mv": case "ln": case "tee": case "install": {
      const offending = pathArgumentsInside(args, workspace);
      if (offending) return { allowed: false, risky: true, hard: true, reason: `touches ${offending}, outside the workspace or through a symbolic link` };
      return { allowed: true, risky: false, reason: rawName };
    }
    case "chmod": case "chown": case "kill": case "pkill": case "killall": case "source": case ".":
      // Not on the floor, and ordinary project work, but they change something
      // the workspace's files do not contain. The isolated review decides.
      return { allowed: false, risky: true, reason: `${rawName} changes something outside the workspace's files` };
    case "go":
      if (oneOf(sub, "build", "test", "vet", "fmt", "tidy", "clean", "generate", "install", "run", "mod", "work", "doc", "list", "version")) return { allowed: true, risky: false, reason: `go ${sub}` };
      break;
    case "cargo":
      if (oneOf(sub, "build", "test", "check", "clippy", "fmt", "doc", "nextest", "run", "add", "remove", "update")) return { allowed: true, risky: false, reason: `cargo ${sub}` };
      break;
    case "npm": case "pnpm": case "yarn": case "bun":
      if (oneOf(sub, "test", "run", "lint", "build", "typecheck", "format", "check", "exec", "vitest", "jest", "install", "ci", "add", "remove", "uninstall", "start", "dev", "serve", "preview")) return { allowed: true, risky: false, reason: `${rawName} ${sub}` };
      break;
    case "npx": case "bunx":
      if (oneOf(sub, "tsc", "eslint", "prettier", "vitest", "jest", "vite", "next", "playwright", "tailwindcss")) return { allowed: true, risky: false, reason: `${rawName} ${sub}` };
      break;
    case "php":
      if (args.length && path.basename(args[0]) === "artisan") {
        const artisan = firstNonFlag(args.slice(1));
        // `serve` is excluded: `--host=0.0.0.0` publishes the workspace.
        if (oneOf(artisan, "test", "lint", "pint", "analyse", "migrate", "seed", "route", "config", "cache", "optimize")) return { allowed: true, risky: false, reason: `php artisan ${artisan}` };
      }
      if (args.length && args[0].endsWith(".php")) return { allowed: true, risky: false, reason: `php ${path.basename(args[0])}` };
      break;
    case "composer":
      if (oneOf(sub, "test", "validate", "install", "update", "dump-autoload", "require")) return { allowed: true, risky: false, reason: `composer ${sub}` };
      break;
    case "bundle":
      if (oneOf(sub, "install", "update", "exec")) return { allowed: true, risky: false, reason: `bundle ${sub}` };
      break;
    case "pip": case "pip3":
      if (oneOf(sub, "install", "list", "show", "freeze")) return { allowed: true, risky: false, reason: `${rawName} ${sub}` };
      break;
    case "dotnet":
      if (oneOf(sub, "build", "test", "run", "restore", "format")) return { allowed: true, risky: false, reason: `dotnet ${sub}` };
      break;
    case "swift":
      if (oneOf(sub, "build", "test", "run", "package")) return { allowed: true, risky: false, reason: `swift ${sub}` };
      break;
    case "docker": {
      if (oneOf(sub, "build", "ps", "logs", "images")) return { allowed: true, risky: false, reason: `docker ${sub}` };
      if (sub === "compose") {
        const action = firstNonFlagAfter(args, "compose");
        if (oneOf(action, "up", "build", "ps", "logs", "config")) return { allowed: true, risky: false, reason: `docker compose ${action}` };
        return { allowed: false, risky: true, reason: `docker compose ${action} can remove containers, networks, or volumes` };
      }
      break;
    }
    case "git":
      if (sub === "fetch" && containsAny(args, "--upload-pack", "--receive-pack", "--exec-path", "--config-env", "-c")) return { allowed: false, risky: true, reason: "git fetch with a caller-supplied program or config can execute code" };
      switch (sub) {
        case "add": case "commit": case "fetch": case "merge": case "rebase":
          return { allowed: true, risky: false, reason: `git ${sub}` };
        case "branch": case "tag":
          if (containsAny(args, "-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy", "-f", "--force")) return { allowed: false, risky: true, reason: `git ${sub} can delete or rewrite local work` };
          return { allowed: true, risky: false, reason: `git ${sub}` };
        case "stash":
          if (containsAny(args, "drop", "clear")) return { allowed: false, risky: true, reason: "git stash drop or clear deletes saved work" };
          return { allowed: true, risky: false, reason: "git stash" };
        case "switch": case "checkout":
          if (containsAny(args, "-b", "-c", "--create") || !containsAny(args, "--", ".")) return { allowed: true, risky: false, reason: `git ${sub}` };
          break;
      }
      break;
    case "tsc": case "eslint": case "prettier": case "vitest": case "jest": case "pytest": case "ruff": case "black": case "mypy": case "phpunit": case "gofmt": case "gofumpt": case "rustfmt": case "gradle": case "mvn":
      return { allowed: true, risky: false, reason: rawName };
    case "python": case "python3":
      if (args.length >= 2 && args[0] === "-m" && oneOf(args[1], "pytest", "unittest")) return { allowed: true, risky: false, reason: `python -m ${args[1]}` };
      break;
    case "make":
      return { allowed: false, risky: true, reason: "make can run arbitrary recipes, so it needs review" };
  }
  return { allowed: false, risky: false, reason: "" };
}

function assessSimpleCommand(command        )           {
  let fields = stripWrappers(splitFields(command));
  fields = dropAssignments(fields);
  if (!fields.length) return ask("empty command", true, "bash");
  let base = fields[0];
  if (base.includes("/")) {
    if (base.startsWith("./") || base.startsWith("../") || base.startsWith("/tmp/") || base.startsWith("/var/")) return ask(`runs ${base} from a writable location`, true, "bash");
    base = path.basename(base);
  }
  const subcommands = readOnlySubcommands[base];
  if (subcommands) {
    for (const arg of fields.slice(1)) {
      if (arg.startsWith("-")) continue;
      if (!(arg in subcommands)) return ask(`${base} ${arg} is not a recognised read-only subcommand`, true, "bash");
      return subcommands[arg] ? allow(`${base} ${arg} reads`, "bash") : ask(`${base} ${arg} changes things`, true, "bash");
    }
    return ask(`${base} with no subcommand does nothing useful`, true, "bash");
  }
  if (!readOnlyCommands.has(base)) return ask(`"${base}" is not a recognised read-only command`, true, "bash");
  for (const flag of dangerousFlags[base] || []) {
    if (fields.slice(1).some((field) => field === flag || field.startsWith(`${flag}=`))) return ask(`${base} ${flag} changes files`, true, "bash");
  }
  return allow(base, "bash");
}

function deletionReviewable(command        , workspace        )                     {
  const parts = splitCommands(command);
  let found = false;
  for (const part of parts) {
    const fields = dropAssignments(stripWrappers(splitFields(part)));
    if (!fields.length) continue;
    const name = path.basename(fields[0]);
    if (["rm", "rmdir", "unlink", "shred", "truncate"].includes(name)) {
      found = true;
      const targets = deletionTargets(fields.slice(1));
      if (!targets.length) return undefined;
      for (const target of targets) {
        if (!pathWithinWorkspace(target, workspace)) return undefined;
        if (target === "." || target === "./") return undefined;
        if (workspace && path.resolve(workspace, target) === path.resolve(workspace)) return undefined;
      }
      continue;
    }
    const auto = assessAutoPart(part, workspace);
    if (auto.allowed && !auto.risky) continue;
    if (auto.risky) return undefined;
    if (assessSimpleCommand(part).effect === "allow") continue;
    return undefined;
  }
  return found ? "deletes paths inside the workspace; an isolated review must confirm the request covers them" : undefined;
}

function onTheFloor(command        )                     {
  const privatePath = touchesSomethingPrivate(command);
  if (privatePath) return privatePath;
  const parts = splitCommands(command);
  for (const part of parts) {
    const fields = stripWrappers(splitFields(part));
    if (!fields.length) continue;
    const name = path.basename(fields[0]);
    const reason = neverAutoCommands[name];
    if (reason) return `${name} ${reason}`;
  }
  return undefined;
}

function touchesSomethingPrivate(command        )                     {
  const normalised = command.replace(/\$HOME\//g, "").replace(/~\//g, "").replace(/\$\{HOME\}\//g, "");
  for (const candidate of neverAutoPaths) {
    const needle = candidate.replace(/^\//, "");
    if (normalised.includes(needle)) return `touches ${candidate}, which holds credentials`;
  }
  return undefined;
}

function requiresFreshApproval(command        )                     {
  const text = command.trim();
  if (text.includes("$(") || text.includes("`")) return "the command runs hidden command substitution";
  if (hasWriteRedirect(text)) return "the command redirects output to a file";
  const floor = onTheFloor(text);
  if (floor) return floor;
  for (const part of splitCommands(text)) {
    const fields = dropAssignments(stripWrappers(splitFields(part)));
    if (!fields.length) continue;
    const name = path.basename(fields[0]);
    if (freshApprovalCommands[name]) return `${name} ${freshApprovalCommands[name]}`;
    if (name === "find" && containsAny(fields.slice(1), "-delete", "-exec", "-execdir", "-ok", "-okdir")) return "find can delete files or execute another command";
    if (name === "git" && containsAny(fields.slice(1), "clean", "reset", "push", "restore", "checkout")) return "the Git operation can discard work or publish changes";
    if (["python", "python3"].includes(name) && containsAny(fields.slice(1), "-c")) return `${name} executes inline code`;
    if (name === "node" && containsAny(fields.slice(1), "-e", "--eval")) return "node executes inline code";
    if (["perl", "ruby"].includes(name) && containsAny(fields.slice(1), "-e")) return `${name} executes inline code`;
    if (name === "php" && containsAny(fields.slice(1), "-r")) return "php executes inline code";
  }
  return undefined;
}

function findCredentials(tool        , args                         )           {
  if (!egressTools.has(tool)) return [];
  const text = JSON.stringify(args || {});
  const found           = [];
  for (const [name, pattern] of credentialPatterns) if (pattern.test(text) && !found.includes(name)) found.push(name);
  return found;
}

export function redactSecrets(text        )         {
  let value = text;
  for (const [name, pattern] of credentialPatterns) value = value.replace(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"), `[redacted ${name.replace(/^an? /, "")}]`);
  return value;
}

/** First risky thing in a command, used for explanatory text in act mode. */
export function riskReason(tool        , args                         )                     {
  if (tool !== "bash") return tool === "webfetch" ? "reaches the network" : undefined;
  const command = String(args.command || "").trim();
  if (!command) return "empty command";
  if (command.includes("`")) return "contains opaque backtick substitution";
  const substitutions = [...command.matchAll(/\$\(([^()]*)\)/g)];
  if (command.includes("$(") && !substitutions.length) return "contains nested or incomplete command substitution";
  for (const substitution of substitutions) { const nested = riskReason("bash", { command: substitution[1] }); if (nested) return `command substitution ${nested}`; }
  if (hasWriteRedirect(command)) return "redirects output to a file";
  if (/(^|[;&|]\s*)cd\s+(?:\/|~|\.\.)/.test(command)) return "changes outside the workspace before continuing";
  for (const segment of segments(command)) {
    const tokens = words(segment); const name = commandName(tokens);
    if (neverAutoCommands[name]) return `${name} ${neverAutoCommands[name]}`;
    if (freshApprovalCommands[name]) return `${name} ${freshApprovalCommands[name]}`;
    if (name === "xargs" && tokens.some((word) => ["rm", "mv", "tee"].includes(basename(word)))) return "xargs invokes a destructive command";
    if (name === "find" && tokens.some((word) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(word))) return "find can delete files or execute commands";
    if (name === "git" && tokens.some((word) => ["clean", "reset", "push", "restore", "checkout"].includes(word))) return "Git operation can discard or publish work";
    if (name === "npm" && tokens.some((word) => ["publish", "unpublish"].includes(word))) return "npm operation publishes or removes a package";
    if (name === "composer" && tokens.includes("config") && tokens.includes("--global")) return "Composer changes global configuration";
    if (name === "php" && tokens[1] === "artisan" && tokens.some((word) => ["db:wipe", "migrate:fresh", "migrate:refresh", "migrate:reset", "model:prune", "queue:clear"].includes(word))) return "Artisan operation can destroy persistent data";
    if (["python", "python3", "node", "php", "ruby", "perl"].includes(name) && tokens.some((word) => ["-c", "-e", "-r", "--eval"].includes(word))) return `${name} executes inline code`;
  }
  return undefined;
}

export function isReadOnlyCommand(command        )          {
  if (hasWriteRedirect(command)) return false;
  if (onTheFloor(command)) return false;
  const parts = splitCommands(command);
  if (!parts.length) return false;
  return parts.every((part) => assessSimpleCommand(part).effect === "allow");
}

function approvalScope(tool        , args                         )         {
  if (tool === "write" || tool === "edit") return `${tool}:${path.normalize(String(args.path || "unreadable"))}`;
  if (tool !== "bash" && tool !== "terminal") return tool;
  const command = String(args.command || "");
  const families = splitCommands(command).map((part) => {
    const fields = dropAssignments(stripWrappers(splitFields(part)));
    if (!fields.length) return "";
    let name = path.basename(fields[0]);
    const sub = firstNonFlag(fields.slice(1));
    if (sub) name += ` ${sub}`;
    if ((name.startsWith("npm run") || name.startsWith("pnpm run") || name.startsWith("yarn run")) && sub === "run") {
      const script = firstNonFlagAfter(fields.slice(1), "run");
      if (script) name += ` ${script}`;
    }
    return name;
  }).filter(Boolean);
  return `${tool}:${families.join("+") || "empty"}`;
}

function stripOutputRedirections(command        )         {
  return command.replace(/\s*\d*>&\d+/g, "").replace(/\s*\d*>\s*\/dev\/null/g, "");
}

function splitCommands(command        )           {
  const parts           = [];
  let current = "";
  let quote = "";
  const flush = ()       => { const text = current.trim(); if (text) parts.push(text); current = ""; };
  const characters = Array.from(command);
  for (let index = 0; index < characters.length; index++) {
    const char = characters[index];
    if (quote) { current += char; if (char === quote) quote = ""; continue; }
    if (char === "'" || char === '"') { quote = char; current += char; continue; }
    if (char === ";" || char === "\n") { flush(); continue; }
    if (char === "&" || char === "|") { flush(); if (characters[index + 1] === char) index++; continue; }
    if (char === "(" || char === ")") { flush(); continue; }
    current += char;
  }
  flush();
  return parts;
}

function hasWriteRedirect(command        )          {
  let quote = "";
  const characters = Array.from(command);
  for (let index = 0; index < characters.length; index++) {
    const char = characters[index];
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char !== ">") continue;
    let next = index + 1;
    if (characters[next] === ">") next++;
    while (characters[next] === " " || characters[next] === "\t") next++;
    if (next >= characters.length) return true;
    if (characters[next] === "&") { index = next; continue; }
    const start = next;
    while (next < characters.length && !" \t;|&()\n".includes(characters[next])) next++;
    const target = characters.slice(start, next).join("");
    if (!target || target === "/dev/null") { index = next - 1; continue; }
    return true;
  }
  return false;
}

function isTempPath(target        )          {
  const roots = ["/tmp", "/var/tmp", os.tmpdir()].map((root) => path.resolve(root));
  const resolved = path.resolve(target);
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}/`) || resolved.startsWith(`${root}\\`));
}

function pathWithinWorkspace(input        , workspace        )          {
  const value = input.trim();
  if (!value) return false;
  let expanded = value;
  if (value.startsWith("~/")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    expanded = path.join(home, value.slice(2));
  }
  if (!path.isAbsolute(expanded)) {
    if (!workspace) return true;
    expanded = path.join(workspace, expanded);
  }
  if (!workspace) return false;
  try {
    const root = resolveExistingPrefix(path.resolve(workspace));
    const target = resolveExistingPrefix(path.resolve(expanded));
    const relative = path.relative(root, target);
    return relative === "." || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
  } catch { return false; }
}

function resolveExistingPrefix(value        )         {
  try { return realpathSync(value); }
  catch { const parent = path.dirname(value); return parent === value ? value : path.join(resolveExistingPrefix(parent), path.basename(value)); }
}

function absoluteOutsideWorkspace(args          , workspace        )         {
  for (const arg of args) {
    if (arg.startsWith("-")) {
      const index = arg.indexOf("=");
      if (index > 0) {
        const value = arg.slice(index + 1);
        if (dynamicArgument(value)) return value;
        if (looksLikePath(value) && !pathWithinWorkspace(value, workspace)) return value;
      }
      continue;
    }
    if (arg.includes("://")) continue;
    if (dynamicArgument(arg) && (looksLikePath(arg) || arg.startsWith("$") || arg.startsWith("%"))) return arg;
    if (!looksLikePath(arg)) continue;
    if (!pathWithinWorkspace(arg, workspace)) return arg;
  }
  return "";
}

/** A shell expansion can turn an apparently workspace-local argument into any path. */
function dynamicArgument(value        )          {
  return /\$[A-Za-z_{(]/.test(value) || value.includes("`") || /%[A-Za-z_][A-Za-z0-9_]*%/.test(value);
}

function looksLikePath(value        )          {
  return Boolean(value) && !value.includes("://") && (path.isAbsolute(value) || value.startsWith("~/") || value.startsWith(".") || value.includes("/"));
}

/** Every path-like argument (and path-valued flag) must resolve inside the workspace. */
function pathArgumentsInside(args          , workspace        )                     {
  for (const arg of args) {
    if (!arg || arg === "--") continue;
    if (arg.startsWith("-")) {
      const index = arg.indexOf("=");
      if (index > 0) {
        const value = arg.slice(index + 1);
        if (dynamicArgument(value)) return value;
        if (looksLikePath(value) && !pathWithinWorkspace(value, workspace)) return value;
      }
      continue;
    }
    if (dynamicArgument(arg)) return arg;
    if (!pathWithinWorkspace(arg, workspace)) return arg;
  }
  return undefined;
}

/** Reject leading environment assignments: PATH/LD_PRELOAD would otherwise run code Auto never reviewed. */
function hasLeadingAssignment(fields          )          {
  for (let index = 0; index < fields.length; index++) {
    const token = fields[index];
    const name = path.basename(token);
    if (name === "env") continue;
    if (name === "timeout") { index += 1; continue; }
    if (["nice", "nohup", "stdbuf", "ionice", "command", "builtin", "caffeinate"].includes(name)) {
      while (fields[index + 1]?.startsWith("-")) index++;
      continue;
    }
    return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
  }
  return false;
}

/**
 * Reports a package-manager invocation that installs for the whole machine.
 *
 * Installing this project's dependencies is ordinary work; installing something
 * globally changes what every other project resolves, which is beyond the
 * workspace this turn was scoped to.
 */
function installsSystemWide(command        )                     {
  for (const field of splitFields(command)) {
    if (field === "-g" || field === "--global" || field === "--user" || field.startsWith("--global=")) {
      return `installs ${field} for the whole machine, not just this workspace`;
    }
  }
  return undefined;
}

function riskyScriptName(args          )                     {
  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (lower === "deploy" || lower === "publish" || lower === "release") return `"${arg}" is a publishing action`;
    if (lower.startsWith("deploy:") || lower.startsWith("release:")) return `"${arg}" is a publishing action`;
  }
  return undefined;
}

function deletionTargets(args          )           {
  const targets           = [];
  let endFlags = false;
  for (const arg of args) {
    if (!endFlags && arg === "--") { endFlags = true; continue; }
    if (!endFlags && arg.startsWith("-")) continue;
    if (arg) targets.push(arg);
  }
  return targets;
}

function stripWrappers(fields          )           {
  let current = fields.slice();
  while (current.length) {
    const name = path.basename(current[0]);
    switch (name) {
      case "timeout": current = dropFlagsAndOneValue(current.slice(1)); break;
      case "nice": case "nohup": case "stdbuf": case "ionice": case "command": case "builtin": case "caffeinate": current = dropFlags(current.slice(1)); break;
      case "env": current = dropAssignments(current.slice(1)); break;
      default: return current;
    }
  }
  return current;
}

function dropFlags(fields          )           { let index = 0; while (index < fields.length && fields[index].startsWith("-")) index++; return fields.slice(index); }
function dropFlagsAndOneValue(fields          )           { const rest = dropFlags(fields); return rest.length ? rest.slice(1) : rest; }
function dropAssignments(fields          )           { let index = 0; while (index < fields.length && fields[index].includes("=") && !fields[index].startsWith("=")) index++; return fields.slice(index); }
function firstNonFlag(fields          )         { for (const field of fields) if (!field.startsWith("-")) return path.basename(field); return ""; }
function firstNonFlagAfter(fields          , after        )         { let found = false; for (const field of fields) { if (!found) { found = field === after; continue; } if (!field.startsWith("-")) return path.basename(field); } return ""; }
function containsAny(fields          , ...candidates          )          { return fields.some((field) => candidates.some((candidate) => field === candidate || field.startsWith(`${candidate}=`))); }
function oneOf(value        , ...candidates          )          { return candidates.includes(value); }
function unique(values          )           { return [...new Set(values)]; }

function splitFields(command        )           { return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((word) => word.replace(/^['"]|['"]$/g, "")) || []; }
function segments(command        )           { return command.split(/(?:&&|\|\||;|\n|(?<!\|)\|(?!\|))/).map((value) => value.trim()).filter(Boolean); }
function words(command        )           { return splitFields(command); }
function basename(value        )         { return path.basename(value); }
function commandName(tokens          )         { const controls = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "command"]); let index = 0; while (index < tokens.length && (controls.has(tokens[index]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]))) index++; return basename(tokens[index] || ""); }

function allow(reason        , scope        )           { return { effect: "allow", reason, oneTime: false, scope }; }
function ask(reason        , oneTime         , scope        , review = false)           { return { effect: "ask", reason, oneTime, scope, review }; }
function deny(reason        , scope        )           { return { effect: "deny", reason, oneTime: false, scope }; }


const sensitiveNames = new Set([
  ".netrc", ".npmrc", ".pypirc", ".git-credentials", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa",
  "authorized_keys", "known_hosts", "credentials.json", "service-account.json", "login.keychain", "keychain-db",
]);
const sensitiveDirectories = new Set([".ssh", ".aws", ".gnupg", ".kube"]);

/** Files whose contents are commonly credentials. Reads still possible after explicit approval or via bash review. */
export function isSensitivePath(input        )          {
  const value = String(input || "").replaceAll("\\", "/").toLowerCase();
  if (!value) return false;
  const segments = value.split("/").filter(Boolean);
  const base = segments.at(-1) || "";
  if (segments.some((segment) => sensitiveDirectories.has(segment))) return true;
  if (value.endsWith(".docker/config.json")) return true;
  if (value.replace(/^\/+/, "") === "etc/shadow" || value.replace(/^\/+/, "") === "etc/sudoers") return true;
  if (sensitiveNames.has(base)) return true;
  if (base === ".env" || (base.startsWith(".env.") && ![".env.example", ".env.sample", ".env.template"].includes(base))) return true;
  return false;
}


//# sourceURL=../src/security.ts
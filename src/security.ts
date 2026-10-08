import type { Mode } from "./protocol.ts";

export interface Decision { effect: "allow" | "ask" | "deny"; reason: string; oneTime: boolean; scope: string }

const readCommands = new Set(["ls", "cat", "head", "tail", "wc", "file", "stat", "tree", "du", "df", "pwd", "find", "grep", "rg", "sort", "uniq", "cut", "sed", "awk", "jq", "diff", "echo", "printf", "date", "whoami", "id", "uname", "which", "env", "sleep", "test", "["]);
const readSubcommands: Record<string, Set<string>> = {
  git: new Set(["status", "diff", "log", "show", "branch", "remote", "tag", "describe", "blame", "rev-parse", "ls-files"]),
  npm: new Set(["test", "ls", "list", "view", "outdated"]), go: new Set(["build", "test", "vet", "list", "env", "doc", "version"]),
};
const destructive = new Map([["rm", "deletes files"], ["rmdir", "deletes directories"], ["unlink", "deletes a file"], ["shred", "destroys contents"], ["truncate", "destroys contents"], ["mv", "moves or overwrites files"], ["tee", "writes files"], ["bash", "runs an opaque script"], ["sh", "runs an opaque script"], ["zsh", "runs an opaque script"], ["powershell", "runs an opaque script"], ["pwsh", "runs an opaque script"]]);
const privileged = new Set(["sudo", "doas", "su"]);
const networkShell = new Set(["curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "telnet"]);
const destructiveArtisan = new Set(["db:wipe", "migrate:fresh", "migrate:refresh", "migrate:reset", "model:prune", "queue:clear"]);

export function decide(mode: Mode, tool: string, args: Record<string, unknown>, readOnly: boolean): Decision {
  const scope = tool === "bash" ? `bash:${words(String(args.command || ""))[0] || "empty"}` : tool;
  if (readOnly) return { effect: "allow", reason: "reads only", oneTime: false, scope };
  if (mode === "plan") return { effect: "deny", reason: "plan mode refuses workspace changes", oneTime: false, scope };
  const risk = riskReason(tool, args);
  if (mode === "auto") {
    if (tool === "webfetch") return { effect: "allow", reason: "guarded public fetch", oneTime: false, scope };
    if (risk) return { effect: "ask", reason: risk, oneTime: true, scope };
    if (tool === "bash") return { effect: "allow", reason: isReadOnlyCommand(String(args.command || "")) ? "audited read-only command" : "bounded workspace command", oneTime: false, scope };
    if (tool === "write" || tool === "edit") return { effect: "allow", reason: "audited workspace edit", oneTime: false, scope };
  }
  return { effect: "ask", reason: risk || "changes state", oneTime: Boolean(risk), scope };
}

export function riskReason(tool: string, args: Record<string, unknown>): string | undefined {
  if (tool !== "bash") return tool === "webfetch" ? "reaches the network" : undefined;
  const command = String(args.command || "").trim();
  if (!command) return "empty command";
  if (command.includes("`")) return "contains opaque backtick substitution";
  const substitutions = [...command.matchAll(/\$\(([^()]*)\)/g)];
  if (command.includes("$(") && !substitutions.length) return "contains nested or incomplete command substitution";
  for (const substitution of substitutions) { const nested = riskReason("bash", { command: substitution[1] }); if (nested) return `command substitution ${nested}`; }
  if ([...command.matchAll(/(?:^|\s)(?:\d*)>>?\s*([^\s;&|]+)/g)].some((match) => !["/dev/null", "/dev/stdout", "/dev/stderr", "NUL"].includes(cleanRedirect(match[1] || "")))) return "redirects output to a file";
  if (/(^|[;&|]\s*)cd\s+(?:\/|~|\.\.)/.test(command)) return "changes outside the workspace before continuing";
  for (const segment of segments(command)) {
    const tokens = words(segment); const name = commandName(tokens);
    if (destructive.has(name)) return `${name} ${destructive.get(name)}`;
    if (privileged.has(name)) return `${name} requests elevated privileges`;
    if (networkShell.has(name)) return `${name} reaches the network outside the guarded fetch tool`;
    if (name === "xargs" && tokens.some((word) => destructive.has(basename(word)))) return "xargs invokes a destructive command";
    if (name === "find" && tokens.some((word) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(word))) return "find can delete files or execute commands";
    if (name === "git" && tokens.some((word) => ["clean", "reset", "push", "restore", "checkout"].includes(word))) return "Git operation can discard or publish work";
    if (name === "npm" && tokens.some((word) => ["publish", "unpublish"].includes(word))) return "npm operation publishes or removes a package";
    if (name === "composer" && tokens.includes("config") && tokens.includes("--global")) return "Composer changes global configuration";
    if (name === "php" && tokens[1] === "artisan" && tokens.some((word) => destructiveArtisan.has(word))) return "Artisan operation can destroy persistent data";
    if (["python", "python3", "node", "php", "ruby", "perl"].includes(name) && tokens.some((word) => ["-c", "-e", "-r", "--eval"].includes(word))) return `${name} executes inline code`;
  }
  return undefined;
}

export function isReadOnlyCommand(command: string): boolean {
  if (riskReason("bash", { command })) return false;
  const parts = segments(command); if (!parts.length) return false;
  return parts.every((part) => { const tokens = words(part); const name = basename(tokens[0] || ""); return readCommands.has(name) || Boolean(readSubcommands[name]?.has(tokens[1] || "")); });
}
function segments(command: string): string[] { return command.split(/(?:&&|\|\||;|\n|(?<!\|)\|(?!\|))/).map((value) => value.trim()).filter(Boolean); }
function words(command: string): string[] { return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((word) => word.replace(/^['"]|['"]$/g, "")) || []; }
function basename(path: string): string { return path.replaceAll("\\", "/").split("/").at(-1) || ""; }
function commandName(tokens: string[]): string { const controls = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "command"]); let index = 0; while (index < tokens.length && (controls.has(tokens[index]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]))) index++; return basename(tokens[index] || ""); }
function cleanRedirect(target: string): string { const value = target.replace(/^['"]|['"]$/g, ""); return /^&(?:\d+|-)$/.test(value) ? "/dev/stdout" : value; }

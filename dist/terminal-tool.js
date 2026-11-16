import * as path from "node:path";
import { realpath } from "node:fs/promises";
import { stripRedundantWorkspaceCd } from "./bash.js";
                                                                                          
                                       

const object = (properties                         , required           = [])                          => ({ type: "object", properties, required, additionalProperties: false });
const actions = ["start", "list", "output", "stop"]         ;
                                     

/**
 * Exposes a workspace-scoped {@link BackgroundTerminals} manager to the agent so
 * long-running processes can be started, inspected, and stopped across turns.
 */
export function createTerminalTool(rootPath        , terminals                     )       {
  const root = path.resolve(rootPath);
  return {
    schema: {
      name: "terminal",
      description: "Manage long-running background terminals for servers and watchers such as `php artisan serve` or `npm run dev`. Use action start to launch a command and keep it running between turns, list to review open terminals, output to read new output, and stop to shut one down. Commands that finish on their own belong in the bash tool instead.",
      parameters: object({
        action: { type: "string", enum: [...actions], description: "start launches a command, list shows terminals, output reads captured output, stop terminates a terminal." },
        command: { type: "string", description: "Shell command to launch when action is start." },
        id: { type: "string", description: "Terminal id returned by start or list. Required for output and stop." },
        cwd: { type: "string", description: "Workspace-relative working directory for start. Defaults to the workspace root." },
        offset: { type: "integer", description: "Character offset to read from, typically the endOffset returned by the previous output read. Omit to read the most recent output." },
        tail: { type: "integer", description: "Maximum characters of recent output to return when offset is omitted (default 8000, maximum 64000)." },
        wait_ms: { type: "integer", description: "For start, how long to wait for startup output before returning (maximum 5000). For stop, how long to wait for shutdown before forcing it (maximum 10000)." },
      }, ["action"]),
    },
    readOnly: false,
    normalize(args) {
      const action = normalizeAction(args.action);
      const command = String(args.command ?? "");
      return { ...args, action, ...(action === "start" ? { command: stripRedundantWorkspaceCd(command, root) } : {}) };
    },
    async execute(args, signal) {
      try {
        const action = normalizeAction(args.action);
        if (action === "list") return { text: formatList(terminals.list()) };
        if (action === "output") {
          const read = terminals.read(required(args.id, "id"), { offset: optionalInteger(args.offset), tail: optionalInteger(args.tail) });
          return { text: formatRead(read) };
        }
        if (action === "stop") {
          const stopped = await terminals.stop(required(args.id, "id"), { timeoutMs: optionalInteger(args.wait_ms), signal });
          return { text: stopped.running ? `Terminal ${stopped.id} is still running after a forced stop.` : `Stopped ${stopped.id}.${stopped.exitCode === null || stopped.exitCode < 0 ? "" : ` Exit code ${stopped.exitCode}.`}`, isError: stopped.running };
        }
        if (action !== "start") return { text: `terminal: unknown action "${String(args.action ?? "")}". Use start, list, output, or stop.`, isError: true };
        const command = required(args.command, "command");
        const read = await terminals.start(command, await resolveCwd(root, args.cwd), { waitMs: optionalInteger(args.wait_ms) ?? 750, signal });
        if (signal?.aborted) {
          await terminals.stop(read.id, { timeoutMs: 1_000 });
          throw signal.reason ?? new Error("Stopped by user");
        }
        return { text: formatStarted(read), isError: !read.running && read.exitCode !== null && read.exitCode !== 0 };
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? new Error("Stopped by user");
        return { text: `terminal: ${error instanceof Error ? error.message : String(error)}`, isError: true };
      }
    },
  };
}

function normalizeAction(value         )         {
  const action = String(value ?? "").trim().toLowerCase();
  if (action === "read" || action === "logs") return "output";
  if (action === "kill" || action === "terminate") return "stop";
  if (action === "launch" || action === "run") return "start";
  return actions.includes(action          ) ? action           : (action          );
}

async function resolveCwd(root        , value         )                  {
  const input = typeof value === "string" && value.trim() ? value : ".";
  const candidate = path.resolve(root, input);
  if (!contained(root, candidate)) throw new Error(`working directory escapes the workspace: ${input}`);
  try {
    if (!contained(await realpath(root), await realpath(candidate))) throw new Error(`working directory resolves outside the workspace: ${input}`);
  } catch (error) {
    if ((error                         ).code !== "ENOENT") throw error;
  }
  return candidate;
}

function contained(root        , candidate        )          {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function formatList(items                    )         {
  if (!items.length) return "No background terminals are open. Start one with the terminal tool, action start.";
  return ["Background terminals:", ...items.map((item) => `- ${item.id} · ${status(item)} · ${item.command} · ${elapsed(item.startedAt)} · ${item.outputCharacters} characters captured`)].join("\n");
}

function formatStarted(read              )         {
  const heading = read.running
    ? `Started ${read.id}${read.pid ? ` (pid ${read.pid})` : ""} in ${displayPath(read.cwd)}. It is still running.`
    : `Started ${read.id} in ${displayPath(read.cwd)}. It exited before returning${read.exitCode === null || read.exitCode < 0 ? "." : ` with code ${read.exitCode}.`}`;
  const hint = read.running ? `\nUse terminal { action: "output", id: "${read.id}" } to read more output, and terminal { action: "stop", id: "${read.id}" } to shut it down.` : "";
  return `${heading}${hint}\n\n${read.output.trim() || "(no output captured yet)"}`;
}

function formatRead(read              )         {
  const position = `output characters ${read.offset}–${read.endOffset} of ${read.outputCharacters}`;
  const trimmed = read.truncated ? " (older output was discarded from the buffer)" : "";
  const heading = `${read.id} · ${status(read)} · ${position}${trimmed}.`;
  const next = read.endOffset < read.outputCharacters ? `\nRead further with terminal { action: "output", id: "${read.id}", offset: ${read.endOffset} }.` : "";
  return `${heading}${next}\n\n${read.output.trim() || "(no new output)"}`;
}

function status(item                  )         {
  if (item.running) return "running";
  if (item.exitCode === null) return "exited";
  return item.exitCode < 0 ? "terminated" : `exited ${item.exitCode}`;
}

function elapsed(startedAt        )         {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function displayPath(cwd        )         {
  return ["/", "\\"].includes(cwd.replace(/[A-Za-z]:$/, "")) ? cwd : cwd.replaceAll("\\", "/").split("/").at(-1) || cwd;
}

function required(value         , name        )         {
  if (typeof value !== "string" || !value.trim()) throw new Error(`"${name}" is required`);
  return value.trim();
}

function optionalInteger(value         )                     {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.floor(parsed));
}


//# sourceURL=../src/terminal-tool.ts
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative as relativePath, sep } from "node:path";
import type { Tool, ToolResult } from "./tools.ts";

/**
 * Drives a real browser through the agent CLI that ships inside playwright-core.
 *
 * The CLI is a subprocess rather than an imported library because this extension
 * has no runtime dependencies: it is TypeScript stripped of its types and run in
 * the extension host. Importing a browser driver would add a driver and a browser
 * download to every install. The same subprocess shape is used by the desktop and
 * terminal products, so there is one behaviour to reason about, not three.
 *
 * The tool is named and described in product terms. Which engine implements it is
 * an implementation detail, not part of what the user or the model is told.
 */

const MAX_OUTPUT = 24_000;
/** Bounds an image that enters model context: it is re-sent on every later step. */
const MAX_ATTACHED_IMAGE_BYTES = 3_000_000;
const TAIL_BYTES = 4_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const ARTIFACT_DIR = ".cenmax/browser";

export interface BrowserRunner {
  run(workdir: string, args: string[], signal?: AbortSignal): Promise<{ output: string; failed: boolean }>;
}

export function execBrowserRunner(environment: NodeJS.ProcessEnv = process.env): BrowserRunner {
  return {
    async run(workdir, args, signal) {
      const resolved = await resolveBrowserCLI();
      if (!resolved) {
        return {
          failed: true,
          output:
            "browser: no browser automation CLI was found. Install it with `npm install -g playwright` " +
            "(or add playwright-core to this workspace), then run `npx playwright install chromium` to fetch the browser.",
        };
      }
      return new Promise((resolve) => {
        const child = spawn(resolved.binary, [...resolved.prefix, ...args], { cwd: workdir, env: environment, signal });
        const chunks: Buffer[] = [];
        let size = 0;
        const collect = (chunk: Buffer) => {
          if (size < MAX_OUTPUT * 2) chunks.push(chunk.subarray(0, MAX_OUTPUT * 2 - size));
          size += chunk.length;
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        child.on("error", (error) => resolve({ output: `browser: ${error.message}`, failed: true }));
        child.on("close", (code) => resolve({ output: Buffer.concat(chunks).toString("utf8").trim(), failed: code !== 0 }));
      });
    },
  };
}

interface ResolvedCLI { binary: string; prefix: string[] }

/** Resolution order is explicit so a surprising binary never wins silently. */
async function resolveBrowserCLI(): Promise<ResolvedCLI | undefined> {
  const node = process.platform === "win32" ? "node.exe" : "node";
  for (const pkg of ["playwright-core", "playwright"]) {
    const candidate = join(process.cwd(), "node_modules", pkg, "cli.js");
    try { if (!(await stat(candidate)).isDirectory()) return { binary: node, prefix: [candidate, "cli"] }; }
    catch { /* not installed locally */ }
  }
  for (const name of ["playwright-cli", "playwright"]) {
    const found = await lookPath(name);
    if (found) return name === "playwright-cli" ? { binary: found, prefix: [] } : { binary: found, prefix: ["cli"] };
  }
  return undefined;
}

async function lookPath(name: string): Promise<string | undefined> {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD").split(";") : [""];
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, name + extension);
      try { await access(candidate); return candidate; } catch { /* keep looking */ }
    }
  }
  return undefined;
}

function sessionName(root: string): string {
  return "cenmax-" + createHash("sha256").update(root).digest("hex").slice(0, 12);
}

const actions = ["open", "snapshot", "click", "fill", "type", "press", "goto", "screenshot", "console", "requests", "close"];
const object = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object", properties, required, additionalProperties: false,
});

export function createBrowserTool(rootPath: string, runner: BrowserRunner = execBrowserRunner()): Tool {
  const root = rootPath;
  const session = sessionName(root);

  return {
    schema: {
      name: "browser",
      description:
        "Drive a real browser to check a page the way a person would. Start with action open on a URL " +
        "(usually a local dev server), then use snapshot to get the page structure with ref handles, and " +
        "click, fill, type or press to act on a handle. Use console and requests to diagnose a page that " +
        "misbehaves, and screenshot to save an image into the workspace. Call close when finished. The " +
        "session persists between calls, so each call continues the same page.",
      parameters: object({
        action: { type: "string", enum: actions, description: "open starts or reuses the session and navigates; snapshot returns the page structure with ref handles; click/fill/type/press act on a ref; goto navigates; screenshot saves a PNG; console and requests list diagnostics; close shuts the session down." },
        url: { type: "string", description: "http or https URL for open and goto. Defaults to a local development server when omitted on open." },
        ref: { type: "string", description: "Element handle from a snapshot, such as e12. Required for click, fill, type and press." },
        text: { type: "string", description: "Text to fill or type into the target element." },
        key: { type: "string", description: "Key to press, for example Enter or Escape." },
        target: { type: "string", description: "Optional element ref for screenshot, to capture one element instead of the page." },
        timeout_ms: { type: "integer", description: "Maximum time for this call in milliseconds." },
      }, ["action"]),
    },
    readOnly: false,
    async execute(args, signal) {
      const action = String(args.action || "").toLowerCase().trim();
      if (!action) return { text: "browser: action is required", isError: true };

      let target = "";
      if (action === "open" || action === "goto") {
        const checked = validateURL(String(args.url || ""), action);
        if (typeof checked !== "string") return checked;
        target = checked;
      }

      const built = buildArgs(session, action, args, target);
      if (!Array.isArray(built)) return built;

      let workdir = root;
      try {
        workdir = join(root, ARTIFACT_DIR);
        await mkdir(workdir, { recursive: true });
      } catch { workdir = root; }

      const timeout = Math.min(MAX_TIMEOUT_MS, Number(args.timeout_ms) || DEFAULT_TIMEOUT_MS);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;

      let output: string;
      try {
        output = (await runner.run(workdir, built, combined)).output;
      } finally {
        clearTimeout(timer);
      }

      const text = [bound(relativize(output, root)), action === "close" ? "Browser session closed." : ""]
        .filter(Boolean).join("\n\n");

      if (action !== "screenshot") return { text };

      // A screenshot becomes an image the model can see. The PNG is also left on
      // disk: the person watching can open it, and it survives as evidence.
      const attachment = await attachScreenshot(output, workdir, root);
      const body = attachment.note ? `${text}\n\n${attachment.note}` : text;
      return attachment.image === undefined ? { text: body } : { text: body, images: [attachment.image] };
    },
  };
}

function buildArgs(session: string, action: string, args: Record<string, unknown>, target: string): string[] | ToolResult {
  const base = [`-s=${session}`];
  const ref = String(args.ref || "");

  switch (action) {
    case "open": return [...base, "open", ...(target ? [target] : [])];
    case "goto": return [...base, "goto", target];
    case "snapshot": case "console": case "requests": case "close": return [...base, action];
    case "click":
      if (!ref) return { text: "browser: ref is required for click; take a snapshot first", isError: true };
      return [...base, "click", ref];
    case "fill": case "type":
      if (!ref) return { text: `browser: ref is required for ${action}; take a snapshot first`, isError: true };
      return [...base, action, ref, String(args.text || "")];
    case "press": {
      const key = String(args.key || "");
      if (!key) return { text: "browser: key is required for press", isError: true };
      return [...base, "press", key];
    }
    case "screenshot": {
      const element = String(args.target || "");
      return [...base, "screenshot", ...(element ? [element] : [])];
    }
    default: return { text: `browser: unknown action ${JSON.stringify(action)}`, isError: true };
  }
}

/**
 * Accepts only credential-free http and https URLs. Loopback is allowed on
 * purpose: exercising the developer's own dev server is the primary use.
 */
function validateURL(raw: string, action: string): string | ToolResult {
  const value = raw.trim();
  if (!value && action === "open") return "http://localhost:3000";
  if (!value) return { text: `browser: url is required for ${action}`, isError: true };

  let parsed: URL;
  try { parsed = new URL(value); }
  catch { return { text: "browser: url is not valid", isError: true }; }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { text: "browser: only http and https URLs can be opened", isError: true };
  }
  if (parsed.username || parsed.password) return { text: "browser: URLs carrying credentials are refused", isError: true };
  return parsed.toString();
}

function relativize(output: string, root: string): string {
  const absolute = join(root, ARTIFACT_DIR);
  const artifact = ARTIFACT_DIR.split("\\").join("/");
  const rewritten = output.split(absolute + "/").join(artifact + "/").split(absolute + "\\").join(artifact + "/");
  // Playwright runs with its cwd set to the artifact directory and prints paths
  // relative to it, so a bare `.playwright-cli/...` link must be rewritten as
  // well; otherwise the model is handed a path that does not resolve from the
  // workspace root.
  return rewritten.replace(/(^|[\s("'[])(\.playwright-cli\/)/gm, `$1${artifact}/$2`);
}

/** Bounds one result: a result becomes history and is re-sent on every later step. */
function bound(text: string): string {
  if (text.length <= MAX_OUTPUT + TAIL_BYTES) return text;
  const dropped = text.length - MAX_OUTPUT - TAIL_BYTES;
  return `${text.slice(0, MAX_OUTPUT)}\n\n[... content omitted ...]\n\n${text.slice(-TAIL_BYTES)}\n\n(${dropped} bytes omitted.)`;
}

/**
 * Reads the screenshot a command just wrote and packages it as an image.
 *
 * The file stays where it is: the model gets the bytes, and the person keeps the
 * artefact. It reads the last markdown link in the output rather than a fixed
 * phrase, because the wording around it is presentation.
 */
async function attachScreenshot(
  output: string,
  workdir: string,
  root: string,
): Promise<{ image?: { mimeType: string; digest: string; data: string }; note?: string }> {
  let named = "";
  for (const match of output.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) named = match[1];
  if (!named) return {};

  const file = isAbsolute(named) ? named : join(workdir, named);
  const shown = workspaceRelative(root, file);

  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return { note: `The screenshot was not readable at ${shown}.` };
  }

  if (size > MAX_ATTACHED_IMAGE_BYTES) {
    return {
      note: `The screenshot is ${Math.round(size / 1024)} KB and was saved to ${shown} but not attached, because an image that large would be re-sent on every later step.`,
    };
  }

  let data: Buffer;
  try {
    data = await readFile(file);
  } catch {
    return { note: `The screenshot was not readable at ${shown}.` };
  }

  const lower = file.toLowerCase();
  const mimeType = lower.endsWith(".jpg") || lower.endsWith(".jpeg") ? "image/jpeg" : lower.endsWith(".webp") ? "image/webp" : "image/png";

  return {
    image: { mimeType, digest: createHash("sha256").update(data).digest("hex"), data: data.toString("base64") },
  };
}

/** Renders a machine path as a workspace-relative one. */
function workspaceRelative(root: string, file: string): string {
  const rel = relativePath(root, file);
  return rel.startsWith("..") ? file : rel.split(sep).join("/");
}

/** Actions that only observe a page the agent already opened. */
export const browserReadOnlyActions = new Set(["snapshot", "console", "requests"]);

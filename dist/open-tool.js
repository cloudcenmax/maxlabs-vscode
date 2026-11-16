import { realpath, stat } from "node:fs/promises";
import * as path from "node:path";
                                       

                              
                   
                                  
                
                  
 

                           
                                                          
                                      
 

const object = (properties                         , required           = [])                          => ({ type: "object", properties, required, additionalProperties: false });

/**
 * Lets the agent show a workspace file to the person: open it in an editor tab
 * (optionally at a line) or reveal it in the Explorer file view. This is purely
 * presentational, so it is read-only and needs no approval.
 */
export function createOpenTool(rootPath        , host          )       {
  const root = path.resolve(rootPath);
  return {
    schema: {
      name: "open",
      description: "Show a workspace file to the user. Use target \"editor\" to open it in a new editor tab (optionally at a line), or target \"explorer\" to reveal it in the file explorer. Opening does not change the workspace.",
      parameters: object({
        path: { type: "string", description: "Workspace-relative path to the file or folder." },
        target: { type: "string", enum: ["editor", "explorer"], description: "editor opens an editor tab; explorer reveals the item in the file explorer. Defaults to editor." },
        preview: { type: "boolean", description: "Open the editor tab in preview mode (reused by the next navigation). Defaults to false so the user gets a persistent tab." },
        view_column: { type: "string", enum: ["active", "beside"], description: "Open in the active editor group or beside it. Defaults to active." },
        line: { type: "integer", description: "Optional 1-based line to select when opening in an editor." },
        column: { type: "integer", description: "Optional 1-based column to select when opening in an editor." },
      }, ["path"]),
    },
    readOnly: true,
    async execute(args) {
      try {
        const input = required(args.path, "path");
        const file = await resolveEntry(root, input);
        const target = String(args.target ?? "editor").trim().toLowerCase();
        if (target === "explorer") {
          await host.reveal(file);
          return { text: `Revealed ${display(root, file)} in the file explorer.` };
        }
        if (target !== "editor") return { text: 'open: target must be "editor" or "explorer".', isError: true };
        if (!(await stat(file)).isFile()) return { text: `open: ${display(root, file)} is a folder. Use target "explorer" to reveal it.`, isError: true };
        const line = positive(args.line);
        const column = positive(args.column);
        await host.open(file, { preview: args.preview === true, viewColumn: args.view_column === "beside" ? "beside" : "active", line, column });
        return { text: `Opened ${display(root, file)} in an editor tab${line ? ` at line ${line}${column ? `:${column}` : ""}` : ""}.` };
      } catch (error) {
        return { text: `open: ${error instanceof Error ? error.message : String(error)}`, isError: true };
      }
    },
  };
}

async function resolveEntry(root        , input        )                  {
  const candidate = path.resolve(root, input);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw new Error(`path escapes the workspace: ${input}`);
  try {
    const canonical = await realpath(candidate);
    const canonicalRoot = await realpath(root);
    if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error(`path resolves outside the workspace: ${input}`);
  } catch (error) {
    if ((error                         ).code === "ENOENT") throw new Error(`file not found: ${input}`);
    throw error;
  }
  return candidate;
}

function display(root        , file        )         {
  return path.relative(root, file) || ".";
}

function required(value         , name        )         {
  if (typeof value !== "string" || !value.trim()) throw new Error(`"${name}" is required`);
  return value.trim();
}

function positive(value         )                     {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}


//# sourceURL=../src/open-tool.ts
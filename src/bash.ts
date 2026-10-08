import * as path from "node:path";

const leadingCd = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:&&|;)\s*/;

/** Remove a model-generated `cd <workspace>` prefix; the shell already starts there. */
export function stripRedundantWorkspaceCd(command: string, workspaceRoot: string): string {
  const match = command.match(leadingCd);
  if (!match) return command;

  const destination = match[1] ?? match[2] ?? match[3];
  if (path.resolve(workspaceRoot, destination) !== path.resolve(workspaceRoot)) return command;

  return command.slice(match[0].length);
}

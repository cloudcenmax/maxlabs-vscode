# Cenmax AI for Visual Studio Code

Cenmax AI brings the OAuth-first Cenmax AI coding agent into a workspace-scoped VS Code chat view. It streams answers, can inspect and edit workspace files, runs bounded shell commands, keeps long-running background terminals, fetches public references, and supports safe mid-run steering.

## Run and steer

While a turn is running, the composer shows a red **Stop** button that interrupts the current model request or tool call (also available as **Cenmax AI: Stop Current Turn**). The run's reasoning is shown as a collapsible **Thinking · ~N tokens** card, where the token figure is a live estimate while the response is generated.

## Background terminals

The agent can keep servers and watchers alive between turns with the `terminal` tool, for example `php artisan serve`, `npm run dev`, or a queue worker. It starts a command, lists open terminals, reads incremental output, and stops a terminal when it is no longer needed. Background terminals belong to the workspace and are terminated when the extension host unloads; use **Cenmax AI: Stop Background Terminals** to stop them all from the Command Palette.

## Open files and attach images

The agent can show you a file with the `open` tool: it opens a persistent editor tab, optionally at a line, or reveals the item in the Explorer file view. Opening is read-only and available in every mode.

Paste a screenshot or image directly into the composer to attach it to your next message (PNG, JPEG, WebP, or GIF; up to four images). Images are downscaled and re-encoded before they are sent, previewed above the composer, and shown in the conversation. Use **Enter** to send; the attached image can be removed with its × control before sending.

## Browser checks

The agent can drive a real browser with the `browser` tool, which is how it verifies a page it just changed instead of guessing from the source. Start it on a local dev server, read the page structure as a compact accessibility tree with `ref` handles, then act on those handles:

- `open` and `goto` navigate; `snapshot` returns the page structure with handles; `click`, `fill`, `type` and `press` act on a handle.
- `console` and `requests` show what the page did, which is usually faster than reasoning about why it misbehaved.
- `screenshot` saves a PNG, and `close` shuts the session down.

The session persists between calls and is keyed to the workspace, so two projects never share a browser. Snapshots look like this:

```yaml
- generic [active] [ref=e1]:
  - heading "Sign in" [level=1] [ref=e2]
  - textbox "Email" [ref=e3]
  - button "Continue" [ref=e4]
```

Browser automation needs a browser engine on the machine. Install one with `npm install -g playwright` and then `npx playwright install chromium`; the extension does not download it for you. Page snapshots, screenshots and session state are written under `.cenmax/browser/`, which the repository ignores.

A `screenshot` is attached to the conversation, so the agent can see the rendered page rather than only its markup. Images are sent as picture content and are bounded and content-addressed: an oversized capture is saved to disk and reported by path instead of being sent, and an identical frame keeps the same address so it does not defeat caching. Images count toward the context window and are re-sent with each later step of a turn, so large screenshots are the expensive case.

In **auto** mode, observing a page (`snapshot`, `console`, `requests`) runs unattended, and actions that change page state go to the reviewer. Plan mode refuses actions that change the page.

## Account tools and skills

When you sign in with OAuth, the extension loads the MCP connections and Agent Skills that are enabled on that Cenmax AI account:

- Connected MCP tools appear to the agent automatically. Each call runs server-side through your account workspace with an idempotency key, so the extension never receives the third-party credential. MCP actions change external services, so they ask for approval outside plan mode; plan mode never runs them.
- Enabled skills contribute their name and description to the agent's context and are loaded in full only when the agent uses the `skill` tool. Skill content is treated as guidance, never as permission to bypass workspace safety rules.

This requires the account-level workspace permissions. If your account was connected before these permissions existed, choose **Add or reconnect account** from the account menu and approve the updated permissions. The API-key fallback cannot use account tools or skills; sign in with OAuth for those.

## Run locally

1. Run `npm run build` in this directory.
2. Open this directory in VS Code.
3. Press `F5` and choose **Extension Development Host**.
4. Open a folder in the development host, then select the Cenmax AI activity-bar icon.

Use **Cenmax AI: Sign In with OAuth** from the Command Palette. An API key can be stored as a fallback with **Cenmax AI: Set API Key Fallback**. Both token types are kept in VS Code SecretStorage.

The account picker in the composer and **Cenmax AI: Switch Personal or Work Account** let you move between connected personal and company contexts. Each context keeps its own OAuth token in SecretStorage and therefore retains its own billing, subscription, quota, and usage boundary. Use **Add or reconnect account** to authorize another context in the browser. Account changes are blocked while an agent run is active.

The default model is `worker`, the default thinking level is `low`, and the default mode is `act`. OAuth connects to `https://console.ai.cenmax.in`, and API requests use `https://api.ai.cenmax.in/v1`. Configure model, thinking, mode, web search, URLs, and step limits under Settings → Cenmax AI. The two URL settings are application-scoped and restricted to the official Cenmax AI hosts, so a repository cannot redirect account tokens elsewhere.

## Safety modes

- `plan`: permits inspection and refuses workspace mutations.
- `act`: asks before any state-changing tool.
- `auto`: runs ordinary project work unattended — builds, tests, formatters, package scripts, workspace edits, local Git work, and known dev servers bound to localhost. An independent command reviewer checks destructive, opaque, or unusual commands against your request; if it cannot confirm them, you are asked. External web fetches, credential-holding files, project-local executables, environment assignments, dynamic `cd` targets, and dependency installs require review. Command review uses your signed-in OAuth account, so the API-key fallback falls back to asking. Credentials, privilege escalation, publishing, system changes, and network clients are never run unattended.

Messages sent during an active turn are queued and admitted after the current model request or tool call reaches a safe boundary.


## Security model

- **Workspace Trust:** the extension is not supported in restricted (untrusted) workspaces and does not activate there. In a trusted workspace, Auto mode still never runs privileged, publishing, credential-bearing, or unguarded network commands without review.
- **Approvals show the full command** (up to 4,000 characters) rather than a truncated preview, so a destructive tail cannot hide behind a benign prefix.
- **Network access:** web fetches resolve the hostname once, reject private, loopback, link-local, CGNAT, multicast, and IPv4-mapped addresses, and pin the validated address for the request so DNS rebinding cannot redirect it. Web fetches require approval in Auto mode.
- **Reads:** `read` asks before opening files that commonly hold credentials (`.env`, `.ssh`, key files, and similar); `grep` skips those files and caps pattern length, file size, line length, and search time.
- **Commands:** Auto rejects leading environment assignments, dynamic `cd` targets, writable-location executables, and copy/mkdir/touch paths that resolve outside the workspace or through a symlink. Terminal servers are accepted only as exact argv forms bound to loopback.
- **Account data:** tokens live in VS Code SecretStorage; account tools and skills require OAuth with the workspace scopes, and connected-tool actions are approval-gated.

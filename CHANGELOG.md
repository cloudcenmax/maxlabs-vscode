# Changelog

## 0.1.5

- Add Full Auto mode with explicit refusals when an action cannot be established as allowed.
- Compact long conversations and apply model, thinking, and mode changes at the next request boundary.
- Run independent read-only tools concurrently while keeping mutations ordered.
- Show a thinking token estimate without rendering internal reasoning text.
- Keep saved approvals subordinate to current permissions, stop queued tools on cancellation, and prevent resets from restoring old compacted history.


## 0.1.4

- Security: application-scoped, host-validated gateway URLs; OAuth verification links restricted to the gateway origin.
- Security: Workspace Trust support; Auto mode rejects environment assignments, dynamic cd targets, writable-location executables, outside-workspace copy targets, and non-loopback server arguments.
- Security: DNS-pinned public web fetches with expanded private/loopback/mapped-address rejection; web fetch approval in Auto.
- Security: credential-file read approvals, sensitive-file grep exclusions, search/read size and complexity caps.
- Security: full commands in approval prompts.
- Keep long commands fully visible for approval and require manual approval when a command exceeds the reviewer limit.

## 0.1.3

- Open workspace files for review in a persistent editor tab or reveal them in the Explorer file view.
- Paste images (PNG, JPEG, WebP, GIF) into the composer with previews; they are downscaled and sent with the message.
- Use the MCP connections and Agent Skills enabled on the signed-in account, with progressive skill loading and approval-gated connected-tool actions.
- Preserve account and conversation isolation when chat setup is interrupted or accounts change.
- Include enabled connected tools and skills in requests while preventing them from replacing local tools.

## 0.1.2

- Auto mode now matches the desktop app: ordinary builds, tests, formatters, package scripts, workspace edits, local Git work, and known dev servers run unattended, while an independent command reviewer checks destructive or unusual commands against your request before asking you.
- Keep development servers, queue workers, and watchers running between turns with background terminals. Read their output or stop them from chat and the Command Palette.
- Stop active requests and tools promptly, and start a new conversation without carrying over unfinished tool calls.
- Display streamed thinking in collapsible cards with live token estimates.
- Improve terminal permissions, workspace command handling, and neutral Cenmax AI service errors.

## 0.1.1

- Introduce Cenmax AI branding and updated console/API addresses while preserving existing account access, model IDs, settings, and the extension identifier.

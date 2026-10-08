# MaxLabs for Visual Studio Code

MaxLabs brings the OAuth-first MaxLabs coding agent into a workspace-scoped VS Code chat view. It streams answers, can inspect and edit workspace files, runs bounded shell commands, fetches public references, and supports safe mid-run steering.

## Run locally

1. Run `npm run build` in this directory.
2. Open this directory in VS Code.
3. Press `F5` and choose **Extension Development Host**.
4. Open a folder in the development host, then select the MaxLabs activity-bar icon.

Use **MaxLabs: Sign In with OAuth** from the Command Palette. An API key can be stored as a fallback with **MaxLabs: Set API Key Fallback**. Both token types are kept in VS Code SecretStorage.

The account picker in the composer and **MaxLabs: Switch Personal or Work Account** let you move between connected personal and company contexts. Each context keeps its own OAuth token in SecretStorage and therefore retains its own billing, subscription, quota, and usage boundary. Use **Add or reconnect account** to authorize another context in the browser. Account changes are blocked while an agent run is active.

The default model is `worker`, the default thinking level is `medium`, and the default mode is `act`. OAuth connects to `https://console.maxlabs.cenmax.in`, and API requests use `https://api.maxlabs.cenmax.in/v1`. Configure model, thinking, mode, web search, URLs, and step limits under Settings → MaxLabs.

## Safety modes

- `plan`: permits inspection and refuses workspace mutations.
- `act`: asks before any state-changing tool.
- `auto`: permits audited workspace edits and read-only commands, but still asks for destructive, opaque, drifting, and network operations.

Messages sent during an active turn are queued and admitted after the current model request or tool call reaches a safe boundary.

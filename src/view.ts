import * as vscode from "vscode";
import type { AccountIdentity, AccountOption } from "./accounts.ts";
import type { ApprovalAnswer } from "./agent.ts";
import type { Mode, Thinking, WebSearch } from "./protocol.ts";

export type RestoredEntry = { type: "user" | "assistant"; text: string; steering?: boolean } | { type: "toolStart" | "tool"; id: string; name: string; detail: string; error?: boolean };
export interface ViewActions { ready(): void; send(text: string): Promise<void>; stop(): void; newChat(): void; newTab(): void; login(): Promise<void>; logout(): Promise<void>; logoutAll(): Promise<void>; loadAccounts(): Promise<void>; switchAccount(accountId: string): Promise<void>; addAccount(): Promise<void>; setApiKey(): Promise<void>; removeApiKey(): Promise<void>; selectModel(): Promise<void>; loadModels(): Promise<void>; chooseModel(model: string): Promise<void>; chooseThinking(thinking: Thinking): void; chooseMode(mode: Mode): void; selectThinking(): Promise<void>; selectMode(): Promise<void>; selectWebSearch(): Promise<void> }
export interface ChatState { model: string; thinking: Thinking; mode: Mode; webSearch: WebSearch; running: boolean; authenticated: boolean; hasApiKey: boolean; credentialsReady: boolean; chatKey: string; account?: AccountIdentity }

export class ChatSurface {
  host?: { webview: vscode.Webview };
  readonly approvals = new Map<string, (answer: ApprovalAnswer) => void>();
  readonly extensionUri: vscode.Uri;
  readonly actions: ViewActions;
  readonly state: () => ChatState;
  constructor(extensionUri: vscode.Uri, actions: ViewActions, state: () => ChatState) { this.extensionUri = extensionUri; this.actions = actions; this.state = state; }
  attach(host: { webview: vscode.Webview }): vscode.Disposable {
    this.cancelApprovals(); this.host = host;
    host.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")] };
    const icon = host.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "icon.png"));
    const style = host.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "chat.css"));
    const script = host.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "main.js"));
    host.webview.html = html(host.webview, icon, style, script, this.state());
    return host.webview.onDidReceiveMessage(async (message) => {
      try {
        if (message.type === "ready") this.actions.ready();
        else if (message.type === "approvalResponse") this.approvals.get(String(message.id || ""))?.(approvalAnswer(message.answer));
        else if (message.type === "send") await this.actions.send(String(message.text || ""));
        else if (message.type === "stop") this.actions.stop();
        else if (message.type === "newChat") this.actions.newChat();
        else if (message.type === "newTab") this.actions.newTab();
        else if (message.type === "login") await this.actions.login();
        else if (message.type === "logout") await this.actions.logout();
        else if (message.type === "logoutAll") await this.actions.logoutAll();
        else if (message.type === "loadAccounts") await this.actions.loadAccounts();
        else if (message.type === "switchAccount") await this.actions.switchAccount(String(message.accountId || ""));
        else if (message.type === "addAccount") await this.actions.addAccount();
        else if (message.type === "apiKey") await this.actions.setApiKey();
        else if (message.type === "removeApiKey") await this.actions.removeApiKey();
        else if (message.type === "model") await this.actions.selectModel();
        else if (message.type === "loadModels") await this.actions.loadModels();
        else if (message.type === "chooseModel") await this.actions.chooseModel(String(message.model || ""));
        else if (message.type === "chooseThinking") this.actions.chooseThinking(String(message.thinking || "") as Thinking);
        else if (message.type === "chooseMode") this.actions.chooseMode(String(message.mode || "") as Mode);
        else if (message.type === "thinking") await this.actions.selectThinking();
        else if (message.type === "mode") await this.actions.selectMode();
        else if (message.type === "web") await this.actions.selectWebSearch();
      } catch (error) { this.error(error instanceof Error ? error.message : String(error)); }
    });
  }
  reset(): void { this.post({ type: "reset" }); }
  restore(entries: RestoredEntry[]): void { this.post({ type: "restore", entries }); }
  models(models: Array<{ id: string; description?: string }>, selected: string): void { this.post({ type: "models", models, selected }); }
  accounts(accounts: AccountOption[]): void { this.post({ type: "accounts", accounts }); }
  accountLoading(): void { this.post({ type: "accountLoading" }); }
  user(text: string, steering = false): void { this.post({ type: "user", text, steering }); }
  begin(): void { this.post({ type: "begin" }); this.sync(); }
  delta(text: string): void { this.post({ type: "delta", text }); }
  tokenProgress(characters: number): void { this.post({ type: "tokenProgress", characters }); }
  finish(meta: string): void { this.post({ type: "finish", meta }); this.sync(); }
  status(text: string): void { this.post({ type: "status", text }); }
  toolStart(id: string, name: string, detail: string): void { this.post({ type: "toolStart", id, name, detail }); }
  tool(id: string, name: string, detail: string, error = false): void { this.post({ type: "tool", id, name, detail, error }); }
  approval(id: string, tool: string, detail: string, reason: string, allowAlways: boolean, signal?: AbortSignal): Promise<ApprovalAnswer> {
    return new Promise((resolve) => {
      const finish = (answer: ApprovalAnswer): void => { if (!this.approvals.delete(id)) return; signal?.removeEventListener("abort", abort); this.post({ type: "approvalResolved", id }); resolve(answer); };
      const abort = (): void => finish("deny"); this.approvals.set(id, finish); signal?.addEventListener("abort", abort, { once: true });
      this.post({ type: "approval", id, tool, detail, reason, allowAlways });
    });
  }
  error(text: string): void { this.post({ type: "error", text }); this.sync(); }
  sync(): void { this.post({ type: "state", state: this.state() }); }
  protected post(message: unknown): void { void this.host?.webview.postMessage(message); }
  protected cancelApprovals(): void { for (const finish of [...this.approvals.values()]) finish("deny"); }
}

export class ChatViewProvider extends ChatSurface implements vscode.WebviewViewProvider {
  resolveWebviewView(view: vscode.WebviewView): void { this.attach(view); }
  reveal(): void { void vscode.commands.executeCommand("workbench.view.extension.maxlabs"); }
}

export class ChatPanel extends ChatSurface implements vscode.Disposable {
  readonly panel: vscode.WebviewPanel; readonly subscriptions: vscode.Disposable[] = [];
  constructor(extensionUri: vscode.Uri, actions: ViewActions, state: () => ChatState, column: vscode.ViewColumn, onDispose: () => void, onActive: () => void, existing?: vscode.WebviewPanel) {
    super(extensionUri, actions, state);
    this.panel = existing || vscode.window.createWebviewPanel("maxlabs.chatTab", "MaxLabs Chat", column, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")] });
    this.panel.title = "MaxLabs Chat"; this.panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.png");
    this.subscriptions.push(this.panel.onDidDispose(onDispose), this.panel.onDidChangeViewState((event) => { if (event.webviewPanel.active) onActive(); }));
  }
  initialize(): void { this.subscriptions.push(this.attach(this.panel)); }
  reveal(): void { this.panel.reveal(); }
  release(): void { this.cancelApprovals(); for (const subscription of this.subscriptions.splice(0)) subscription.dispose(); this.host = undefined; }
  dispose(): void { this.release(); this.panel.dispose(); }
}

function html(webview: vscode.Webview, icon: vscode.Uri, style: vscode.Uri, script: vscode.Uri, state: ChatState): string {
  const hasCredentials = state.authenticated || state.hasApiKey;
  return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src ${webview.cspSource};"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${style}"></head><body data-icon="${icon}" data-chat-key="${escape(state.chatKey)}">
  <div class="auth-gate" id="authGate" data-ready="${state.credentialsReady}"${state.credentialsReady && hasCredentials ? " hidden" : ""}><div class="auth-gate-card"><img src="${icon}" alt=""><div class="gate-checking">Checking your MaxLabs session…</div><div class="gate-actions"><h1>Connect to MaxLabs</h1><p>Sign in with OAuth for the recommended experience, or add an API key as a fallback.</p><button type="button" class="gate-primary" id="gateOAuth">${svg("account")}<span>Continue with OAuth</span></button><button type="button" class="gate-secondary" id="gateApi">${svg("key")}<span>Use an API key</span></button></div></div></div>
  <div class="floating-actions"><button type="button" class="icon-button" id="newChat" title="Restart this chat">${svg("refresh")}</button><button type="button" class="icon-button" id="newTab" title="Open another MaxLabs chat tab">${svg("plus")}</button><div class="reset-confirm" id="resetConfirm" role="dialog" hidden><strong>Delete this chat?</strong><p>Restarting permanently deletes the entire conversation and starts a blank chat.</p><div><button type="button" class="reset-cancel" id="cancelReset">Cancel</button><button type="button" class="reset-delete" id="confirmReset">Delete chat</button></div></div></div>
  <div class="toolbar"><button type="button" class="pill" id="web">${svg("globe")}<span>${state.webSearch}</span></button></div><main class="messages" id="messages"><div class="empty" id="empty"><img src="${icon}" alt=""><strong>Start a conversation</strong>Ask MaxLabs to inspect, explain, plan, or change this workspace.</div></main>
  <div class="composer"><div class="input-shell"><textarea id="input" rows="2" placeholder="Message MaxLabs… (Shift+Enter for a new line)"></textarea><div class="actions">
  <div class="account-control"><button type="button" class="composer-pill account-pill" id="accountMenuButton" aria-haspopup="menu" aria-expanded="false" title="Switch personal or work account">${svg(state.account?.type === "organization" ? "building" : "account")}<span id="accountButtonLabel">${escape(state.account?.name || (state.hasApiKey ? "API key" : "Account"))}</span>${svg("up")}</button><div class="dropup account-menu" id="accountMenu" role="menu" hidden><div class="account-summary"><strong id="accountStatus">${accountStatus(state)}</strong><span id="accountKind">${accountKind(state)}</span></div><div id="accountOptions" class="account-options"><div class="dropup-loading">Open to load accounts…</div></div><button type="button" class="account-option" id="addAccount">${svg("plus")}<span><strong>Add or reconnect account</strong><small>Choose Personal or Work in your browser</small></span></button><button type="button" class="account-option" id="accountOAuth">${svg("logout")}<span><strong>${state.authenticated ? "Disconnect current account" : "Sign in with OAuth"}</strong><small>${state.authenticated ? "Other connected accounts stay available" : "Recommended for subscriptions"}</small></span></button><button type="button" class="account-option" id="accountApi">${svg("key")}<span><strong>${state.hasApiKey ? "Replace API key" : "Configure API key"}</strong><small>Fallback authentication</small></span></button><button type="button" class="account-option danger" id="removeApi"${state.hasApiKey ? "" : " hidden"}>${svg("trash")}<span><strong>Remove API key</strong><small>Delete the stored fallback key</small></span></button><button type="button" class="account-option danger" id="logoutAll"${state.authenticated ? "" : " hidden"}>${svg("trash")}<span><strong>Disconnect all accounts</strong><small>Remove every stored OAuth session</small></span></button></div></div>
  <div class="mode-control"><button type="button" class="composer-pill" id="mode" aria-haspopup="menu" aria-expanded="false">${svg("shield")}<span>${modeName(state.mode)}</span>${svg("up")}</button><div class="dropup" id="modeMenu" role="menu" hidden><div class="dropup-title">Agent mode</div>${modeOption("act", "Act", "Ask before commands or changes.", state.mode)}${modeOption("plan", "Plan", "Inspect and propose without changing files.", state.mode)}${modeOption("auto", "Auto", "Proceed with safe work; ask for risky actions.", state.mode)}</div></div>
  <div class="action-end"><label class="thinking-control" title="Thinking level"><span class="thinking-icon">${svg("spark")}</span><input id="thinking" type="range" min="0" max="4" step="1" value="${thinkingIndex(state.thinking)}"><span id="thinkingLabel">${titleCase(state.thinking)}</span></label><div class="model-control"><button type="button" class="composer-pill model-pill" id="model" aria-haspopup="menu" aria-expanded="false">${svg("model")}<span>${escape(titleCase(state.model))}</span>${svg("up")}</button><div class="dropup align-right" id="modelMenu" role="menu" hidden><div class="dropup-title">Select model</div><div id="modelOptions" class="model-options"><div class="dropup-loading">Loading models…</div></div></div></div><button type="button" class="primary icon-button" id="send" title="${state.running ? "Steer current run" : "Send message"}">${svg("send")}</button></div></div></div><div class="status" id="status"></div></div><script type="module" src="${script}"></script></body></html>`;
}
function escape(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char); }
function svg(name: "refresh" | "plus" | "model" | "spark" | "shield" | "globe" | "account" | "building" | "logout" | "key" | "send" | "up" | "trash"): string {
  const paths = { refresh: '<path d="M19 8a7 7 0 1 0 1 6M19 3v5h-5"/>', plus: '<path d="M12 5v14M5 12h14"/>', model: '<path d="M7 7h10v10H7zM3 9V5a2 2 0 0 1 2-2h4M21 15v4a2 2 0 0 1-2 2h-4"/>', spark: '<path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3Z"/>', shield: '<path d="M12 3 5 6v5c0 4.6 2.9 8.1 7 10 4.1-1.9 7-5.4 7-10V6l-7-3Z"/>', globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.3 2.5 3.5 5.5 3.5 9S14.3 18.5 12 21M12 3c-2.3 2.5-3.5 5.5-3.5 9S9.7 18.5 12 21"/>', account: '<circle cx="12" cy="8" r="3.5"/><path d="M5 21c.5-4.2 2.8-6.3 7-6.3s6.5 2.1 7 6.3"/>', building: '<path d="M4 21V5l8-3v19M12 8h8v13M8 7h1M8 11h1M8 15h1M16 12h1M16 16h1M2 21h20"/>', logout: '<path d="M10 4H5v16h5M14 8l4 4-4 4M8 12h10"/>', key: '<circle cx="8" cy="12" r="4"/><path d="m12 12 9-9M16 8l3 3M18 6l3 3"/>', send: '<path d="m5 12 14-7-4 14-3-6-7-1Z"/><path d="m12 13 7-8"/>', up: '<path d="m8 14 4-4 4 4"/>', trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/>' };
  return `<svg class="svg-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
}
function thinkingIndex(thinking: Thinking): number { return ["minimal", "low", "medium", "high", "default"].indexOf(thinking); }
function titleCase(value: string): string { return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase()); }
function modeName(mode: Mode): string { return ({ act: "Act", plan: "Plan", auto: "Auto" } as const)[mode]; }
function modeOption(mode: Mode, name: string, description: string, selected: Mode): string { return `<button type="button" class="menu-option${mode === selected ? " selected" : ""}" role="menuitemradio" aria-checked="${mode === selected}" data-mode="${mode}"><strong>${name}</strong><span>${description}</span></button>`; }
function accountStatus(state: ChatState): string { return state.account?.name || (state.hasApiKey ? "API key connected" : "Not connected"); }
function accountKind(state: ChatState): string { return state.account ? state.account.type === "personal" ? "Personal account" : "Work account" : "Authentication"; }
function approvalAnswer(value: unknown): ApprovalAnswer { return value === "once" || value === "always" ? value : "deny"; }

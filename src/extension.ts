import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { Agent, type AgentSettings } from "./agent.ts";
import type { AccountIdentity, AccountOption } from "./accounts.ts";
import { AuthStore } from "./auth.ts";
import { CacheMeter, type CacheMeterState } from "./cache.ts";
import type { Message, Mode, Thinking, WebSearch } from "./protocol.ts";
import { createTools } from "./tools.ts";
import { GatewayTransport } from "./transport.ts";
import { ChatPanel, ChatViewProvider, type ChatSurface, type RestoredEntry, type ViewActions } from "./view.ts";

interface StoredChat { id: string; history: Message[]; meter?: CacheMeterState; model?: string; thinking?: Thinking; mode?: Mode; webSearch?: WebSearch; accountId?: string }

let runtime: Runtime | undefined;

export function activate(context: vscode.ExtensionContext): void {
  runtime = new Runtime(context);
  context.subscriptions.push(
    runtime,
    vscode.window.registerWebviewViewProvider("maxlabs.chat", runtime.sidebarView, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewPanelSerializer("maxlabs.chatTab", { deserializeWebviewPanel: async (panel, state) => { runtime?.restoreChatTab(panel, state); } }),
  );
  register(context, "maxlabs.openChat", () => runtime?.sidebarView.reveal());
  register(context, "maxlabs.newChat", () => runtime?.openChatTab());
  register(context, "maxlabs.resetChat", () => runtime?.activeSession()?.newChat());
  register(context, "maxlabs.login", () => runtime?.login(runtime.activeSession()));
  register(context, "maxlabs.switchAccount", () => runtime?.selectAccount(runtime.activeSession()));
  register(context, "maxlabs.setApiKey", () => runtime?.setApiKey(runtime.activeSession()));
  register(context, "maxlabs.logout", () => runtime?.logout());
  register(context, "maxlabs.selectModel", () => runtime?.activeSession()?.selectModel());
  register(context, "maxlabs.selectThinking", () => runtime?.activeSession()?.selectThinking());
  register(context, "maxlabs.selectMode", () => runtime?.activeSession()?.selectMode());
  register(context, "maxlabs.selectWebSearch", () => runtime?.activeSession()?.selectWebSearch());
  register(context, "maxlabs.stop", () => runtime?.activeSession()?.stop());
}

export function deactivate(): void { runtime?.dispose(); runtime = undefined; }

class Runtime implements vscode.Disposable {
  readonly context: vscode.ExtensionContext;
  readonly auth: AuthStore;
  readonly sidebarView: ChatViewProvider;
  readonly sidebarSession: ChatSession;
  readonly statusItem: vscode.StatusBarItem;
  readonly sessions = new Set<ChatSession>();
  readonly panels = new Map<ChatSession, ChatPanel>();
  lastActive?: ChatSession;
  authenticated = false;
  apiKeyConfigured = false;
  credentialsReady = false;
  activeAccount?: AccountIdentity;
  accounts: AccountOption[] = [];
  chatColumn: vscode.ViewColumn | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.auth = new AuthStore(context.secrets);
    let sidebarSession!: ChatSession;
    this.sidebarView = new ChatViewProvider(context.extensionUri, this.actions(() => sidebarSession), () => sidebarSession.state());
    sidebarSession = new ChatSession(this, this.sidebarView, "maxlabs.sidebarChat.v1");
    this.sidebarSession = sidebarSession;
    this.sessions.add(sidebarSession);
    this.lastActive = sidebarSession;
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusItem.name = "MaxLabs"; this.statusItem.text = "$(comment-discussion) MaxLabs"; this.statusItem.tooltip = "Open a new MaxLabs chat tab"; this.statusItem.command = "maxlabs.newChat"; this.statusItem.show();
    context.subscriptions.push(this.statusItem);
    context.subscriptions.push(this.auth.onDidChange(() => { void this.refreshAuthState(); }));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("maxlabs.gatewayUrl") && !event.affectsConfiguration("maxlabs.apiBaseUrl")) return;
      for (const session of this.sessions) session.invalidateAgent();
    }));
    void this.refreshAuthState();
  }

  actions(session: () => ChatSession): ViewActions {
    return {
      ready: () => session().restoreView(),
      send: (text) => session().send(text), stop: () => session().stop(), newChat: () => session().newChat(), newTab: () => this.openChatTab(),
      login: () => this.login(session()), logout: () => this.logout(), setApiKey: () => this.setApiKey(session()), removeApiKey: () => this.removeApiKey(session()), selectModel: () => session().selectModel(),
      loadAccounts: () => this.loadAccounts(session()), switchAccount: (accountId) => this.switchAccount(accountId, session()), addAccount: () => this.login(session()), logoutAll: () => this.logoutAll(),
      loadModels: () => session().loadModels(), chooseModel: (model) => session().chooseModel(model), chooseThinking: (thinking) => session().chooseThinking(thinking), chooseMode: (mode) => session().chooseMode(mode),
      selectThinking: () => session().selectThinking(), selectMode: () => session().selectMode(), selectWebSearch: () => session().selectWebSearch(),
    };
  }

  activeSession(): ChatSession | undefined { return this.lastActive || this.sidebarSession; }

  openChatTab(): void {
    this.createChatTab(`maxlabs.panelChat.v1.${crypto.randomUUID()}`);
  }

  restoreChatTab(panel: vscode.WebviewPanel, state: unknown): void {
    const candidate = typeof state === "object" && state ? String((state as { chatKey?: unknown }).chatKey || "") : "";
    const storageKey = candidate.startsWith("maxlabs.panelChat.v1.") ? candidate : `maxlabs.panelChat.v1.${crypto.randomUUID()}`;
    this.createChatTab(storageKey, panel);
  }

  private createChatTab(storageKey: string, restoredPanel?: vscode.WebviewPanel): void {
    let session!: ChatSession;
    const activePanel = this.lastActive ? this.panels.get(this.lastActive) : undefined;
    const existingPanel = activePanel || [...this.panels.values()].find((candidate) => candidate.panel.viewColumn !== undefined);
    const column = restoredPanel?.viewColumn || existingPanel?.panel.viewColumn || this.chatColumn || vscode.ViewColumn.Beside;
    const panel = new ChatPanel(this.context.extensionUri, this.actions(() => session), () => session.state(), column, () => this.closePanel(session), () => this.activatePanel(session), restoredPanel);
    session = new ChatSession(this, panel, storageKey);
    panel.initialize(); this.sessions.add(session); this.panels.set(session, panel); this.lastActive = session; this.chatColumn = panel.panel.viewColumn || column; panel.reveal();
  }

  activatePanel(session: ChatSession): void { this.lastActive = session; const panel = this.panels.get(session); if (panel?.panel.viewColumn) this.chatColumn = panel.panel.viewColumn; }

  closePanel(session: ChatSession): void {
    session.dispose(); this.sessions.delete(session); this.panels.delete(session);
    if (this.lastActive === session) this.lastActive = this.sidebarSession;
  }

  markActive(session: ChatSession): void { this.lastActive = session; }
  root(): vscode.Uri | undefined { return vscode.workspace.workspaceFolders?.[0]?.uri; }
  transport(sessionId = `vscode-${crypto.randomUUID()}`): GatewayTransport {
    const value = config();
    return new GatewayTransport(this.auth, () => value.get("gatewayUrl", "https://console.maxlabs.cenmax.in"), () => value.get("apiBaseUrl", "https://api.maxlabs.cenmax.in/v1"), sessionId);
  }

  async login(requesting?: ChatSession): Promise<void> {
    this.assertIdleForAccountChange();
    requesting?.view.status("Starting OAuth sign in…");
    const account = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Choose a MaxLabs account in your browser…", cancellable: true }, async (_, token) => {
      const controller = new AbortController(); token.onCancellationRequested(() => controller.abort());
      return this.auth.login(config().get("gatewayUrl", "https://console.maxlabs.cenmax.in"), controller.signal);
    });
    await this.afterAccountChange(`Using ${account.name}`);
    void vscode.window.showInformationMessage(`MaxLabs is now using ${account.name}.`);
  }

  async logout(): Promise<void> {
    this.assertIdleForAccountChange();
    const previous = this.activeAccount?.name || "this account";
    await this.auth.logout();
    await this.afterAccountChange(`Disconnected ${previous}`);
    void vscode.window.showInformationMessage(`Disconnected ${previous} from MaxLabs.`);
  }

  async logoutAll(): Promise<void> {
    this.assertIdleForAccountChange(); await this.auth.logoutAll(); await this.afterAccountChange("Signed out of every MaxLabs account");
  }

  async loadAccounts(requesting?: ChatSession): Promise<void> {
    if (!this.authenticated) { this.accounts = []; requesting?.view.accounts([]); return; }
    requesting?.view.accountLoading();
    try {
      this.accounts = await this.auth.accounts(config().get("gatewayUrl", "https://console.maxlabs.cenmax.in"));
      for (const session of this.sessions) session.view.accounts(this.accounts);
    } catch (error) {
      requesting?.view.error(error instanceof Error ? error.message : String(error));
    }
  }

  async selectAccount(requesting?: ChatSession): Promise<void> {
    this.assertIdleForAccountChange();
    if (!this.authenticated) return this.login(requesting);
    await this.loadAccounts(requesting);
    const choices = this.accounts.map((account) => ({
      label: `${account.active ? "$(check) " : ""}${account.name}`,
      description: `${account.type === "personal" ? "Personal" : account.role || "Work"}${account.connected ? " · Connected" : " · Connect with OAuth"}`,
      account,
    }));
    choices.push({ label: "$(add) Add or reconnect an account", description: "Choose Personal or Work in your browser", account: undefined as unknown as AccountOption });
    const selected = await vscode.window.showQuickPick(choices, { title: "Switch MaxLabs account", placeHolder: this.activeAccount?.name });
    if (!selected || selected.account?.active) return;
    if (!selected.account || !selected.account.connected) return this.login(requesting);
    await this.switchAccount(selected.account.id, requesting);
  }

  async switchAccount(accountId: string, requesting?: ChatSession): Promise<void> {
    this.assertIdleForAccountChange();
    const known = this.accounts.find((account) => account.id === accountId);
    if (!known?.connected) return this.login(requesting);
    if (!known.available) throw new Error(`${known.name} is no longer available. Reconnect it to confirm access.`);
    const account = await this.auth.switchAccount(accountId); await this.afterAccountChange(`Switched to ${account.name}`);
  }

  private async refreshAuthState(): Promise<void> {
    const [signedIn, apiKey, activeAccount, accounts] = await Promise.all([this.auth.signedIn(), this.auth.apiKey(), this.auth.activeAccount(), this.auth.storedAccounts()]);
    this.authenticated = signedIn; this.apiKeyConfigured = Boolean(apiKey); this.activeAccount = activeAccount; this.accounts = accounts; this.credentialsReady = true;
    for (const session of this.sessions) session.view.sync();
  }

  private async afterAccountChange(status: string): Promise<void> {
    await this.refreshAuthState();
    for (const session of this.sessions) { session.invalidateAgent(); session.view.status(status); session.view.sync(); }
  }

  private assertIdleForAccountChange(): void {
    if ([...this.sessions].some((session) => session.running)) throw new Error("Stop the active MaxLabs run before changing accounts. This keeps one run on one billing account.");
  }

  async setApiKey(requesting?: ChatSession): Promise<void> {
    const value = await vscode.window.showInputBox({ title: "MaxLabs API key fallback", prompt: "Stored securely by VS Code and used only when OAuth is unavailable.", password: true, ignoreFocusOut: true });
    if (value === undefined) return;
    await this.auth.setApiKey(value.trim() || undefined);
    this.apiKeyConfigured = Boolean(value.trim()); this.credentialsReady = true;
    for (const session of this.sessions) session.invalidateAgent();
    for (const session of this.sessions) session.view.sync();
    requesting?.view.status(value.trim() ? "API key fallback saved" : "API key fallback removed");
  }

  async removeApiKey(requesting?: ChatSession): Promise<void> {
    await this.auth.setApiKey(undefined);
    this.apiKeyConfigured = false;
    this.credentialsReady = true;
    for (const session of this.sessions) {
      session.invalidateAgent();
      session.view.sync();
    }
    requesting?.view.status("API key fallback removed");
  }

  dispose(): void {
    for (const session of [...this.sessions]) session.dispose();
    for (const panel of [...this.panels.values()]) panel.release();
    this.sessions.clear(); this.panels.clear(); this.statusItem.dispose();
  }
}

class ChatSession implements vscode.Disposable {
  readonly runtime: Runtime;
  readonly view: ChatSurface;
  agent?: Agent;
  controller?: AbortController;
  running = false;
  selectedModel: string;
  thinking: Thinking;
  mode: Mode;
  webSearch: WebSearch;
  chatId: string;
  readonly history: Message[];
  readonly meter: CacheMeter;
  readonly storageKey?: string;
  billingAccountId?: string;

  constructor(runtime: Runtime, view: ChatSurface, storageKey?: string) {
    this.runtime = runtime; this.view = view;
    this.storageKey = storageKey;
    const stored = storageKey ? runtime.context.workspaceState.get<StoredChat>(storageKey) : undefined;
    this.chatId = stored?.id || crypto.randomUUID();
    this.billingAccountId = stored?.accountId;
    this.history = validHistory(stored?.history) ? structuredClone(stored.history) : [];
    this.meter = new CacheMeter(stored?.meter);
    const value = config();
    this.selectedModel = stored?.model || value.get("model", "worker"); this.thinking = oneOf(stored?.thinking, ["minimal", "low", "medium", "high", "default"]) || value.get<Thinking>("thinking", "low");
    this.mode = oneOf(stored?.mode, ["act", "plan", "auto"]) || value.get<Mode>("mode", "act"); this.webSearch = oneOf(stored?.webSearch, ["off", "auto", "always"]) || value.get<WebSearch>("webSearch", "auto");
  }

  state(): AgentSettings & { running: boolean; authenticated: boolean; hasApiKey: boolean; credentialsReady: boolean; chatKey: string; account?: AccountIdentity } { return { ...this.settings(), running: this.running, authenticated: this.runtime.authenticated, hasApiKey: this.runtime.apiKeyConfigured, credentialsReady: this.runtime.credentialsReady, chatKey: this.storageKey || `ephemeral:${this.chatId}`, account: this.runtime.activeAccount }; }
  settings(): AgentSettings {
    const value = config();
    return { model: this.selectedModel, thinking: this.thinking, mode: this.mode, webSearch: this.webSearch, webSearchUses: value.get("webSearchUses", 3), maxSteps: value.get("maxSteps", 40) };
  }
  invalidateAgent(): void { this.agent = undefined; }
  ensureAgent(): Agent {
    if (this.agent) return this.agent;
    const root = this.runtime.root(); if (!root) throw new Error("Open a folder or workspace before using MaxLabs");
    this.agent = new Agent(this.runtime.transport(this.affinityId()), createTools(root), () => this.settings(), {
      delta: (text) => this.view.delta(text), status: (text) => this.view.status(text),
      reasoning: (text) => this.view.tokenProgress(text.length),
      toolStart: (callId, name, args) => this.view.toolStart(callId, `Using ${name}`, summary(args)),
      tool: (callId, name, args, result) => this.view.tool(callId, `${result.isError ? "Failed" : "Used"} ${name}`, `${summary(args)}\n\n${result.text}`, Boolean(result.isError)),
      steering: (text) => this.view.status(`Direction applied · ${text.slice(0, 80)}`),
      approve: (callId, tool, detail, reason, allowAlways, signal) => this.view.approval(callId, tool, detail, reason, allowAlways, signal),
    }, this.history, this.meter, () => this.persist());
    return this.agent;
  }

  async send(text: string): Promise<void> {
    if (!text.trim()) return;
    const activeAccountId = this.runtime.activeAccount?.id;
    if (this.history.length && this.billingAccountId && this.billingAccountId !== activeAccountId) {
      this.newChat(); this.view.status("New chat started to keep account histories separate");
    }
    this.billingAccountId = activeAccountId;
    this.runtime.markActive(this);
    if (this.running) { this.ensureAgent().steer(text); this.view.user(text, true); this.view.status("Direction queued for the next safe boundary"); return; }
    this.running = true; void vscode.commands.executeCommand("setContext", "maxlabs.running", true); this.view.user(text); this.view.begin(); this.controller = new AbortController();
    try {
      const result = await this.ensureAgent().run(text, this.controller.signal);
      const uncached = Math.max(0, result.usage.prompt - result.usage.cached);
      const cache = result.cache.requests ? ` · cache ${Math.round(result.cache.hitRate * 1000) / 10}%` : " · cache warming";
      this.view.finish(`${result.steps} model call${result.steps === 1 ? "" : "s"} · ${tokens(result.usage.output)} generated · ${tokens(uncached)} new input · ${tokens(result.usage.cached)} cached${cache}${result.usage.searches ? ` · ${result.usage.searches} search` : ""}`);
    } catch (error) {
      if (this.controller.signal.aborted) this.view.finish("Stopped"); else this.view.error(error instanceof Error ? error.message : String(error));
    } finally {
      this.running = false; this.controller = undefined;
      void vscode.commands.executeCommand("setContext", "maxlabs.running", [...this.runtime.sessions].some((session) => session.running)); this.view.sync();
    }
  }

  stop(): void { this.controller?.abort(new Error("Stopped by user")); }
  newChat(): void { this.stop(); this.agent?.reset(); this.history.splice(0); this.meter.reset(); this.chatId = crypto.randomUUID(); this.billingAccountId = this.runtime.activeAccount?.id; this.agent = undefined; this.persist(); this.view.reset(); this.view.status("New conversation ready"); this.view.sync(); }
  async selectModel(): Promise<void> {
    this.runtime.markActive(this);
    const models = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Loading MaxLabs models…" }, () => this.runtime.transport().models());
    const selected = await vscode.window.showQuickPick(models.map((model) => ({ label: model.id, description: model.description })), { title: "Select model for this chat", placeHolder: this.selectedModel });
    if (!selected) return; this.selectedModel = selected.label; this.invalidateAgent(); this.persist(); this.view.sync();
  }
  async loadModels(): Promise<void> { const models = await this.runtime.transport(this.affinityId()).models(); this.view.models(models, this.selectedModel); }
  async chooseModel(model: string): Promise<void> { const models = await this.runtime.transport(this.affinityId()).models(); if (!models.some((candidate) => candidate.id === model)) throw new Error(`Model ${model} is unavailable`); this.selectedModel = model; this.invalidateAgent(); this.persist(); this.view.sync(); this.view.status(`Model changed to ${model}`); }
  chooseThinking(thinking: Thinking): void { if (!(["minimal", "low", "medium", "high", "default"] as const).includes(thinking)) return; this.thinking = thinking; this.persist(); this.view.sync(); }
  chooseMode(mode: Mode): void { if (!(["act", "plan", "auto"] as const).includes(mode)) return; this.mode = mode; this.invalidateAgent(); this.persist(); this.view.sync(); }
  async selectThinking(): Promise<void> { const selected = await vscode.window.showQuickPick(["minimal", "low", "medium", "high", "default"], { title: "Select thinking level for this chat" }); if (selected) { this.thinking = selected as Thinking; this.persist(); this.view.sync(); } }
  async selectMode(): Promise<void> { const selected = await vscode.window.showQuickPick(["act", "plan", "auto"], { title: "Select mode for this chat" }); if (selected) { this.mode = selected as Mode; this.invalidateAgent(); this.persist(); this.view.sync(); } }
  async selectWebSearch(): Promise<void> { const selected = await vscode.window.showQuickPick(["off", "auto", "always"], { title: "Select web search behavior for this chat" }); if (selected) { this.webSearch = selected as WebSearch; this.persist(); this.view.sync(); } }
  dispose(): void { this.stop(); }
  restoreView(): void { this.view.restore(restoredEntries(this.history)); this.view.sync(); }
  private affinityId(): string { return `vscode:${this.chatId}:${this.selectedModel}`; }
  private persist(): void { if (this.storageKey) void this.runtime.context.workspaceState.update(this.storageKey, { id: this.chatId, history: structuredClone(this.history), meter: this.meter.serialize(), model: this.selectedModel, thinking: this.thinking, mode: this.mode, webSearch: this.webSearch, accountId: this.billingAccountId } satisfies StoredChat); }
}

function config(): vscode.WorkspaceConfiguration { return vscode.workspace.getConfiguration("maxlabs"); }
function register(context: vscode.ExtensionContext, command: string, callback: () => unknown): void { context.subscriptions.push(vscode.commands.registerCommand(command, callback)); }
function summary(args: Record<string, unknown>): string { const value = String(args.command || args.path || args.url || JSON.stringify(args)); return value.length > 600 ? `${value.slice(0, 600)}…` : value; }
function tokens(value: number): string { return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : String(value); }
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined { return typeof value === "string" && allowed.includes(value as T) ? value as T : undefined; }
function validHistory(value: unknown): value is Message[] { return Array.isArray(value) && value.every((message) => message && typeof message === "object" && ["system", "user", "assistant", "tool"].includes((message as Message).role) && Array.isArray((message as Message).content)); }
function restoredEntries(history: Message[]): RestoredEntry[] {
  const calls = new Map<string, { name: string; arguments: string }>(); const entries: RestoredEntry[] = [];
  for (const message of history) {
    const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    if (message.role === "user" && text) entries.push({ type: "user", text, steering: text.startsWith("[Direction received while working]") });
    if (message.role === "assistant" && text) entries.push({ type: "assistant", text });
    for (const block of message.content) {
      if (block.type === "tool_call") { calls.set(block.callId, { name: block.name, arguments: block.arguments }); entries.push({ type: "toolStart", id: block.callId, name: `Used ${block.name}`, detail: block.arguments }); }
      if (block.type === "tool_result") { const call = calls.get(block.callId); entries.push({ type: "tool", id: block.callId, name: `${block.isError ? "Failed" : "Used"} ${call?.name || "tool"}`, detail: `${call?.arguments || ""}${call ? "\n\n" : ""}${block.text}`, error: block.isError }); }
    }
  }
  return entries;
}

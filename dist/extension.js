import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { Agent,                    } from "./agent.js";
                                                                    
import { AuthStore } from "./auth.js";
import { CacheMeter,                      } from "./cache.js";
import { CloudWorkspace, skillCatalog, toolLabel,                 } from "./cloud.js";
import { DEFAULT_API_BASE, DEFAULT_GATEWAY, safeApiBaseUrl, safeGatewayUrl } from "./endpoints.js";
                                                                                                          
import { sanitizeImages } from "./protocol.js";
                                                   
import { createTools, disposeWorkspaceTerminals, disposeWorkspaceTerminalsFor, stopWorkspaceTerminals,           } from "./tools.js";
import { GatewayTransport } from "./transport.js";
import { ChatPanel, ChatViewProvider,                                                        } from "./view.js";

                                                                                                                                                                             

let runtime                     ;

export function activate(context                         )       {
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
  register(context, "maxlabs.stopTerminals", () => runtime?.stopTerminals());
}

export function deactivate()       { runtime?.dispose(); runtime = undefined; }

class Runtime                              {
           context                         ;
           auth           ;
           sidebarView                  ;
           sidebarSession             ;
           statusItem                      ;
           sessions = new Set             ();
           panels = new Map                        ();
  lastActive              ;
  authenticated = false;
  apiKeyConfigured = false;
  credentialsReady = false;
  activeAccount                  ;
  accounts                  = [];
  chatColumn                               ;

  constructor(context                         ) {
    this.context = context;
    this.auth = new AuthStore(context.secrets);
    let sidebarSession              ;
    this.sidebarView = new ChatViewProvider(context.extensionUri, this.actions(() => sidebarSession), () => sidebarSession.state());
    sidebarSession = new ChatSession(this, this.sidebarView, "maxlabs.sidebarChat.v1");
    this.sidebarSession = sidebarSession;
    this.sessions.add(sidebarSession);
    this.lastActive = sidebarSession;
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusItem.name = "Cenmax AI"; this.statusItem.text = "$(comment-discussion) Cenmax AI"; this.statusItem.tooltip = "Open a new Cenmax AI chat tab"; this.statusItem.command = "maxlabs.newChat"; this.statusItem.show();
    context.subscriptions.push(this.statusItem);
    context.subscriptions.push(this.auth.onDidChange(() => { void this.refreshAuthState(); }));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("maxlabs.gatewayUrl") && !event.affectsConfiguration("maxlabs.apiBaseUrl")) return;
      for (const session of this.sessions) session.invalidateAgent();
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      for (const folder of event.removed) disposeWorkspaceTerminalsFor(folder.uri);
    }));
    void this.refreshAuthState();
  }

  actions(session                   )              {
    return {
      ready: () => session().restoreView(),
      send: (text, images) => session().send(text, images), stop: () => session().stop(), newChat: () => session().newChat(), newTab: () => this.openChatTab(),
      login: () => this.login(session()), logout: () => this.logout(), setApiKey: () => this.setApiKey(session()), removeApiKey: () => this.removeApiKey(session()), selectModel: () => session().selectModel(),
      loadAccounts: () => this.loadAccounts(session()), switchAccount: (accountId) => this.switchAccount(accountId, session()), addAccount: () => this.login(session()), logoutAll: () => this.logoutAll(),
      loadModels: () => session().loadModels(), chooseModel: (model) => session().chooseModel(model), chooseThinking: (thinking) => session().chooseThinking(thinking), chooseMode: (mode) => session().chooseMode(mode),
      selectThinking: () => session().selectThinking(), selectMode: () => session().selectMode(), selectWebSearch: () => session().selectWebSearch(),
    };
  }

  activeSession()                          { return this.lastActive || this.sidebarSession; }

  openChatTab()       {
    this.createChatTab(`maxlabs.panelChat.v1.${crypto.randomUUID()}`);
  }

  restoreChatTab(panel                     , state         )       {
    const candidate = typeof state === "object" && state ? String((state                         ).chatKey || "") : "";
    const storageKey = candidate.startsWith("maxlabs.panelChat.v1.") ? candidate : `maxlabs.panelChat.v1.${crypto.randomUUID()}`;
    this.createChatTab(storageKey, panel);
  }

          createChatTab(storageKey        , restoredPanel                      )       {
    let session              ;
    const activePanel = this.lastActive ? this.panels.get(this.lastActive) : undefined;
    const existingPanel = activePanel || [...this.panels.values()].find((candidate) => candidate.panel.viewColumn !== undefined);
    const column = restoredPanel?.viewColumn || existingPanel?.panel.viewColumn || this.chatColumn || vscode.ViewColumn.Beside;
    const panel = new ChatPanel(this.context.extensionUri, this.actions(() => session), () => session.state(), column, () => this.closePanel(session), () => this.activatePanel(session), restoredPanel);
    session = new ChatSession(this, panel, storageKey);
    panel.initialize(); this.sessions.add(session); this.panels.set(session, panel); this.lastActive = session; this.chatColumn = panel.panel.viewColumn || column; panel.reveal();
  }

  activatePanel(session             )       { this.lastActive = session; const panel = this.panels.get(session); if (panel?.panel.viewColumn) this.chatColumn = panel.panel.viewColumn; }

  closePanel(session             )       {
    session.dispose(); this.sessions.delete(session); this.panels.delete(session);
    if (this.lastActive === session) this.lastActive = this.sidebarSession;
  }

  markActive(session             )       { this.lastActive = session; }
  root()                         { return vscode.workspace.workspaceFolders?.[0]?.uri; }
  transport(sessionId = `vscode-${crypto.randomUUID()}`)                   {
    const value = config();
    return new GatewayTransport(this.auth, () => safeGatewayUrl(value.get("gatewayUrl", DEFAULT_GATEWAY)), () => safeApiBaseUrl(value.get("apiBaseUrl", DEFAULT_API_BASE)), sessionId);
  }

  async login(requesting              )                {
    this.assertIdleForAccountChange();
    requesting?.view.status("Starting OAuth sign in…");
    const account = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Choose a Cenmax AI account in your browser…", cancellable: true }, async (_, token) => {
      const controller = new AbortController(); token.onCancellationRequested(() => controller.abort());
      return this.auth.login(safeGatewayUrl(config().get("gatewayUrl", DEFAULT_GATEWAY)), controller.signal);
    });
    await this.afterAccountChange(`Using ${account.name}`);
    void vscode.window.showInformationMessage(`Cenmax AI is now using ${account.name}.`);
  }

  async logout()                {
    this.assertIdleForAccountChange();
    const previous = this.activeAccount?.name || "this account";
    await this.auth.logout();
    await this.afterAccountChange(`Disconnected ${previous}`);
    void vscode.window.showInformationMessage(`Disconnected ${previous} from Cenmax AI.`);
  }

  async logoutAll()                {
    this.assertIdleForAccountChange(); await this.auth.logoutAll(); await this.afterAccountChange("Signed out of every Cenmax AI account");
  }

  async loadAccounts(requesting              )                {
    if (!this.authenticated) { this.accounts = []; requesting?.view.accounts([]); return; }
    requesting?.view.accountLoading();
    try {
      this.accounts = await this.auth.accounts(safeGatewayUrl(config().get("gatewayUrl", DEFAULT_GATEWAY)));
      for (const session of this.sessions) session.view.accounts(this.accounts);
    } catch (error) {
      requesting?.view.error(error instanceof Error ? error.message : String(error));
    }
  }

  async selectAccount(requesting              )                {
    this.assertIdleForAccountChange();
    if (!this.authenticated) return this.login(requesting);
    await this.loadAccounts(requesting);
    const choices = this.accounts.map((account) => ({
      label: `${account.active ? "$(check) " : ""}${account.name}`,
      description: `${account.type === "personal" ? "Personal" : account.role || "Work"}${account.connected ? " · Connected" : " · Connect with OAuth"}`,
      account,
    }));
    choices.push({ label: "$(add) Add or reconnect an account", description: "Choose Personal or Work in your browser", account: undefined                             });
    const selected = await vscode.window.showQuickPick(choices, { title: "Switch Cenmax AI account", placeHolder: this.activeAccount?.name });
    if (!selected || selected.account?.active) return;
    if (!selected.account || !selected.account.connected) return this.login(requesting);
    await this.switchAccount(selected.account.id, requesting);
  }

  async switchAccount(accountId        , requesting              )                {
    this.assertIdleForAccountChange();
    const known = this.accounts.find((account) => account.id === accountId);
    if (!known?.connected) return this.login(requesting);
    if (!known.available) throw new Error(`${known.name} is no longer available. Reconnect it to confirm access.`);
    const account = await this.auth.switchAccount(accountId); await this.afterAccountChange(`Switched to ${account.name}`);
  }

          async refreshAuthState()                {
    const [signedIn, apiKey, activeAccount, accounts] = await Promise.all([this.auth.signedIn(), this.auth.apiKey(), this.auth.activeAccount(), this.auth.storedAccounts()]);
    this.authenticated = signedIn; this.apiKeyConfigured = Boolean(apiKey); this.activeAccount = activeAccount; this.accounts = accounts; this.credentialsReady = true;
    for (const session of this.sessions) session.view.sync();
  }

          async afterAccountChange(status        )                {
    await this.refreshAuthState();
    for (const session of this.sessions) { session.invalidateAgent(); session.view.status(status); session.view.sync(); }
  }

          assertIdleForAccountChange()       {
    if ([...this.sessions].some((session) => session.running)) throw new Error("Stop the active Cenmax AI run before changing accounts. This keeps one run on one billing account.");
  }

  async setApiKey(requesting              )                {
    const value = await vscode.window.showInputBox({ title: "Cenmax AI API key fallback", prompt: "Stored securely by VS Code and used only when OAuth is unavailable.", password: true, ignoreFocusOut: true });
    if (value === undefined) return;
    await this.auth.setApiKey(value.trim() || undefined);
    this.apiKeyConfigured = Boolean(value.trim()); this.credentialsReady = true;
    for (const session of this.sessions) session.invalidateAgent();
    for (const session of this.sessions) session.view.sync();
    requesting?.view.status(value.trim() ? "API key fallback saved" : "API key fallback removed");
  }

  async removeApiKey(requesting              )                {
    await this.auth.setApiKey(undefined);
    this.apiKeyConfigured = false;
    this.credentialsReady = true;
    for (const session of this.sessions) {
      session.invalidateAgent();
      session.view.sync();
    }
    requesting?.view.status("API key fallback removed");
  }

  dispose()       {
    for (const session of [...this.sessions]) session.dispose();
    for (const panel of [...this.panels.values()]) panel.release();
    this.sessions.clear(); this.panels.clear(); this.statusItem.dispose();
    disposeWorkspaceTerminals();
  }

  async stopTerminals()                {
    const stopped = await stopWorkspaceTerminals();
    void vscode.window.showInformationMessage(stopped ? `Stopped ${stopped} background terminal${stopped === 1 ? "" : "s"}.` : "No background terminals are running.");
  }
}

class ChatSession                              {
           runtime         ;
           view             ;
  agent        ;
  controller                  ;
  running = false;
  stopping = false;
           queued                                               = [];
  selectedModel        ;
  thinking          ;
  mode      ;
  webSearch           ;
  chatId        ;
           history           ;
           meter            ;
           storageKey         ;
  billingAccountId         ;
          agentPromise                 ;
          agentRevision = 0;
                   modelLimits = new Map                                                            ();

  /**
   * Set when a setting changed while a turn was running.
   *
   * The turn's next step must use the new value immediately, but the agent
   * object must not be torn down mid-flight: doing that is what made a model or
   * mode switch abort work in progress. A model change only needs a new value
   * for the next request, which `settings()` already supplies per step, so the
   * rebuild itself is deferred to the end of the turn, where it is free.
   */
          pendingRebuild = false;
          cloudWarned = false;
          cloud                                                                                                          ;

  constructor(runtime         , view             , storageKey         ) {
    this.runtime = runtime; this.view = view;
    this.storageKey = storageKey;
    const stored = storageKey ? runtime.context.workspaceState.get            (storageKey) : undefined;
    this.chatId = stored?.id || crypto.randomUUID();
    this.billingAccountId = stored?.accountId;
    this.history = validHistory(stored?.history) ? structuredClone(stored.history) : [];
    this.meter = new CacheMeter(stored?.meter);
    const value = config();
    this.selectedModel = stored?.model || value.get("model", "worker"); this.thinking = oneOf(stored?.thinking, ["minimal", "low", "medium", "high", "default"]) || value.get          ("thinking", "low");
    this.mode = oneOf(stored?.mode, ["manual", "plan", "approve"]) || value.get      ("mode", "manual"); this.webSearch = oneOf(stored?.webSearch, ["off", "auto", "always"]) || value.get           ("webSearch", "auto");
  }

  state()                                                                                                                                                          { return { ...this.settings(), running: this.running, authenticated: this.runtime.authenticated, hasApiKey: this.runtime.apiKeyConfigured, credentialsReady: this.runtime.credentialsReady, chatKey: this.storageKey || `ephemeral:${this.chatId}`, account: this.runtime.activeAccount }; }
  settings()                {
    const value = config();
    const limits = this.modelLimits.get(this.selectedModel);
    return { model: this.selectedModel, thinking: this.thinking, mode: vscode.workspace.isTrusted ? this.mode : "plan", webSearch: this.webSearch, webSearchUses: value.get("webSearchUses", 3), maxSteps: value.get("maxSteps", 40), contextWindow: limits?.contextWindow || (this.selectedModel === "pro" ? 1_000_000 : 262_144), maxOutputTokens: limits?.maxOutputTokens || 8192, workspaceRoot: this.runtime.root()?.fsPath, reviewer: (tool, args, userMessages, signal) => this.reviewCommand(tool, args, userMessages, signal) };
  }
          rememberModels(models             )       {
    for (const model of models) {
      if (model.context_window && model.context_window > 0) {
        this.modelLimits.set(model.id, {
          contextWindow: model.context_window,
          maxOutputTokens: model.max_output_tokens && model.max_output_tokens > 0 ? model.max_output_tokens : 8192,
        });
      }
    }
  }
          async reviewCommand(tool        , args                         , userMessages          , signal              )                                     {
    if (!this.runtime.authenticated) return undefined;
    const command = tool === "write" || tool === "edit"
      ? `write ${String(args.path || "")} (${String(args.content || args.new || "").length} bytes, temporary helper)`
      : String(args.command || "");
    if (!command.trim()) return undefined;
    try { return await this.runtime.transport(this.affinityId()).auditCommand({ command, userMessages, workspace: this.runtime.root()?.fsPath || "", model: this.selectedModel, signal }); }
    catch { return undefined; }
  }
  /**
   * Discard the agent so the next turn rebuilds it.
   *
   * During a run the discard is deferred: the in-flight turn keeps the agent it
   * started with, and the rebuild happens at the turn's end. The new settings are
   * still picked up by the running turn at its next step, because `settings()` is
   * read per request.
   */
  invalidateAgent()       {
    this.agentRevision++;
    if (this.running) { this.pendingRebuild = true; return; }
    this.agent = undefined;
    this.agentPromise = undefined;
    this.cloud = undefined;
    this.cloudWarned = false;
  }

  /** Apply a rebuild that was deferred while a turn was running. */
          settlePendingRebuild()       {
    if (!this.pendingRebuild) return;
    this.pendingRebuild = false;
    this.agent = undefined;
    this.agentPromise = undefined;
    this.cloud = undefined;
    this.cloudWarned = false;
  }
  ensureAgent()                 {
    if (this.agent) return Promise.resolve(this.agent);
    if (!this.agentPromise) {
      const pending = this.buildAgent(this.agentRevision).finally(() => { if (this.agentPromise === pending) this.agentPromise = undefined; });
      this.agentPromise = pending;
    }
    return this.agentPromise;
  }
          async buildAgent(revision        )                 {
    const root = this.runtime.root(); if (!root) throw new Error("Open a folder or workspace before using Cenmax AI");
    const tools = createTools(root);
    const cloud = await this.loadCloud(revision);
    if (revision !== this.agentRevision) throw new Error("This conversation setup was cancelled.");
    for (const tool of cloud.tools) tools.register(tool);
    if (cloud.workspace && cloud.skills.length) tools.register(cloud.workspace.createSkillTool(cloud.skills));
    this.agent = new Agent(this.runtime.transport(this.affinityId()), tools, () => this.settings(), {
      delta: (text) => this.view.delta(text), status: (text) => this.view.status(text),
      reasoning: (text) => this.view.thinking(text),
      toolStart: (callId, name, args) => this.view.toolStart(callId, `Using ${toolLabel(name)}`, summary(args)),
      tool: (callId, name, args, result) => this.view.tool(callId, `${result.isError ? "Failed" : "Used"} ${toolLabel(name)}`, `${summary(args)}\n\n${result.text}`, Boolean(result.isError)),
      steering: (text) => this.view.status(`Direction applied · ${text.slice(0, 80)}`),
      approve: (callId, tool, detail, reason, allowAlways, signal) => this.view.approval(callId, toolLabel(tool), detail, reason, allowAlways, signal),
      context: () => this.cloudContext(),
    }, this.history, this.meter, () => this.persist());
    return this.agent;
  }

  /** Connected MCP tools and skills belong to the signed-in account, not the workspace. */
          async loadCloud(revision        )                                                                               {
    const accountId = this.runtime.activeAccount?.id;
    if (!this.runtime.authenticated || !accountId) return { tools: [], skills: [] };
    const cached = this.cloud;
    if (cached && cached.accountId === accountId && Date.now() - cached.loadedAt < 60_000) return cached;
    const transport = this.runtime.transport(this.affinityId());
    const workspace = new CloudWorkspace({
      get: (path, signal) => transport.workspace(path, { signal }),
      post: (path, body, idempotencyKey, signal) => transport.workspace(path, { method: "POST", body, idempotencyKey, signal }),
    });
    const [tools, skills] = await (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try { return await Promise.allSettled([workspace.loadTools(controller.signal), workspace.loadSkills(controller.signal)]); }
      finally { clearTimeout(timer); }
    })();
    if (revision !== this.agentRevision || accountId !== this.runtime.activeAccount?.id) throw new Error("This conversation setup was cancelled.");
    if (!this.cloudWarned && [tools, skills].some((result) => result.status === "rejected" && errorText(result.reason).includes("has not granted access"))) {
      this.cloudWarned = true;
      void vscode.window.showWarningMessage("Reconnect your Cenmax AI account to use its connected tools and skills.", "Reconnect").then((choice) => { if (choice) void this.runtime.login(this); });
    }
    if (tools.status === "rejected") console.error("Cenmax AI connected tools are unavailable.");
    if (skills.status === "rejected") console.error("Cenmax AI account skills are unavailable.");
    const value = { accountId, loadedAt: Date.now(), workspace, tools: tools.status === "fulfilled" ? tools.value : [], skills: skills.status === "fulfilled" ? skills.value : [] };
    this.cloud = value;
    return value;
  }

          cloudContext()         {
    const parts           = [];
    if (this.cloud?.tools.length) parts.push("Tools whose names begin with mcp_ are connected tools enabled on the user's Cenmax AI account. They act on external services and require approval; use them only when the request needs that service.");
    const catalog = skillCatalog(this.cloud?.skills || []);
    if (catalog) parts.push(catalog);
    return parts.join("\n\n");
  }

  async send(text        , images              = [], echo = true)                {
    const attachments = sanitizeImages(images);
    if (!text.trim() && !attachments.length) return;
    const activeAccountId = this.runtime.activeAccount?.id;
    if (this.history.length && this.billingAccountId && this.billingAccountId !== activeAccountId) {
      this.newChat(); this.view.status("New chat started to keep account histories separate");
    }
    this.billingAccountId = activeAccountId;
    this.runtime.markActive(this);
    if (this.running) {
      if (this.stopping || attachments.length || !this.agent) { this.queued.push({ text, images: attachments }); if (echo) this.view.user(text, false, attachments); this.view.status("Queued until the current turn stops"); return; }
      this.agent?.steer(text);
      if (echo) this.view.user(text, true);
      this.view.status("Direction queued for the next safe boundary");
      return;
    }
    if (this.agent && (!this.cloud || Date.now() - this.cloud.loadedAt > 60_000)) this.invalidateAgent();
    this.running = true; this.stopping = false;
    void vscode.commands.executeCommand("setContext", "maxlabs.running", true);
    if (echo) this.view.user(text, false, attachments);
    this.view.begin();
    const controller = new AbortController();
    this.controller = controller;
    try {
      const result = await (await this.ensureAgent()).run(text, controller.signal, attachments);
      if (this.controller !== controller) return;
      const uncached = Math.max(0, result.usage.prompt - result.usage.cached);
      const cache = result.cache.requests ? ` · cache ${Math.round(result.cache.hitRate * 1000) / 10}%` : " · cache warming";
      this.view.finish(`${result.steps} model call${result.steps === 1 ? "" : "s"} · ${tokens(result.usage.output)} generated · ${tokens(uncached)} new input · ${tokens(result.usage.cached)} cached${cache}${result.usage.searches ? ` · ${result.usage.searches} search` : ""}`);
    } catch (error) {
      if (this.controller !== controller) return;
      if (controller.signal.aborted) this.view.finish("Stopped"); else this.view.error(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.controller === controller) {
        this.running = false; this.controller = undefined; this.stopping = false;
        this.settlePendingRebuild();
        void vscode.commands.executeCommand("setContext", "maxlabs.running", [...this.runtime.sessions].some((session) => session.running)); this.view.sync();
        const queued = this.queued.splice(0);
        if (queued.length) void this.send(queued.map((item) => item.text).filter(Boolean).join("\n\n"), sanitizeImages(queued.flatMap((item) => item.images)), false);
      }
    }
  }

  stop()       { if (!this.running) return; this.stopping = true; this.controller?.abort(new Error("Stopped by user")); }
  newChat()       {
    this.stop();
    this.queued.length = 0;
    this.running = false; this.controller = undefined; this.stopping = false;
    void vscode.commands.executeCommand("setContext", "maxlabs.running", [...this.runtime.sessions].some((session) => session.running));
    this.agent?.reset(); this.history.splice(0); this.meter.reset(); this.chatId = crypto.randomUUID(); this.billingAccountId = this.runtime.activeAccount?.id; this.invalidateAgent(); this.cloud = undefined; this.persist(); this.view.reset(); this.view.status("New conversation ready"); this.view.sync();
  }
  async selectModel()                {
    this.runtime.markActive(this);
    const models = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Loading Cenmax AI models…" }, () => this.runtime.transport().models());
    const selected = await vscode.window.showQuickPick(models.map((model) => ({ label: model.id, description: model.description })), { title: "Select model for this chat", placeHolder: this.selectedModel });
    this.rememberModels(models);
    if (!selected) return; this.selectedModel = selected.label; this.invalidateAgent(); this.persist(); this.view.sync();
  }
  async loadModels()                { const models = await this.runtime.transport(this.affinityId()).models(); this.rememberModels(models); this.view.models(models, this.selectedModel); }
  async chooseModel(model        )                {
    const models = await this.runtime.transport(this.affinityId()).models();
    this.rememberModels(models);
    if (!models.some((candidate) => candidate.id === model)) throw new Error(`Model ${model} is unavailable`);
    this.selectedModel = model;
    this.invalidateAgent();
    this.persist();
    this.view.sync();
    // The running turn picks this up at its next request; saying so is the
    // difference between a control that worked and one that looks ignored.
    this.view.status(this.running ? `Model will switch to ${model} at the next step` : `Model changed to ${model}`);
  }
  chooseThinking(thinking          )       {
    if (!(["minimal", "low", "medium", "high", "default"]         ).includes(thinking)) return;
    this.thinking = thinking;
    this.persist();
    this.view.sync();
    // Thinking effort is a request parameter, so this needs no rebuild at all.
    if (this.running) this.view.status(`Thinking will change to ${thinking} at the next step`);
  }
  chooseMode(mode      )       {
    if (mode !== "manual" && mode !== "plan" && mode !== "approve") return;
    this.mode = mode;
    this.invalidateAgent();
    this.persist();
    this.view.sync();
    // The mode is prompt content, so the running turn rewrites it at its next
    // safe point and every later step appends as usual.
    if (this.running) this.view.status(`Mode will change to ${mode} at the next step`);
  }
  async selectThinking()                {
    const selected = await vscode.window.showQuickPick(["minimal", "low", "medium", "high", "default"], { title: "Select thinking level for this chat" });
    if (selected) this.chooseThinking(selected            );
  }
  async selectMode()                {
    const selected = await vscode.window.showQuickPick(["manual", "plan", "approve"], { title: "Select mode for this chat" });
    if (selected) this.chooseMode(selected        );
  }
  async selectWebSearch()                { const selected = await vscode.window.showQuickPick(["off", "auto", "always"], { title: "Select web search behavior for this chat" }); if (selected) { this.webSearch = selected             ; this.persist(); this.view.sync(); } }
  dispose()       { this.stop(); this.invalidateAgent(); this.queued.length = 0; this.running = false; this.controller = undefined; this.stopping = false; }
  restoreView()       { this.view.restore(restoredEntries(this.history)); this.view.sync(); }
          affinityId()         { return `vscode:${this.chatId}:${this.selectedModel}`; }
          persist()       { if (this.storageKey) void this.runtime.context.workspaceState.update(this.storageKey, { id: this.chatId, history: structuredClone(this.history), meter: this.meter.serialize(), model: this.selectedModel, thinking: this.thinking, mode: this.mode, webSearch: this.webSearch, accountId: this.billingAccountId }                     ); }
}

function config()                                { return vscode.workspace.getConfiguration("maxlabs"); }
function register(context                         , command        , callback               )       { context.subscriptions.push(vscode.commands.registerCommand(command, callback)); }
function summary(args                         )         { const value = String(args.command || args.path || args.url || JSON.stringify(args)); return value.length > 600 ? `${value.slice(0, 600)}…` : value; }
function tokens(value        )         { return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : String(value); }
function oneOf                  (value         , allowed              )                { return typeof value === "string" && allowed.includes(value     ) ? value      : undefined; }
function validHistory(value         )                     { return Array.isArray(value) && value.every((message) => message && typeof message === "object" && ["system", "user", "assistant", "tool"].includes((message           ).role) && Array.isArray((message           ).content)); }
function restoredEntries(history           )                  {
  const calls = new Map                                             (); const entries                  = [];
  for (const message of history) {
    const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const images = message.content.filter((block)                      => block.type === "image").map((block) => ({ mimeType: block.mimeType, data: block.data }));
    if (message.role === "user" && (text || images.length)) entries.push({ type: "user", text, steering: text.startsWith("[Direction received while working]"), images });
    if (message.role === "assistant" && text) entries.push({ type: "assistant", text });
    for (const block of message.content) {
      if (block.type === "tool_call") { calls.set(block.callId, { name: block.name, arguments: block.arguments }); entries.push({ type: "toolStart", id: block.callId, name: `Used ${toolLabel(block.name)}`, detail: block.arguments }); }
      if (block.type === "tool_result") { const call = calls.get(block.callId); entries.push({ type: "tool", id: block.callId, name: `${block.isError ? "Failed" : "Used"} ${call?.name || "tool"}`, detail: `${call?.arguments || ""}${call ? "\n\n" : ""}${block.text}`, error: block.isError }); }
    }
  }
  return entries;
}
function errorText(error         )         { return error instanceof Error ? error.message : String(error); }


//# sourceURL=../src/extension.ts
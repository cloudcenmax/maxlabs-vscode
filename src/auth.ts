import * as vscode from "vscode";
import { accountFromProfile, accountListRejectsCredential, mergeAccountOptions, parseStoredState, type AccountIdentity, type AccountOption, type OAuthTokens, type StoredOAuthState } from "./accounts.ts";

interface Grant { device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; expires_in: number; interval: number }

const oauthKey = "maxlabs.oauth";
const apiKey = "maxlabs.apiKey";

export class AuthStore {
  readonly secrets: vscode.SecretStorage;
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changes.event;
  private readonly refreshes = new Map<string, Promise<string | undefined>>();
  constructor(secrets: vscode.SecretStorage) { this.secrets = secrets; }

  async apiKey(): Promise<string | undefined> { return this.secrets.get(apiKey); }
  async setApiKey(value?: string): Promise<void> {
    if (value) await this.secrets.store(apiKey, value);
    else await this.secrets.delete(apiKey);
  }
  async signedIn(): Promise<boolean> { return Boolean(await this.secrets.get(oauthKey)); }
  async activeAccount(): Promise<AccountIdentity | undefined> {
    const state = parseStoredState(await this.secrets.get(oauthKey));
    const account = state?.accounts[state.active_account_id];
    return account && identity(account);
  }
  async storedAccounts(): Promise<AccountOption[]> { return mergeAccountOptions(undefined, parseStoredState(await this.secrets.get(oauthKey))); }
  async logout(): Promise<void> {
    const state = parseStoredState(await this.secrets.get(oauthKey));
    if (!state) { await this.secrets.delete(oauthKey); this.changes.fire(); return; }
    delete state.accounts[state.active_account_id];
    const next = Object.keys(state.accounts)[0];
    if (next) { state.active_account_id = next; await this.save(state); }
    else await this.secrets.delete(oauthKey);
    this.changes.fire();
  }
  async logoutAll(): Promise<void> { await this.secrets.delete(oauthKey); this.changes.fire(); }
  async switchAccount(accountId: string): Promise<AccountIdentity> {
    const state = parseStoredState(await this.secrets.get(oauthKey));
    const account = state?.accounts[accountId];
    if (!state || !account) throw new Error("That account is not connected. Add it with OAuth first.");
    state.active_account_id = accountId; await this.save(state); this.changes.fire(); return identity(account);
  }

  async accessToken(origin: string, signal?: AbortSignal): Promise<string | undefined> {
    const raw = await this.secrets.get(oauthKey);
    if (!raw) return undefined;
    const state = parseStoredState(raw);
    if (!state) return this.migrateLegacy(origin, raw, signal);
    const accountId = state.active_account_id;
    const tokens = state.accounts[accountId]?.tokens;
    if (!tokens) return undefined;
    if (tokens.access_token && Date.parse(tokens.expires_at) > Date.now() + 60_000) return tokens.access_token;
    if (!tokens.refresh_token) return undefined;
    const inFlight = this.refreshes.get(accountId);
    if (inFlight) return inFlight;
    const refresh = this.refreshAccount(origin, accountId, tokens, signal).finally(() => this.refreshes.delete(accountId));
    this.refreshes.set(accountId, refresh);
    return refresh;
  }

  private async refreshAccount(origin: string, accountId: string, tokens: OAuthTokens, signal?: AbortSignal): Promise<string | undefined> {
    const response = await fetch(`${trim(origin)}/oauth/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: "cli", refresh_token: tokens.refresh_token }), signal,
    });
    const payload = await responseJson(response);
    if (!response.ok || payload.error) {
      const reason = String(payload.error || response.status);
      if (payload.error === "invalid_grant" || payload.error === "invalid_client" || response.status === 401) {
        await this.removeAccount(accountId);
        throw new Error(`This MaxLabs account is no longer authorized (${reason}). Switch accounts or reconnect it.`);
      }
      throw new Error(`MaxLabs could not refresh this account (${reason}). Its saved sign-in was preserved; try again.`);
    }
    const refreshed = normalize(payload);
    const latest = parseStoredState(await this.secrets.get(oauthKey));
    if (latest?.accounts[accountId] && latest.accounts[accountId].tokens.refresh_token === tokens.refresh_token) {
      latest.accounts[accountId].tokens = refreshed; await this.save(latest);
    }
    return refreshed.access_token;
  }

  async login(origin: string, signal?: AbortSignal): Promise<AccountIdentity> {
    const response = await fetch(`${trim(origin)}/oauth/device/code`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: "cli", scope: "profile usage:read chat" }), signal,
    });
    if (!response.ok) throw new Error(`OAuth device authorization returned ${response.status}`);
    const grant = await response.json() as Grant;
    const target = grant.verification_uri_complete || grant.verification_uri;
    await vscode.env.openExternal(vscode.Uri.parse(target));
    void vscode.window.showInformationMessage(`Approve MaxLabs in your browser. Code: ${grant.user_code}`);
    let interval = Math.max(grant.interval || 1, 1) * 1_000;
    const deadline = Date.now() + grant.expires_in * 1_000;
    while (Date.now() < deadline) {
      await delay(interval, signal);
      const poll = await fetch(`${trim(origin)}/oauth/token`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: "cli", device_code: grant.device_code }), signal,
      });
      const payload = await responseJson(poll);
      if (payload.error === "authorization_pending") continue;
      if (payload.error === "slow_down") { interval += 5_000; continue; }
      if (!poll.ok || payload.error) throw new Error(`OAuth authorization failed: ${payload.error || poll.status}`);
      const tokens = normalize(payload);
      const profile = await authorizedJson(`${trim(origin)}/app/v1/me`, tokens.access_token, signal);
      const account = accountFromProfile(profile);
      const state = parseStoredState(await this.secrets.get(oauthKey)) || { version: 2, active_account_id: account.id, accounts: {} };
      state.accounts[account.id] = { ...account, tokens }; state.active_account_id = account.id;
      await this.save(state); this.changes.fire(); return account;
    }
    throw new Error("OAuth device code expired");
  }

  async accounts(origin: string, signal?: AbortSignal): Promise<AccountOption[]> {
    try {
      const attemptedAccount = await this.activeAccount();
      const token = await this.accessToken(origin, signal);
      if (!token) return this.storedAccounts();
      const response = await fetch(`${trim(origin)}/app/v1/accounts`, { headers: { accept: "application/json", authorization: `Bearer ${token}` }, signal });
      if (accountListRejectsCredential(response.status)) {
        if (attemptedAccount) await this.removeAccount(attemptedAccount.id);
        return this.storedAccounts();
      }
      if (!response.ok) return this.storedAccounts();
      const remote = await responseJson(response);
      return mergeAccountOptions(remote, parseStoredState(await this.secrets.get(oauthKey)));
    } catch (error) {
      if (signal?.aborted) throw error;
      return this.storedAccounts();
    }
  }

  async invalidateActive(): Promise<void> {
    const state = parseStoredState(await this.secrets.get(oauthKey));
    if (state) await this.removeAccount(state.active_account_id);
  }

  private async migrateLegacy(origin: string, raw: string, signal?: AbortSignal): Promise<string | undefined> {
    let tokens: OAuthTokens;
    try { tokens = JSON.parse(raw) as OAuthTokens; } catch { await this.secrets.delete(oauthKey); return undefined; }
    if (!tokens.access_token) { await this.secrets.delete(oauthKey); return undefined; }
    try {
      if (Date.parse(tokens.expires_at) <= Date.now() + 60_000 && tokens.refresh_token) {
        const response = await fetch(`${trim(origin)}/oauth/token`, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams({ grant_type: "refresh_token", client_id: "cli", refresh_token: tokens.refresh_token }), signal,
        });
        const payload = await responseJson(response);
        if (!response.ok || payload.error) {
          if (payload.error === "invalid_grant" || payload.error === "invalid_client" || response.status === 401) await this.secrets.delete(oauthKey);
          throw new Error(`OAuth refresh failed: ${payload.error || response.status}`);
        }
        tokens = normalize(payload);
      }
      const profile = await authorizedJson(`${trim(origin)}/app/v1/me`, tokens.access_token, signal);
      const account = accountFromProfile(profile);
      await this.save({ version: 2, active_account_id: account.id, accounts: { [account.id]: { ...account, tokens } } });
      this.changes.fire(); return tokens.access_token;
    } catch (error) {
      if (!await this.secrets.get(oauthKey)) this.changes.fire();
      throw error;
    }
  }

  private async removeAccount(accountId: string): Promise<void> {
    const state = parseStoredState(await this.secrets.get(oauthKey)); if (!state) return;
    delete state.accounts[accountId]; const next = Object.keys(state.accounts)[0];
    if (next) { state.active_account_id = next; await this.save(state); } else await this.secrets.delete(oauthKey);
    this.changes.fire();
  }
  private async save(state: StoredOAuthState): Promise<void> { await this.secrets.store(oauthKey, JSON.stringify(state)); }
}

function normalize(payload: Record<string, unknown>): OAuthTokens {
  if (!payload.access_token) throw new Error("OAuth gateway returned no access token");
  return { access_token: String(payload.access_token), refresh_token: String(payload.refresh_token || ""), expires_at: new Date(Date.now() + Number(payload.expires_in || 3600) * 1_000).toISOString() };
}
async function authorizedJson(url: string, token: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { accept: "application/json", authorization: `Bearer ${token}` }, signal });
  const payload = await responseJson(response);
  if (!response.ok) throw new Error(`MaxLabs account lookup returned ${response.status}`);
  return payload;
}
async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return { error: response.ok ? "invalid_response" : `http_${response.status}` }; }
}
function identity(account: AccountIdentity): AccountIdentity { return { id: account.id, type: account.type, name: account.name, organization_id: account.organization_id, membership_id: account.membership_id }; }
function trim(value: string): string { return value.replace(/\/$/, ""); }
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); });
}

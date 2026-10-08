export interface AccountIdentity {
  id: string;
  type: "personal" | "organization";
  name: string;
  organization_id: number | null;
  membership_id: number | null;
}

export interface AccountOption extends AccountIdentity {
  role?: string | null;
  tier?: { id?: number; name?: string } | string | null;
  available: boolean;
  connected: boolean;
  active: boolean;
}

export interface OAuthTokens { access_token: string; refresh_token: string; expires_at: string }
export interface StoredAccount extends AccountIdentity { tokens: OAuthTokens }
export interface StoredOAuthState { version: 2; active_account_id: string; accounts: Record<string, StoredAccount> }

export function accountListRejectsCredential(status: number): boolean { return status === 401 || status === 403; }

export function accountFromProfile(payload: Record<string, unknown>): AccountIdentity {
  const raw = payload.account;
  if (!raw || typeof raw !== "object") throw new Error("MaxLabs profile did not identify the billing account");
  const account = raw as Record<string, unknown>;
  const id = String(account.id || "").trim();
  const type = account.type === "personal" ? "personal" : account.type === "organization" ? "organization" : undefined;
  if (!id || !type) throw new Error("MaxLabs profile returned an invalid billing account");
  return {
    id,
    type,
    name: String(account.name || (type === "personal" ? "Personal" : "Work")),
    organization_id: integerOrNull(account.organization_id),
    membership_id: integerOrNull(account.membership_id),
  };
}

export function parseStoredState(raw: string | undefined): StoredOAuthState | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.version !== 2 || typeof value.active_account_id !== "string" || !value.accounts || typeof value.accounts !== "object") return undefined;
    const accounts = value.accounts as Record<string, StoredAccount>;
    if (!accounts[value.active_account_id]) return undefined;
    return { version: 2, active_account_id: value.active_account_id, accounts };
  } catch { return undefined; }
}

export function mergeAccountOptions(remote: unknown, stored: StoredOAuthState | undefined): AccountOption[] {
  const body = remote && typeof remote === "object" ? remote as Record<string, unknown> : {};
  const remoteAccounts = Array.isArray(body.accounts) ? body.accounts : [];
  const result = new Map<string, AccountOption>();
  for (const candidate of remoteAccounts) {
    if (!candidate || typeof candidate !== "object") continue;
    const account = candidate as Record<string, unknown>;
    const id = String(account.id || "").trim();
    const type = account.type === "personal" ? "personal" : account.type === "organization" ? "organization" : undefined;
    if (!id || !type) continue;
    result.set(id, {
      id, type, name: String(account.name || (type === "personal" ? "Personal" : "Work")),
      organization_id: integerOrNull(account.organization_id), membership_id: integerOrNull(account.membership_id),
      role: typeof account.role === "string" ? account.role : null,
      tier: typeof account.tier === "string" || (account.tier !== null && typeof account.tier === "object") ? account.tier as AccountOption["tier"] : null,
      available: account.available !== false, connected: Boolean(stored?.accounts[id]), active: stored?.active_account_id === id,
    });
  }
  for (const account of Object.values(stored?.accounts || {})) {
    if (result.has(account.id)) continue;
    result.set(account.id, { ...withoutTokens(account), available: false, connected: true, active: stored?.active_account_id === account.id });
  }
  return [...result.values()].sort((left, right) => Number(right.active) - Number(left.active) || Number(right.type === "personal") - Number(left.type === "personal") || left.name.localeCompare(right.name));
}

function withoutTokens(account: StoredAccount): AccountIdentity {
  return { id: account.id, type: account.type, name: account.name, organization_id: account.organization_id, membership_id: account.membership_id };
}
function integerOrNull(value: unknown): number | null { return Number.isInteger(Number(value)) && value !== null && value !== "" ? Number(value) : null; }

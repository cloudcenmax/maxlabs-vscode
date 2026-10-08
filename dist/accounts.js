                                  
             
                                    
               
                                 
                               
 

                                                        
                       
                                                        
                     
                     
                  
 

                                                                                                
                                                                              
                                                                                                                    

export function accountListRejectsCredential(status        )          { return status === 401 || status === 403; }

export function accountFromProfile(payload                         )                  {
  const raw = payload.account;
  if (!raw || typeof raw !== "object") throw new Error("MaxLabs profile did not identify the billing account");
  const account = raw                           ;
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

export function parseStoredState(raw                    )                               {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw)                           ;
    if (value.version !== 2 || typeof value.active_account_id !== "string" || !value.accounts || typeof value.accounts !== "object") return undefined;
    const accounts = value.accounts                                 ;
    if (!accounts[value.active_account_id]) return undefined;
    return { version: 2, active_account_id: value.active_account_id, accounts };
  } catch { return undefined; }
}

export function mergeAccountOptions(remote         , stored                              )                  {
  const body = remote && typeof remote === "object" ? remote                            : {};
  const remoteAccounts = Array.isArray(body.accounts) ? body.accounts : [];
  const result = new Map                       ();
  for (const candidate of remoteAccounts) {
    if (!candidate || typeof candidate !== "object") continue;
    const account = candidate                           ;
    const id = String(account.id || "").trim();
    const type = account.type === "personal" ? "personal" : account.type === "organization" ? "organization" : undefined;
    if (!id || !type) continue;
    result.set(id, {
      id, type, name: String(account.name || (type === "personal" ? "Personal" : "Work")),
      organization_id: integerOrNull(account.organization_id), membership_id: integerOrNull(account.membership_id),
      role: typeof account.role === "string" ? account.role : null,
      tier: typeof account.tier === "string" || (account.tier !== null && typeof account.tier === "object") ? account.tier                          : null,
      available: account.available !== false, connected: Boolean(stored?.accounts[id]), active: stored?.active_account_id === id,
    });
  }
  for (const account of Object.values(stored?.accounts || {})) {
    if (result.has(account.id)) continue;
    result.set(account.id, { ...withoutTokens(account), available: false, connected: true, active: stored?.active_account_id === account.id });
  }
  return [...result.values()].sort((left, right) => Number(right.active) - Number(left.active) || Number(right.type === "personal") - Number(left.type === "personal") || left.name.localeCompare(right.name));
}

function withoutTokens(account               )                  {
  return { id: account.id, type: account.type, name: account.name, organization_id: account.organization_id, membership_id: account.membership_id };
}
function integerOrNull(value         )                { return Number.isInteger(Number(value)) && value !== null && value !== "" ? Number(value) : null; }


//# sourceURL=../src/accounts.ts
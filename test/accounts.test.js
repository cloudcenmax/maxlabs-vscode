import assert from "node:assert/strict";
import test from "node:test";
import { accountFromProfile, accountListRejectsCredential, mergeAccountOptions, parseStoredState } from "../dist/accounts.js";

const tokens = { access_token: "access", refresh_token: "refresh", expires_at: "2099-01-01T00:00:00.000Z" };
const state = {
  version: 2,
  active_account_id: "personal",
  accounts: {
    personal: { id: "personal", type: "personal", name: "Personal", organization_id: null, membership_id: null, tokens },
    "organization:7": { id: "organization:7", type: "organization", name: "Acme", organization_id: 7, membership_id: 12, tokens },
  },
};

test("profile account identity is validated and normalized", () => {
  assert.deepEqual(accountFromProfile({ account: { id: "organization:7", type: "organization", name: "Acme", organization_id: 7, membership_id: 12 } }), {
    id: "organization:7", type: "organization", name: "Acme", organization_id: 7, membership_id: 12,
  });
  assert.throws(() => accountFromProfile({ account: { type: "organization" } }), /invalid billing account/);
});

test("stored account state rejects missing active credentials", () => {
  assert.equal(parseStoredState(JSON.stringify(state))?.active_account_id, "personal");
  assert.equal(parseStoredState(JSON.stringify({ ...state, active_account_id: "missing" })), undefined);
  assert.equal(parseStoredState("not json"), undefined);
});

test("server accounts merge with locally connected contexts without exposing tokens", () => {
  const result = mergeAccountOptions({ accounts: [
    { id: "personal", type: "personal", name: "Personal", available: true },
    { id: "organization:7", type: "organization", name: "Acme", organization_id: 7, membership_id: 12, role: "member", available: true },
    { id: "organization:9", type: "organization", name: "New Co", organization_id: 9, membership_id: 13, available: true },
  ] }, state);
  assert.deepEqual(result.map(({ id, connected, active }) => ({ id, connected, active })), [
    { id: "personal", connected: true, active: true },
    { id: "organization:7", connected: true, active: false },
    { id: "organization:9", connected: false, active: false },
  ]);
  assert.ok(result.every((account) => !("tokens" in account)));
});

test("removed work accounts remain visible as unavailable until disconnected", () => {
  const result = mergeAccountOptions({ accounts: [{ id: "personal", type: "personal", name: "Personal", available: true }] }, state);
  assert.equal(result.find((account) => account.id === "organization:7")?.available, false);
});

test("only authorization failures evict an account during account discovery", () => {
  assert.equal(accountListRejectsCredential(401), true);
  assert.equal(accountListRejectsCredential(403), true);
  for (const status of [0, 400, 408, 429, 500, 502, 503]) assert.equal(accountListRejectsCredential(status), false, `status ${status}`);
});

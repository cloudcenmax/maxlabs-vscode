import { markdown } from "./markdown.js";

const vscode = acquireVsCodeApi();
const messages = document.getElementById("messages");
const input = document.getElementById("input");
const status = document.getElementById("status");
const modelButton = document.getElementById("model");
const modelMenu = document.getElementById("modelMenu");
const modeButton = document.getElementById("mode");
const modeMenu = document.getElementById("modeMenu");
const accountMenuButton = document.getElementById("accountMenuButton");
const accountMenu = document.getElementById("accountMenu");
const authGate = document.getElementById("authGate");
const resetConfirm = document.getElementById("resetConfirm");
const thinkingSlider = document.getElementById("thinking");
const thinkingLabel = document.getElementById("thinkingLabel");
const thinkingLevels = ["minimal", "low", "medium", "high", "default"];
const titleCase = (value) => String(value).replace(/[-_]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
let current = null;
let currentRaw = "";
const toolCards = new Map();
const approvalCards = new Map();
let streamedCharacters = 0;
let pendingDelta = "";
let deltaTimer = null;

const scroll = () => { messages.scrollTop = messages.scrollHeight; };
const clearEmpty = () => document.getElementById("empty")?.remove();
const iconSvg = (name) => {
  const paths = { terminal: '<path d="M5 7l4 5-4 5M11 17h8"/>', tool: '<path d="m14 7 3-3 3 3-3 3M4 17l7-7 3 3-7 7H4v-3Z"/>', chevron: '<path d="m9 5 7 7-7 7"/>' };
  return `<svg class="svg-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
};
function add(className, text) {
  clearEmpty();
  const element = document.createElement("div");
  element.className = `msg ${className}`;
  element.textContent = text;
  messages.append(element);
  scroll();
  return element;
}
function startAssistant() {
  current = add("assistant", "");
  currentRaw = "";
  return current;
}
function addAssistant(text) { const element = add("assistant", ""); element.innerHTML = markdown(text); return element; }
function tokenCount() { const estimate = Math.max(1, Math.round(streamedCharacters / 4)); return estimate >= 1000 ? `${(estimate / 1000).toFixed(1)}k` : String(estimate); }
function updateTokenStatus() { status.textContent = `~${tokenCount()} tokens · streaming`; }
function renderAssistant(cursor = true) {
  if (!current) startAssistant();
  current.innerHTML = markdown(currentRaw);
  if (cursor) { const caret = document.createElement("span"); caret.className = "cursor"; current.append(caret); }
  scroll();
}
function appendDelta(text) {
  if (!current) startAssistant();
  currentRaw += text;
  renderAssistant();
}
function pumpDelta() {
  if (deltaTimer || !pendingDelta) return;
  const chunkSize = pendingDelta.length > 800 ? 40 : pendingDelta.length > 300 ? 20 : pendingDelta.length > 100 ? 10 : Math.min(6, pendingDelta.length);
  const chunk = pendingDelta.slice(0, chunkSize);
  pendingDelta = pendingDelta.slice(chunkSize);
  appendDelta(chunk);
  deltaTimer = setTimeout(() => { deltaTimer = null; pumpDelta(); }, 12);
}
function enqueueDelta(text) {
  pendingDelta += text;
  streamedCharacters += text.length;
  updateTokenStatus();
  pumpDelta();
}
function flushDelta() {
  if (deltaTimer) clearTimeout(deltaTimer);
  deltaTimer = null;
  if (!pendingDelta) return;
  const remainder = pendingDelta;
  pendingDelta = "";
  appendDelta(remainder);
}
function finishAssistant() {
  messages.querySelectorAll(".cursor").forEach((cursor) => cursor.remove());
  if (!current) return;
  if (currentRaw.trim()) renderAssistant(false);
  else current.remove();
  current = null;
  currentRaw = "";
}
function addTool(message, pending = false) {
  clearEmpty();
  flushDelta();
  finishAssistant();
  const existing = message.id ? toolCards.get(message.id) : null;
  const card = existing?.card || document.createElement("details");
  card.className = `msg tool-card${message.error ? " error" : ""}${pending ? " pending" : ""}`;
  card.open = Boolean(message.error);
  const summary = existing?.summary || document.createElement("summary");
  const icon = existing?.icon || document.createElement("span"); icon.className = "tool-icon"; icon.innerHTML = iconSvg(message.name.toLowerCase().includes("bash") ? "terminal" : "tool");
  const name = existing?.name || document.createElement("span"); name.className = "tool-name"; name.textContent = message.name;
  const preview = existing?.preview || document.createElement("span"); preview.className = "tool-preview"; preview.textContent = String(message.detail || "").split("\n")[0];
  const chevron = existing?.chevron || document.createElement("span"); chevron.className = "tool-chevron"; chevron.innerHTML = iconSvg("chevron");
  const detail = existing?.detail || document.createElement("pre"); detail.className = "tool-detail"; detail.textContent = message.detail;
  if (!existing) { summary.append(icon, name, preview, chevron); card.append(summary, detail); messages.append(card); if (message.id) toolCards.set(message.id, { card, summary, icon, name, preview, chevron, detail }); }
  scroll();
}
function addApproval(message) {
  clearEmpty();
  const card = document.createElement("section"); card.className = "approval-card"; card.setAttribute("role", "alertdialog"); card.setAttribute("aria-labelledby", `approval-title-${message.id}`);
  const heading = document.createElement("div"); heading.className = "approval-heading"; heading.id = `approval-title-${message.id}`; heading.innerHTML = iconSvg("terminal");
  const headingText = document.createElement("strong"); headingText.textContent = `Allow ${titleCase(message.tool)}?`; heading.append(headingText);
  const reason = document.createElement("p"); reason.className = "approval-reason"; reason.textContent = message.reason;
  const detail = document.createElement("pre"); detail.className = "approval-detail"; detail.textContent = message.detail;
  const actions = document.createElement("div"); actions.className = "approval-actions";
  const respond = (answer) => { vscode.postMessage({ type: "approvalResponse", id: message.id, answer }); for (const button of actions.querySelectorAll("button")) button.disabled = true; card.classList.add("resolved"); };
  const deny = document.createElement("button"); deny.type = "button"; deny.className = "approval-deny"; deny.textContent = "Deny"; deny.addEventListener("click", () => respond("deny")); actions.append(deny);
  if (message.allowAlways) { const always = document.createElement("button"); always.type = "button"; always.className = "approval-secondary"; always.textContent = "Always allow"; always.addEventListener("click", () => respond("always")); actions.append(always); }
  const allow = document.createElement("button"); allow.type = "button"; allow.className = "approval-primary"; allow.textContent = "Allow once"; allow.addEventListener("click", () => respond("once")); actions.append(allow);
  card.append(heading, reason, detail, actions); messages.append(card); approvalCards.set(message.id, card); scroll(); allow.focus();
}
function send() {
  const text = input.value.trim();
  if (!text) return;
  vscode.postMessage({ type: "send", text });
  input.value = "";
  resizeInput();
}
function resizeInput() { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 210)}px`; }

document.getElementById("send").addEventListener("click", send);
input.addEventListener("input", resizeInput);
input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } });
accountMenuButton.addEventListener("click", (event) => { event.stopPropagation(); const opening = accountMenu.hidden; accountMenu.hidden = !opening; accountMenuButton.setAttribute("aria-expanded", String(opening)); if (opening) vscode.postMessage({ type: "loadAccounts" }); });
accountMenu.addEventListener("click", (event) => event.stopPropagation());
document.getElementById("accountOAuth").addEventListener("click", (event) => { const signedIn = event.currentTarget.dataset.signedIn === "true"; accountMenu.hidden = true; accountMenuButton.setAttribute("aria-expanded", "false"); status.textContent = signedIn ? "Signing out…" : "Starting sign in…"; vscode.postMessage({ type: signedIn ? "logout" : "login" }); });
document.getElementById("addAccount").addEventListener("click", () => { accountMenu.hidden = true; accountMenuButton.setAttribute("aria-expanded", "false"); status.textContent = "Choose an account in your browser…"; vscode.postMessage({ type: "addAccount" }); });
document.getElementById("logoutAll").addEventListener("click", () => { accountMenu.hidden = true; accountMenuButton.setAttribute("aria-expanded", "false"); vscode.postMessage({ type: "logoutAll" }); });
document.getElementById("accountApi").addEventListener("click", () => { accountMenu.hidden = true; accountMenuButton.setAttribute("aria-expanded", "false"); vscode.postMessage({ type: "apiKey" }); });
document.getElementById("removeApi").addEventListener("click", () => { accountMenu.hidden = true; accountMenuButton.setAttribute("aria-expanded", "false"); vscode.postMessage({ type: "removeApiKey" }); });
document.getElementById("gateOAuth").addEventListener("click", () => vscode.postMessage({ type: "login" }));
document.getElementById("gateApi").addEventListener("click", () => vscode.postMessage({ type: "apiKey" }));
document.getElementById("newChat").addEventListener("click", (event) => { event.stopPropagation(); resetConfirm.hidden = false; });
resetConfirm.addEventListener("click", (event) => event.stopPropagation());
document.getElementById("cancelReset").addEventListener("click", () => { resetConfirm.hidden = true; });
document.getElementById("confirmReset").addEventListener("click", () => { resetConfirm.hidden = true; vscode.postMessage({ type: "newChat" }); });
document.getElementById("newTab").addEventListener("click", () => vscode.postMessage({ type: "newTab" }));
modelButton.addEventListener("click", (event) => { event.stopPropagation(); const opening = modelMenu.hidden; modelMenu.hidden = !opening; modelButton.setAttribute("aria-expanded", String(opening)); if (opening) vscode.postMessage({ type: "loadModels" }); });
modelMenu.addEventListener("click", (event) => event.stopPropagation());
modeButton.addEventListener("click", (event) => { event.stopPropagation(); const opening = modeMenu.hidden; modeMenu.hidden = !opening; modeButton.setAttribute("aria-expanded", String(opening)); });
modeMenu.addEventListener("click", (event) => event.stopPropagation());
for (const option of modeMenu.querySelectorAll("[data-mode]")) option.addEventListener("click", () => { vscode.postMessage({ type: "chooseMode", mode: option.dataset.mode }); modeMenu.hidden = true; modeButton.setAttribute("aria-expanded", "false"); });
document.addEventListener("click", () => { accountMenu.hidden = true; modelMenu.hidden = true; modeMenu.hidden = true; resetConfirm.hidden = true; accountMenuButton.setAttribute("aria-expanded", "false"); modelButton.setAttribute("aria-expanded", "false"); modeButton.setAttribute("aria-expanded", "false"); });
thinkingSlider.addEventListener("input", () => { const level = thinkingLevels[Number(thinkingSlider.value)]; thinkingLabel.textContent = titleCase(level); thinkingSlider.setAttribute("aria-valuetext", level); });
thinkingSlider.addEventListener("change", () => vscode.postMessage({ type: "chooseThinking", thinking: thinkingLevels[Number(thinkingSlider.value)] }));
document.getElementById("web").addEventListener("click", () => vscode.postMessage({ type: "web" }));

function resetMessages() { flushDelta(); messages.innerHTML = '<div class="empty" id="empty"><img src="' + document.body.dataset.icon + '"><strong>New conversation</strong>Ask MaxLabs to inspect, explain, plan, or change this workspace.</div>'; current = null; currentRaw = ""; streamedCharacters = 0; toolCards.clear(); approvalCards.clear(); }

function renderAccounts(accounts) {
  const options = document.getElementById("accountOptions"); options.innerHTML = "";
  if (!accounts.length) { const empty = document.createElement("div"); empty.className = "dropup-loading"; empty.textContent = "No OAuth accounts connected."; options.append(empty); return; }
  for (const account of accounts) {
    const button = document.createElement("button"); button.type = "button"; button.className = `account-option account-context${account.active ? " selected" : ""}`; button.disabled = account.active;
    const mark = document.createElement("span"); mark.className = "account-mark"; mark.textContent = account.active ? "✓" : account.type === "personal" ? "P" : "W";
    const copy = document.createElement("span"); const name = document.createElement("strong"); name.textContent = account.name; const detail = document.createElement("small");
    detail.textContent = account.active ? `${account.type === "personal" ? "Personal" : "Work"} · Current` : !account.available ? "Access unavailable · Reconnect" : account.connected ? `${account.type === "personal" ? "Personal" : "Work"} · Switch` : `${account.type === "personal" ? "Personal" : "Work"} · Connect`;
    copy.append(name, detail); button.append(mark, copy);
    button.addEventListener("click", () => { accountMenu.hidden = true; accountMenuButton.setAttribute("aria-expanded", "false"); status.textContent = account.connected ? `Switching to ${account.name}…` : "Choose the account in your browser…"; vscode.postMessage({ type: account.connected ? "switchAccount" : "addAccount", accountId: account.id }); });
    options.append(button);
  }
}

window.addEventListener("message", ({ data: message }) => {
  if (message.type === "reset") resetMessages();
  else if (message.type === "restore") { resetMessages(); for (const entry of message.entries || []) { if (entry.type === "user") add(`user${entry.steering ? " steering" : ""}`, entry.text); else if (entry.type === "assistant") addAssistant(entry.text); else addTool(entry, entry.type === "toolStart"); } }
  else if (message.type === "user") add(`user${message.steering ? " steering" : ""}`, message.steering ? `↳ Steering\n${message.text}` : message.text);
  else if (message.type === "begin") { flushDelta(); streamedCharacters = 0; finishAssistant(); }
  else if (message.type === "delta") enqueueDelta(message.text);
  else if (message.type === "tokenProgress") { streamedCharacters += Number(message.characters || 0); updateTokenStatus(); }
  else if (message.type === "finish") { flushDelta(); finishAssistant(); status.textContent = message.meta; }
  else if (message.type === "toolStart") addTool(message, true);
  else if (message.type === "tool") addTool(message);
  else if (message.type === "approval") addApproval(message);
  else if (message.type === "approvalResolved") { approvalCards.get(message.id)?.remove(); approvalCards.delete(message.id); }
  else if (message.type === "status") status.textContent = message.text;
  else if (message.type === "models") { const options = document.getElementById("modelOptions"); options.innerHTML = ""; for (const model of message.models || []) { const button = document.createElement("button"); button.type = "button"; button.className = `menu-option${model.id === message.selected ? " selected" : ""}`; button.setAttribute("role", "menuitemradio"); button.setAttribute("aria-checked", String(model.id === message.selected)); const name = document.createElement("strong"); name.textContent = titleCase(model.id); button.append(name); const description = document.createElement("span"); description.textContent = model.description || "Available through the MaxLabs gateway."; button.append(description); button.addEventListener("click", () => { vscode.postMessage({ type: "chooseModel", model: model.id }); modelMenu.hidden = true; modelButton.setAttribute("aria-expanded", "false"); }); options.append(button); } }
  else if (message.type === "accountLoading") document.getElementById("accountOptions").innerHTML = '<div class="dropup-loading">Loading accounts…</div>';
  else if (message.type === "accounts") renderAccounts(message.accounts || []);
  else if (message.type === "error") { addTool({ name: "Error", detail: message.text, error: true }); status.textContent = "Stopped with an error"; }
  else if (message.type === "state") { document.querySelector("#model span").textContent = titleCase(message.state.model); const thinkingIndex = Math.max(0, thinkingLevels.indexOf(message.state.thinking)); thinkingSlider.value = String(thinkingIndex); thinkingSlider.setAttribute("aria-valuetext", message.state.thinking); thinkingLabel.textContent = titleCase(thinkingLevels[thinkingIndex]); document.querySelector("#mode span").textContent = titleCase(message.state.mode); modeMenu.querySelectorAll("[data-mode]").forEach((option) => { const selected = option.dataset.mode === message.state.mode; option.classList.toggle("selected", selected); option.setAttribute("aria-checked", String(selected)); }); document.querySelector("#web span").textContent = titleCase(message.state.webSearch); const hasCredentials = message.state.authenticated || message.state.hasApiKey; authGate.dataset.ready = String(message.state.credentialsReady); authGate.hidden = Boolean(message.state.credentialsReady && hasCredentials); const send = document.getElementById("send"); send.title = message.state.running ? "Steer current run" : "Send message"; send.setAttribute("aria-label", send.title); const accountOAuth = document.getElementById("accountOAuth"); accountOAuth.dataset.signedIn = String(message.state.authenticated); accountOAuth.querySelector("strong").textContent = message.state.authenticated ? "Disconnect current account" : "Sign in with OAuth"; accountOAuth.querySelector("small").textContent = message.state.authenticated ? "Other connected accounts stay available" : "Recommended for subscriptions"; document.querySelector("#accountApi strong").textContent = message.state.hasApiKey ? "Replace API key" : "Configure API key"; document.getElementById("removeApi").hidden = !message.state.hasApiKey; document.getElementById("logoutAll").hidden = !message.state.authenticated; document.getElementById("accountStatus").textContent = message.state.account?.name || (message.state.hasApiKey ? "API key connected" : "Not connected"); document.getElementById("accountKind").textContent = message.state.account ? message.state.account.type === "personal" ? "Personal account" : "Work account" : "Authentication"; document.getElementById("accountButtonLabel").textContent = message.state.account?.name || (message.state.hasApiKey ? "API key" : "Account"); }
});
resizeInput();
vscode.setState({ chatKey: document.body.dataset.chatKey });
vscode.postMessage({ type: "ready" });

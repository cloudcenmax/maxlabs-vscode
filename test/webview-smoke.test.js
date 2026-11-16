import assert from "node:assert/strict";
import test from "node:test";

class ClassList {
  constructor() { this.values = new Set(); }
  add(...names) { for (const name of names) this.values.add(name); }
  remove(...names) { for (const name of names) this.values.delete(name); }
  toggle(name, force) { const on = force === undefined ? !this.values.has(name) : Boolean(force); if (on) this.values.add(name); else this.values.delete(name); return on; }
  contains(name) { return this.values.has(name); }
}

class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.classList = new ClassList();
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this._text = "";
    this._html = "";
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.value = "";
    this.scrollHeight = 0;
    this.scrollTop = 0;
    this.listeners = {};
    this.removed = false;
    this._queries = {};
  }
  get className() { return [...this.classList.values].join(" "); }
  set className(value) { this.classList.values = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get textContent() { return this._text; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get innerHTML() { return this._html; }
  set innerHTML(value) { this._html = String(value); this.children = []; }
  append(...nodes) { for (const node of nodes) { if (node === null || node === undefined) continue; if (typeof node === "string") { this._text += node; continue; } this.children.push(node); } }
  appendChild(node) { this.append(node); }
  prepend(node) { this.children.unshift(node); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  removeEventListener() {}
  dispatch(type, event = {}) { for (const handler of this.listeners[type] || []) handler({ ...event, currentTarget: this, target: this, stopPropagation() {}, preventDefault() {} }); }
  querySelector(selector) { return this._queries[selector] ||= new Element("span"); }
  querySelectorAll(selector) { return this._queries[selector] || []; }
  getContext() { return { drawImage() {} }; }
  toBlob(callback) { callback(new Blob([Uint8Array.from([1, 2, 3])], { type: "image/jpeg" })); }
  remove() { this.removed = true; }
  focus() {}
}

const elements = new Map();
const windowListeners = {};
const posted = [];

const messages = new Element("main");
const stop = new Element("button");
const status = new Element("div");
const modeMenu = new Element("div");
modeMenu._queries["[data-mode]"] = ["act", "plan", "auto"].map((mode) => Object.assign(new Element("button"), { dataset: { mode } }));
elements.set("messages", messages);
elements.set("stop", stop);
elements.set("status", status);
elements.set("modeMenu", modeMenu);

const document = {
  body: Object.assign(new Element("body"), { dataset: { icon: "icon.png", chatKey: "maxlabs.sidebarChat.v1" } }),
  createElement: (tag) => new Element(tag),
  getElementById: (id) => { if (!elements.has(id)) elements.set(id, new Element("div")); return elements.get(id); },
  querySelector: (selector) => { const key = `query:${selector}`; if (!elements.has(key)) elements.set(key, new Element("span")); return elements.get(key); },
  querySelectorAll: () => [],
  addEventListener: () => {},
};

const window = { addEventListener: (type, handler) => { windowListeners[type] = handler; } };
globalThis.acquireVsCodeApi = () => ({ postMessage: (message) => posted.push(message), setState: () => {} });
globalThis.createImageBitmap = async () => ({ width: 800, height: 600, close() {} });
globalThis.document = document;
globalThis.window = window;

await import("../media/main.js");

const state = (running) => ({
  model: "worker", thinking: "low", mode: "act", webSearch: "auto", running,
  authenticated: true, hasApiKey: false, credentialsReady: true, chatKey: "maxlabs.sidebarChat.v1",
  account: { id: "personal", type: "personal", name: "Personal", organization_id: null, membership_id: null },
});
const dispatch = (message) => windowListeners.message({ data: message });

test("stop button appears only while a turn runs and posts a stop request", () => {
  assert.ok(posted.some((message) => message.type === "ready"));

  dispatch({ type: "state", state: state(true) });
  assert.equal(stop.hidden, false);
  assert.equal(stop.disabled, false);
  stop.dispatch("click");
  assert.ok(posted.some((message) => message.type === "stop"));
  assert.equal(stop.disabled, true);
  dispatch({ type: "state", state: state(true) });
  assert.equal(stop.disabled, true, "a state sync must not re-enable Stop while stopping");

  dispatch({ type: "state", state: state(false) });
  assert.equal(stop.hidden, true);

  dispatch({ type: "state", state: state(true) });
  dispatch({ type: "begin" });
  assert.equal(stop.hidden, false);
  dispatch({ type: "finish", meta: "1 model call · 5 generated" });
  assert.equal(stop.hidden, true);
});

test("thinking streams a token count without rendering the reasoning text", () => {
  dispatch({ type: "reset" });
  dispatch({ type: "begin" });
  dispatch({ type: "thinking", text: "a".repeat(2000) });

  const card = messages.children.find((child) => child.classList.contains("thinking-card"));
  assert.ok(card, "thinking card should be rendered");
  const [spinner, label, count] = card.children[0].children;
  assert.equal(label.textContent, "Thinking");
  assert.equal(count.textContent, "~500 tokens");
  assert.equal(spinner.className, "thinking-spinner");
  assert.equal(status.textContent, "Thinking · ~500 tokens");
  // The reasoning itself is internal. Only the live count is customer-visible.
  assert.equal(card.children.length, 1, "the card must hold no reasoning body");
  assert.equal(card.children[0].className, "thinking-summary");
  assert.ok(!JSON.stringify(card._text).includes("aaaa"), "reasoning text must not be shown");

  dispatch({ type: "delta", text: "Hello" });
  assert.equal(label.textContent, "Thought");
  assert.equal(count.textContent, "~500 tokens");

  dispatch({ type: "finish", meta: "done" });
  dispatch({ type: "reset" });
  dispatch({ type: "begin" });
  dispatch({ type: "thinking", text: "b".repeat(400) });
  const fresh = messages.children.find((child) => child.classList.contains("thinking-card"));
  assert.equal(fresh.children[0].children[2].textContent, "~100 tokens");
});

test("thinking and assistant text survive an aborted run without a stuck stop button", () => {
  dispatch({ type: "reset" });
  dispatch({ type: "state", state: state(true) });
  dispatch({ type: "begin" });
  dispatch({ type: "thinking", text: "reasoning while planning" });
  dispatch({ type: "status", text: "Thinking · step 1" });
  dispatch({ type: "delta", text: "Partial answer" });
  dispatch({ type: "finish", meta: "Stopped" });
  dispatch({ type: "state", state: state(false) });
  assert.equal(stop.hidden, true);
  assert.equal(status.textContent, "Stopped");
  const card = messages.children.find((child) => child.classList.contains("thinking-card"));
  assert.equal(card.children[0].children[1].textContent, "Thought");
});

test("each reasoning block gets its own token estimate and tool status replaces thinking", () => {
  dispatch({ type: "reset" });
  dispatch({ type: "state", state: state(true) });
  dispatch({ type: "begin" });
  dispatch({ type: "thinking", text: "a".repeat(800) });
  dispatch({ type: "delta", text: "answer" });
  dispatch({ type: "toolStart", id: "tool-1", name: "Using bash", detail: "npm test" });
  assert.match(status.textContent, /Using bash/);

  dispatch({ type: "thinking", text: "b".repeat(400) });
  const cards = messages.children.filter((child) => child.classList.contains("thinking-card"));
  assert.equal(cards.length, 2);
  assert.equal(cards[0].children[0].children[2].textContent, "~200 tokens");
  assert.equal(cards[1].children[0].children[2].textContent, "~100 tokens");
});

test("pasting an image attaches a preview and sends it with the message", async () => {
  dispatch({ type: "reset" });
  const input = document.getElementById("input");
  const attachments = document.getElementById("attachments");
  input.value = "What is this?";
  input.dispatch("paste", {
    clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => ({ type: "image/png", size: 1024 }) }] },
  });
  for (let attempt = 0; attempt < 50 && attachments.children.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(attachments.children.length, 1);
  assert.match(attachments.children[0].children[0].src, /^data:image\/jpeg;base64,/);
  assert.equal(attachments.children[0].children[1].textContent, "×");

  document.getElementById("send").dispatch("click");
  const sent = posted.filter((message) => message.type === "send").at(-1);
  assert.equal(sent.text, "What is this?");
  assert.equal(sent.images.length, 1);
  assert.equal(sent.images[0].mimeType, "image/jpeg");
  assert.equal(attachments.children.length, 0);
  assert.equal(input.value, "");
});

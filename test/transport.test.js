import assert from "node:assert/strict";
import test from "node:test";
import { GatewayTransport, outbound, parseEventStream } from "../dist/transport.js";

test("stream exposes reasoning and assistant text independently", async () => {
  const frames = [
    { choices: [{ delta: { reasoning_content: "Inspecting workspace…" } }] },
    { choices: [{ delta: { content: [{ type: "text", text: "Finished" }] } }] },
    { choices: [{ delta: { content: "." }, finish_reason: "stop" }], usage: { prompt_tokens: 12, prompt_tokens_details: { cached_tokens: 8 }, completion_tokens: 3 } },
  ];
  const body = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
  const text = [];
  const reasoning = [];
  const result = await parseEventStream(new Response(body), (chunk) => text.push(chunk), (chunk) => reasoning.push(chunk));

  assert.deepEqual(reasoning, ["Inspecting workspace…"]);
  assert.deepEqual(text, ["Finished", "."]);
  assert.equal(result.message.content[0].text, "Finished.");
  assert.deepEqual(result.usage, { prompt: 12, cached: 8, cacheWrite: 0, output: 3, reasoning: 0, searches: 0 });
});

test("stream understands provider cache read and write counters", async () => {
  const frame = { choices: [{ delta: { content: "ok" } }], usage: { input_tokens: 120, cache_read_input_tokens: 90, cache_creation_input_tokens: 20, output_tokens: 1 } };
  const result = await parseEventStream(new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`), () => {});
  assert.equal(result.usage.cached, 90);
  assert.equal(result.usage.cacheWrite, 20);
});

test("extending a transcript preserves every earlier provider-facing message", () => {
  const original = [
    { role: "system", content: [{ type: "text", text: "stable" }] },
    { role: "user", content: [{ type: "text", text: "inspect" }] },
    { role: "assistant", content: [{ type: "tool_call", callId: "1", name: "read", arguments: '{"path":"README.md"}' }] },
    { role: "tool", content: [{ type: "tool_result", callId: "1", text: "contents" }] },
  ];
  const extended = [...original, { role: "assistant", content: [{ type: "text", text: "done" }] }];
  assert.deepEqual(extended.slice(0, original.length).map(outbound), original.map(outbound));
});

test("stream exposes Responses-style output text deltas", async () => {
  const body = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Visible message" })}\n\ndata: [DONE]\n\n`;
  const text = [];
  const result = await parseEventStream(new Response(body), (chunk) => text.push(chunk));
  assert.deepEqual(text, ["Visible message"]);
  assert.equal(result.message.content[0].text, "Visible message");
});

test("stream preserves multiline SSE data and a final unterminated event", async () => {
  const encoded = JSON.stringify({ choices: [{ delta: { content: "| Item | Status |\n" } }] });
  const split = encoded.indexOf('"choices"');
  const multiline = `${encoded.slice(0, split)}\ndata: ${encoded.slice(split)}`;
  const tail = JSON.stringify({ choices: [{ delta: { content: "| --- | --- |\n| Tables | Visible |" } }] });
  const body = `data: ${multiline}\n\ndata: ${tail}`;
  const result = await parseEventStream(new Response(body), () => {});
  assert.equal(result.message.content[0].text, "| Item | Status |\n| --- | --- |\n| Tables | Visible |");
});

const tokenAuth = { accessToken: async () => "token", apiKey: async () => undefined, invalidateActive: async () => {} };
const keyAuth = { accessToken: async () => undefined, apiKey: async () => "key", invalidateActive: async () => {} };
const makeTransport = (auth, diagnostic = () => {}) => new GatewayTransport(auth, () => "https://console.ai.cenmax.in", () => "https://api.ai.cenmax.in/v1", "session-1", diagnostic);
async function withFetch(response, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response;
  try { await run(); } finally { globalThis.fetch = original; }
}

test("server failures expose a neutral Cenmax AI message and a public request id", async () => {
  const diagnostics = [];
  const transport = makeTransport(keyAuth, (entry) => diagnostics.push(entry));
  await withFetch(new Response(JSON.stringify({ error: { message: "provider qwen: upstream exploded" } }), { status: 502, headers: { "content-type": "application/json", "x-request-id": "req_abc-123" } }), async () => {
    await assert.rejects(transport.models(), (error) => {
      assert.match(error.message, /Cenmax AI request failed \(HTTP 502\)/);
      assert.match(error.message, /temporarily unavailable/);
      assert.match(error.message, /Request ID: req_abc-123/);
      assert.doesNotMatch(error.message, /qwen|upstream|provider/i);
      return true;
    });
  });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].status, 502);
  assert.match(diagnostics[0].detail, /qwen/);
  assert.equal(diagnostics[0].requestId, "req_abc-123");
});

test("rate limits and unreadable payloads use neutral customer messages", async () => {
  const transport = makeTransport(keyAuth);
  await withFetch(new Response(JSON.stringify({ error: "upstream quota exhausted" }), { status: 429 }), async () => {
    await assert.rejects(transport.models(), (error) => {
      assert.match(error.message, /usage limit/);
      assert.doesNotMatch(error.message, /upstream|quota exhausted/i);
      return true;
    });
  });
  await withFetch(new Response("not json", { status: 200, headers: { "content-type": "application/json" } }), async () => {
    await assert.rejects(transport.models(), /unreadable response/);
  });
});

test("unauthorized credentials never echo the backend error body", async () => {
  const apiTransport = makeTransport(keyAuth);
  await withFetch(new Response(JSON.stringify({ detail: "upstream provider rejected" }), { status: 401, headers: { "content-type": "application/json" } }), async () => {
    await assert.rejects(apiTransport.models(), (error) => {
      assert.match(error.message, /API key is not authorized/);
      assert.doesNotMatch(error.message, /upstream|provider/i);
      return true;
    });
  });
  const oauthTransport = makeTransport(tokenAuth);
  await withFetch(new Response(JSON.stringify({ detail: "upstream provider rejected" }), { status: 401, headers: { "content-type": "application/json" } }), async () => {
    await assert.rejects(oauthTransport.models(), (error) => {
      assert.match(error.message, /no longer authorized/);
      assert.doesNotMatch(error.message, /upstream|provider/i);
      return true;
    });
  });
});


test("default local diagnostics never print raw service errors", async () => {
  const messages = [];
  const original = console.error;
  console.error = (...args) => messages.push(args.join(" "));
  try {
    const transport = new GatewayTransport(keyAuth, () => "https://console.ai.cenmax.in", () => "https://api.ai.cenmax.in/v1", "session-1");
    await withFetch(new Response(JSON.stringify({ error: "private-route: upstream provider rejected" }), { status: 502, headers: { "x-request-id": "req_public123" } }), async () => {
      await assert.rejects(transport.models(), /Cenmax AI request failed/);
    });
  } finally { console.error = original; }
  assert.equal(messages.length, 1);
  assert.match(messages[0], /HTTP 502/);
  assert.match(messages[0], /req_public123/);
  assert.doesNotMatch(messages[0], /private-route|upstream|provider|rejected/);
});

test("user messages carry pasted images as OpenAI-style content parts", () => {
  const message = outbound({ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image", mimeType: "image/png", data: "AQID" }] });
  assert.equal(message.role, "user");
  assert.deepEqual(message.content, [
    { type: "text", text: "what is this" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
  ]);
});

test("workspace requests are OAuth-only and send an idempotency key", async () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const transport = makeTransport(tokenAuth);
    const result = await transport.workspace("/tools/mcp_x", { method: "POST", body: { arguments: { query: "x" } }, idempotencyKey: "key-1" });
    assert.deepEqual(result, { data: { ok: true } });
    assert.equal(seen[0].url, "https://console.ai.cenmax.in/app/v1/workspace/tools/mcp_x");
    assert.equal(seen[0].init.method, "POST");
    assert.equal(seen[0].init.headers.authorization, "Bearer token");
    assert.equal(seen[0].init.headers["Idempotency-Key"], "key-1");
    assert.deepEqual(JSON.parse(seen[0].init.body), { arguments: { query: "x" } });
  } finally {
    globalThis.fetch = original;
  }

  const apiKeyOnly = makeTransport({ accessToken: async () => undefined, apiKey: async () => "key", invalidateActive: async () => {} });
  await assert.rejects(apiKeyOnly.workspace("/connections"), /Sign in with OAuth/);

  const diagnostics = [];
  const scoped = makeTransport(tokenAuth, (entry) => diagnostics.push(entry));
  await withFetch(new Response("scope missing", { status: 403 }), async () => {
    await assert.rejects(scoped.workspace("/connections"), /has not granted access/);
  });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].status, 403);
});

test("auto-mode command review posts isolated state and applies the confidence gate", async () => {
  const seen = [];
  const original = globalThis.fetch;
  const respond = (decision, confidence = 0.9) => new Response(JSON.stringify({ decision, confidence, risk: "medium", authorized: true }), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (url, init) => { seen.push({ url: String(url), init }); return respond("allow"); };
  try {
    const transport = makeTransport(tokenAuth);
    assert.equal(await transport.auditCommand({ command: "rm -rf build", userMessages: ["clean build output"], workspace: process.cwd(), model: "worker" }), "allow");
    assert.equal(seen[0].url, "https://console.ai.cenmax.in/app/v1/audit/command");
    const body = JSON.parse(seen[0].init.body);
    assert.equal(body.model, "worker");
    assert.equal(body.state.command, "rm -rf build");
    assert.deepEqual(body.state.user_messages, ["clean build output"]);
  } finally { globalThis.fetch = original; }

  globalThis.fetch = async () => respond("allow", 0.4);
  try {
    const transport = makeTransport(tokenAuth);
    assert.equal(await transport.auditCommand({ command: "rm -rf build", userMessages: ["clean"], workspace: process.cwd(), model: "worker" }), "ask");
  } finally { globalThis.fetch = original; }

  globalThis.fetch = async () => respond("stop");
  try {
    const transport = makeTransport(tokenAuth);
    assert.equal(await transport.auditCommand({ command: "rm -rf build", userMessages: ["clean"], workspace: process.cwd(), model: "worker" }), "stop");
  } finally { globalThis.fetch = original; }

  const apiKeyOnly = makeTransport({ accessToken: async () => undefined, apiKey: async () => "key", invalidateActive: async () => {} });
  assert.equal(await apiKeyOnly.auditCommand({ command: "rm -rf build", userMessages: ["clean"], workspace: process.cwd(), model: "worker" }), undefined);

  globalThis.fetch = async () => new Response("nope", { status: 503 });
  try {
    const transport = makeTransport(tokenAuth);
    assert.equal(await transport.auditCommand({ command: "rm -rf build", userMessages: ["clean"], workspace: process.cwd(), model: "worker" }), undefined);
  } finally { globalThis.fetch = original; }
});


test("command review never authorizes a truncated command", async () => {
  const original = globalThis.fetch;
  let requested = false;
  globalThis.fetch = async () => { requested = true; throw new Error("must not request"); };
  try {
    const transport = makeTransport(tokenAuth);
    assert.equal(await transport.auditCommand({ command: "echo " + "a".repeat(8_001) + "; rm -rf build", userMessages: ["check build"], workspace: process.cwd(), model: "worker" }), undefined);
    assert.equal(requested, false);
  } finally { globalThis.fetch = original; }
});

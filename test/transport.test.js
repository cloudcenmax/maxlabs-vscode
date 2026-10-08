import assert from "node:assert/strict";
import test from "node:test";
import { outbound, parseEventStream } from "../dist/transport.js";

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

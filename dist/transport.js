                                           
                                                                                  
import { emptyUsage } from "./protocol.js";

                                                                                                                                                       
                                                              

export class GatewayTransport {
           auth           ;
           origin              ;
           apiBase              ;
           sessionId        ;
  constructor(auth           , origin              , apiBase              , sessionId        ) { this.auth = auth; this.origin = origin; this.apiBase = apiBase; this.sessionId = sessionId; }

  async models(signal              )                       {
    const response = await this.request("/models", { method: "GET", signal });
    const payload = await response.json()                          ;
    const models = (payload.data || []).filter((model) => model.id?.trim());
    if (!models.length) throw new Error("Gateway returned no enabled models");
    return models;
  }

  async complete(options                , onDelta                        , onReasoning                        , signal              )                      {
    const response = await this.request("/chat/completions", {
      method: "POST", signal, headers: { accept: "text/event-stream" },
      body: JSON.stringify({
        model: options.model, messages: options.messages.map(outbound),
        tools: options.tools.map((schema) => ({ type: "function", function: schema })), max_tokens: 8192,
        reasoning: options.thinking === "default" ? undefined : { effort: options.thinking },
        web_search: options.webSearch === "off" ? undefined : options.webSearch,
        web_search_uses: options.webSearchUses || undefined, stream: true, stream_options: { include_usage: true },
      }),
    });
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("text/event-stream")) return buffered(await response.json()                           , onDelta, onReasoning);
    return parseEventStream(response, onDelta, onReasoning);
  }

          async request(path        , init             )                    {
    const token = await this.auth.accessToken(this.origin(), init.signal || undefined);
    const fallback = token ? undefined : await this.auth.apiKey();
    const base = token ? `${this.origin().replace(/\/$/, "")}/app/v1` : this.apiBase().replace(/\/$/, "");
    if (!token && !fallback) throw new Error("Sign in with OAuth or configure an API key fallback");
    const response = await fetch(`${base}/${path.replace(/^\//, "")}`, {
      ...init, headers: { "content-type": "application/json", authorization: `Bearer ${token || fallback}`, "x-session-id": this.sessionId, ...init.headers },
    });
    if (!response.ok) {
      if (token && (response.status === 401 || response.status === 403)) {
        await this.auth.invalidateActive();
        throw new Error("This account is no longer authorized or its work membership is inactive. Switch to another account or reconnect it.");
      }
      throw new Error(`Gateway returned ${response.status}: ${(await response.text()).slice(0, 4096)}`);
    }
    return response;
  }
}

export function outbound(message         )                          {
  const calls = message.content.filter((block) => block.type === "tool_call");
  const result = message.content.find((block) => block.type === "tool_result");
  const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  if (result && result.type === "tool_result" && !calls.length) return { role: "tool", tool_call_id: result.callId, content: result.text };
  if (calls.length) return { role: message.role, content: text || null, tool_calls: calls.map((call) => call.type === "tool_call" && ({ id: call.callId, type: "function", function: { name: call.name, arguments: call.arguments } })) };
  return { role: message.role, content: text };
}

export async function parseEventStream(response          , onDelta                        , onReasoning                         = () => {})                      {
  if (!response.body) throw new Error("Gateway stream had no body");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "", text = "", usage = emptyUsage();
  const calls = new Map                                                         ();
  const consume = (frame        )       => {
    const raw = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n").trim();
    if (!raw || raw === "[DONE]") return;
    let chunk                         ;
    try { chunk = JSON.parse(raw)                           ; } catch { return; }
      if (chunk.usage) usage = parseUsage(chunk.usage                           );
      if (String(chunk.type || "").includes("output_text") || String(chunk.type || "").includes("content_block_delta")) {
        const eventText = contentText(chunk.delta) || contentText(chunk.text) || contentText((chunk.content_block                            || {}).text);
        if (eventText) { text += eventText; onDelta(eventText); }
      }
      for (const choice of chunk.choices                                   || []) {
        const delta = choice.delta                            || {};
        const reasoning = [delta.reasoning, delta.reasoning_content, delta.analysis].find((value) => typeof value === "string")                      ;
        if (reasoning) onReasoning(reasoning);
        const message = choice.message                            || {};
        const content = contentText(delta.content) || contentText(delta.text) || contentText(message.content) || contentText(choice.text);
        if (content) { text += content; onDelta(content); }
        for (const fragment of delta.tool_calls                                   || []) {
          const index = Number(fragment.index || 0), current = calls.get(index) || { id: "", name: "", arguments: "" };
          const fn = fragment.function                            || {};
          current.id ||= String(fragment.id || ""); current.name ||= String(fn.name || ""); current.arguments += String(fn.arguments || ""); calls.set(index, current);
        }
      }
  };
  while (true) {
    const { value, done } = await reader.read(); buffer += value || "";
    const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() || "";
    for (const frame of frames) {
      consume(frame);
    }
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  const blocks          = text ? [{ type: "text", text }] : [];
  for (const call of [...calls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)) {
    const args = call.arguments.trim() || "{}"; JSON.parse(args); if (call.name) blocks.push({ type: "tool_call", callId: call.id, name: call.name, arguments: args });
  }
  if (!blocks.length) throw new Error("Gateway stream contained no message or tool call");
  return { message: { role: "assistant", content: blocks }, usage };
}

function buffered(payload                         , onDelta                        , onReasoning                        )             {
  const raw = ((payload.choices                                   || [])[0]?.message || {})                           ;
  const blocks          = []; const content = contentText(raw.content);
  const reasoning = [raw.reasoning, raw.reasoning_content, raw.analysis].find((value) => typeof value === "string")                      ;
  if (reasoning) onReasoning(reasoning);
  if (content) { blocks.push({ type: "text", text: content }); onDelta(content); }
  for (const call of raw.tool_calls                                   || []) { const fn = call.function                            || {}; blocks.push({ type: "tool_call", callId: String(call.id || ""), name: String(fn.name || ""), arguments: String(fn.arguments || "{}") }); }
  return { message: { role: "assistant", content: blocks }, usage: parseUsage(payload.usage                            || {}) };
}

function parseUsage(raw                         )        {
  const prompt = Number(raw.prompt_tokens || raw.input_tokens || 0), details = raw.prompt_tokens_details                            || {};
  return { prompt, cached: numberAt(raw, "prompt_cache_hit_tokens", "cache_read_input_tokens") || numberAt(details, "cached_tokens"), cacheWrite: numberAt(raw, "cache_write_tokens", "cache_creation_input_tokens") || numberAt(details, "cache_write_tokens"), output: Number(raw.completion_tokens || raw.output_tokens || 0), reasoning: Number((raw.completion_tokens_details                            || {}).reasoning_tokens || raw.reasoning_tokens || 0), searches: Number(raw.web_search_requests || 0) };
}

function numberAt(object                         , ...keys          )         { for (const key of keys) { const value = Number(object[key]); if (Number.isFinite(value) && value >= 0) return value; } return 0; }

function contentText(value         )         {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const item = part                           ;
    return contentText(item.text) || contentText(item.content) || contentText(item.delta) || contentText(item.value);
  }).join("");
}


//# sourceURL=../src/transport.ts
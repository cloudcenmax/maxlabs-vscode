import type { AuthStore } from "./auth.ts";
import type { Block, ImageBlock, Message, ModelCard, ToolSchema, Usage } from "./protocol.ts";
import { emptyUsage } from "./protocol.ts";
import { redactSecrets, type ReviewOutcome } from "./security.ts";

export interface RequestOptions { model: string; messages: Message[]; tools: ToolSchema[]; thinking: string; webSearch: string; webSearchUses: number }
export interface Completion { message: Message; usage: Usage }
export interface TransportDiagnostic { path: string; status: number; requestId?: string; detail: string }
export interface WorkspaceRequestOptions { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown; idempotencyKey?: string; signal?: AbortSignal }
export interface AuditCommandOptions { command: string; userMessages: string[]; workspace: string; model: string; signal?: AbortSignal }
export class TransportError extends Error {
  readonly status: number;
  readonly requestId?: string;
  constructor(message: string, status: number, requestId?: string) { super(message); this.name = "TransportError"; this.status = status; this.requestId = requestId; }
}

export class GatewayTransport {
  readonly auth: AuthStore;
  readonly origin: () => string;
  readonly apiBase: () => string;
  readonly sessionId: string;
  readonly diagnostic: (entry: TransportDiagnostic) => void;
  constructor(auth: AuthStore, origin: () => string, apiBase: () => string, sessionId: string, diagnostic: (entry: TransportDiagnostic) => void = defaultDiagnostic) { this.auth = auth; this.origin = origin; this.apiBase = apiBase; this.sessionId = sessionId; this.diagnostic = diagnostic; }

  async models(signal?: AbortSignal): Promise<ModelCard[]> {
    const response = await this.request("/models", { method: "GET", signal });
    const payload = await jsonPayload(response) as { data?: ModelCard[] };
    const models = (payload.data || []).filter((model) => model.id?.trim());
    if (!models.length) throw new Error("Cenmax AI returned no enabled models.");
    return models;
  }

  async complete(options: RequestOptions, onDelta: (text: string) => void, onReasoning: (text: string) => void, signal?: AbortSignal): Promise<Completion> {
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
    if (!contentType.toLowerCase().includes("text/event-stream")) return buffered(await jsonPayload(response), onDelta, onReasoning);
    return parseEventStream(response, onDelta, onReasoning);
  }

  /** Account-scoped cloud workspace endpoints: connected MCP tools and skills. OAuth only. */
  async workspace<T>(path: string, options: WorkspaceRequestOptions = {}): Promise<T> {
    const token = await this.auth.accessToken(this.origin(), options.signal);
    if (!token) throw new Error("Sign in with OAuth to use your connected tools and skills.");
    const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${token}` };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    const target = `/app/v1/workspace${path}`;
    const response = await fetch(`${this.origin().replace(/\/$/, "")}${target}`, {
      method: options.method || "GET", headers, signal: options.signal,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!response.ok) {
      const requestId = publicRequestId(response.headers);
      this.diagnostic({ path: target, status: response.status, requestId, detail: (await response.text()).slice(0, 4096) });
      if (response.status === 401 || response.status === 403) throw new TransportError("This account has not granted access to connected tools and skills. Reconnect it from the account menu to review the permissions.", 401, requestId);
      throw publicRequestError(response.status, requestId, false);
    }
    return await jsonPayload(response) as T;
  }

  /**
   * Auto mode's independent command check. Returns undefined whenever the
   * review cannot run, so the caller falls back to asking the person.
   */
  async auditCommand(options: AuditCommandOptions): Promise<ReviewOutcome | undefined> {
    try {
      // Never authorize a full command based on a truncated preview.
      if (options.command.length > 8_000) return undefined;
      const token = await this.auth.accessToken(this.origin(), options.signal);
      if (!token) return undefined;
      const state = {
        command: redactSecrets(options.command).slice(0, 8_000),
        agent_reason: "",
        workspace: options.workspace,
        user_messages: options.userMessages.map((message) => redactSecrets(message).slice(0, 3_000)),
      };
      const body = JSON.stringify({ model: options.model, state });
      if (body.length > 28_000) return undefined;
      const signal = AbortSignal.any([options.signal || new AbortController().signal, AbortSignal.timeout(8_000)]);
      const response = await fetch(`${this.origin().replace(/\/$/, "")}/app/v1/audit/command`, {
        method: "POST", signal, body,
        headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${token}` },
      });
      if (!response.ok) return undefined;
      const payload = await jsonPayload(response);
      // Auto mode guards against something bad happening; it is not a reason to
      // interrupt ordinary, probably-fine work. Anything the reviewer judges
      // more likely than not authorized and aligned clears the gate.
      if (payload.decision === "allow" && payload.authorized === true && Number(payload.confidence) >= 0.51 && ["low", "medium", "high"].includes(String(payload.risk))) return "allow";
      return payload.decision === "stop" ? "stop" : "ask";
    } catch { return undefined; }
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const token = await this.auth.accessToken(this.origin(), init.signal || undefined);
    const fallback = token ? undefined : await this.auth.apiKey();
    const base = token ? `${this.origin().replace(/\/$/, "")}/app/v1` : this.apiBase().replace(/\/$/, "");
    if (!token && !fallback) throw new Error("Sign in with OAuth or configure an API key fallback");
    const response = await fetch(`${base}/${path.replace(/^\//, "")}`, {
      ...init, headers: { "content-type": "application/json", authorization: `Bearer ${token || fallback}`, "x-session-id": this.sessionId, ...init.headers },
    });
    if (!response.ok) {
      const requestId = publicRequestId(response.headers);
      const detail = (await response.text()).slice(0, 4096);
      this.diagnostic({ path, status: response.status, requestId, detail });
      if (token && (response.status === 401 || response.status === 403)) {
        await this.auth.invalidateActive();
        throw new Error(`This account is no longer authorized or its work membership is inactive. Switch to another account or reconnect it.${suffix(requestId)}`);
      }
      throw publicRequestError(response.status, requestId, !token);
    }
    return response;
  }
}

function defaultDiagnostic(entry: TransportDiagnostic): void {
  // Customer machines are not a protected administrative diagnostics sink.
  // Detailed service diagnostics remain on the server.
  console.error(`Cenmax AI request failed (HTTP ${entry.status}).${suffix(entry.requestId)}`);
}

function publicRequestId(headers: Headers): string | undefined {
  for (const name of ["x-request-id", "request-id", "x-cenmax-request-id"]) {
    const value = headers.get(name)?.trim();
    if (value) return value.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 128) || undefined;
  }
  return undefined;
}

function suffix(requestId: string | undefined): string { return requestId ? ` Request ID: ${requestId}.` : ""; }

function publicRequestError(status: number, requestId: string | undefined, apiKeyFallback: boolean): TransportError {
  if (apiKeyFallback && (status === 401 || status === 403)) return new TransportError(`The configured API key is not authorized for this request. Check the key or sign in with OAuth.${suffix(requestId)}`, status, requestId);
  const reason = status === 400 ? "The request was not accepted. Adjust the request and try again."
    : status === 404 ? "The requested Cenmax AI resource was not found."
    : status === 408 ? "The request timed out. Please try again."
    : status === 409 ? "The request conflicted with the current account state. Please try again."
    : status === 429 ? "You have reached a usage limit. Try again when the window resets."
    : status >= 500 ? "Cenmax AI is temporarily unavailable. Please try again."
    : "The request could not be completed.";
  return new TransportError(`Cenmax AI request failed (HTTP ${status}). ${reason}${suffix(requestId)}`, status, requestId);
}

async function jsonPayload(response: Response): Promise<Record<string, unknown>> {
  try { return await response.json() as Record<string, unknown>; }
  catch { throw new Error("Cenmax AI returned an unreadable response. Please try again."); }
}

export function outbound(message: Message): Record<string, unknown> {
  const calls = message.content.filter((block) => block.type === "tool_call");
  const images = message.content.filter((block): block is ImageBlock => block.type === "image");
  const result = message.content.find((block) => block.type === "tool_result");
  const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  if (images.length && message.role === "user") {
    const content: Array<Record<string, unknown>> = [];
    if (text) content.push({ type: "text", text });
    for (const image of images) content.push({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } });
    return { role: message.role, content };
  }
  if (result && result.type === "tool_result" && !calls.length) {
    // A result carrying an image becomes the array content form; a text-only
    // result keeps the plain string form, which is the more portable of the two.
    if (images.length) {
      const content: Array<Record<string, unknown>> = [];
      if (result.text) content.push({ type: "text", text: result.text });
      for (const image of images) content.push({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } });
      return { role: "tool", tool_call_id: result.callId, content };
    }
    return { role: "tool", tool_call_id: result.callId, content: result.text };
  }
  if (calls.length) return { role: message.role, content: text || null, tool_calls: calls.map((call) => call.type === "tool_call" && ({ id: call.callId, type: "function", function: { name: call.name, arguments: call.arguments } })) };
  return { role: message.role, content: text };
}

export async function parseEventStream(response: Response, onDelta: (text: string) => void, onReasoning: (text: string) => void = () => {}): Promise<Completion> {
  if (!response.body) throw new Error("Cenmax AI stream had no body.");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "", text = "", usage = emptyUsage();
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  const consume = (frame: string): void => {
    const raw = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n").trim();
    if (!raw || raw === "[DONE]") return;
    let chunk: Record<string, unknown>;
    try { chunk = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
      if (chunk.usage) usage = parseUsage(chunk.usage as Record<string, unknown>);
      if (String(chunk.type || "").includes("output_text") || String(chunk.type || "").includes("content_block_delta")) {
        const eventText = contentText(chunk.delta) || contentText(chunk.text) || contentText((chunk.content_block as Record<string, unknown> || {}).text);
        if (eventText) { text += eventText; onDelta(eventText); }
      }
      for (const choice of chunk.choices as Array<Record<string, unknown>> || []) {
        const delta = choice.delta as Record<string, unknown> || {};
        const reasoning = [delta.reasoning, delta.reasoning_content, delta.analysis].find((value) => typeof value === "string") as string | undefined;
        if (reasoning) onReasoning(reasoning);
        const message = choice.message as Record<string, unknown> || {};
        const content = contentText(delta.content) || contentText(delta.text) || contentText(message.content) || contentText(choice.text);
        if (content) { text += content; onDelta(content); }
        for (const fragment of delta.tool_calls as Array<Record<string, unknown>> || []) {
          const index = Number(fragment.index || 0), current = calls.get(index) || { id: "", name: "", arguments: "" };
          const fn = fragment.function as Record<string, unknown> || {};
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
  const blocks: Block[] = text ? [{ type: "text", text }] : [];
  for (const call of [...calls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)) {
    const args = call.arguments.trim() || "{}"; JSON.parse(args); if (call.name) blocks.push({ type: "tool_call", callId: call.id, name: call.name, arguments: args });
  }
  if (!blocks.length) throw new Error("Cenmax AI stream contained no message or tool call.");
  return { message: { role: "assistant", content: blocks }, usage };
}

function buffered(payload: Record<string, unknown>, onDelta: (text: string) => void, onReasoning: (text: string) => void): Completion {
  const raw = ((payload.choices as Array<Record<string, unknown>> || [])[0]?.message || {}) as Record<string, unknown>;
  const blocks: Block[] = []; const content = contentText(raw.content);
  const reasoning = [raw.reasoning, raw.reasoning_content, raw.analysis].find((value) => typeof value === "string") as string | undefined;
  if (reasoning) onReasoning(reasoning);
  if (content) { blocks.push({ type: "text", text: content }); onDelta(content); }
  for (const call of raw.tool_calls as Array<Record<string, unknown>> || []) { const fn = call.function as Record<string, unknown> || {}; blocks.push({ type: "tool_call", callId: String(call.id || ""), name: String(fn.name || ""), arguments: String(fn.arguments || "{}") }); }
  return { message: { role: "assistant", content: blocks }, usage: parseUsage(payload.usage as Record<string, unknown> || {}) };
}

function parseUsage(raw: Record<string, unknown>): Usage {
  const prompt = Number(raw.prompt_tokens || raw.input_tokens || 0), details = raw.prompt_tokens_details as Record<string, unknown> || {};
  return { prompt, cached: numberAt(raw, "prompt_cache_hit_tokens", "cache_read_input_tokens") || numberAt(details, "cached_tokens"), cacheWrite: numberAt(raw, "cache_write_tokens", "cache_creation_input_tokens") || numberAt(details, "cache_write_tokens"), output: Number(raw.completion_tokens || raw.output_tokens || 0), reasoning: Number((raw.completion_tokens_details as Record<string, unknown> || {}).reasoning_tokens || raw.reasoning_tokens || 0), searches: Number(raw.web_search_requests || 0) };
}

function numberAt(object: Record<string, unknown>, ...keys: string[]): number { for (const key of keys) { const value = Number(object[key]); if (Number.isFinite(value) && value >= 0) return value; } return 0; }

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const item = part as Record<string, unknown>;
    return contentText(item.text) || contentText(item.content) || contentText(item.delta) || contentText(item.value);
  }).join("");
}

export type Mode = "manual" | "plan" | "auto" | "approve" | "full";
export type Thinking = "minimal" | "low" | "medium" | "high" | "default";
export type WebSearch = "off" | "auto" | "always";

export interface TextBlock { type: "text"; text: string }
export interface ImageBlock { type: "image"; mimeType: string; data: string }
export interface ToolCallBlock { type: "tool_call"; callId: string; name: string; arguments: string }
export interface ToolResultBlock { type: "tool_result"; callId: string; text: string; isError?: boolean }
export type Block = TextBlock | ImageBlock | ToolCallBlock | ToolResultBlock;
export interface Message { role: "system" | "user" | "assistant" | "tool"; content: Block[] }
export interface ToolSchema { name: string; description: string; parameters: Record<string, unknown> }
export interface ModelCard { id: string; description?: string; context_window?: number; max_output_tokens?: number }
export interface Usage { prompt: number; cached: number; cacheWrite: number; output: number; reasoning: number; searches: number }
export const emptyUsage = (): Usage => ({ prompt: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, searches: 0 });

/** An image attached to a chat message, kept as base64 without a data: prefix. */
export interface ChatImage { mimeType: string; data: string }

export const MAX_CHAT_IMAGES = 4;
export const MAX_CHAT_IMAGE_CHARACTERS = 8_000_000;
export const CHAT_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** Defensive bounds for images arriving from the webview before they enter history or a request. */
export function sanitizeImages(value: unknown): ChatImage[] {
  if (!Array.isArray(value)) return [];
  const images: ChatImage[] = [];
  for (const candidate of value) {
    if (images.length >= MAX_CHAT_IMAGES) break;
    if (!candidate || typeof candidate !== "object") continue;
    const entry = candidate as Record<string, unknown>;
    const mimeType = String(entry.mimeType || "").toLowerCase();
    const data = typeof entry.data === "string" ? entry.data : "";
    if (!CHAT_IMAGE_MIME_TYPES.includes(mimeType)) continue;
    if (!data || data.length > MAX_CHAT_IMAGE_CHARACTERS) continue;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) continue;
    images.push({ mimeType, data });
  }
  return images;
}

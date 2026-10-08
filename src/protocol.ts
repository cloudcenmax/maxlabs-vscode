export type Mode = "act" | "plan" | "auto";
export type Thinking = "minimal" | "low" | "medium" | "high" | "default";
export type WebSearch = "off" | "auto" | "always";

export interface TextBlock { type: "text"; text: string }
export interface ToolCallBlock { type: "tool_call"; callId: string; name: string; arguments: string }
export interface ToolResultBlock { type: "tool_result"; callId: string; text: string; isError?: boolean }
export type Block = TextBlock | ToolCallBlock | ToolResultBlock;
export interface Message { role: "system" | "user" | "assistant" | "tool"; content: Block[] }
export interface ToolSchema { name: string; description: string; parameters: Record<string, unknown> }
export interface ModelCard { id: string; description?: string }
export interface Usage { prompt: number; cached: number; cacheWrite: number; output: number; reasoning: number; searches: number }
export const emptyUsage = (): Usage => ({ prompt: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, searches: 0 });

import type { Usage } from "./protocol.ts";

export interface CacheMeterState {
  requests: number;
  total: Usage;
  first?: Usage;
}

export interface CacheStats {
  requests: number;
  hitRate: number;
  cached: number;
  written: number;
  uncached: number;
}

export class CacheMeter {
  private state: CacheMeterState;

  constructor(state?: CacheMeterState) {
    this.state = state ? structuredClone(state) : { requests: 0, total: zeroUsage() };
  }

  record(usage: Usage): void {
    if (!this.state.first) this.state.first = structuredClone(usage);
    this.state.total = addUsage(this.state.total, usage);
    this.state.requests++;
  }

  reset(): void { this.state = { requests: 0, total: zeroUsage() }; }
  serialize(): CacheMeterState { return structuredClone(this.state); }

  series(): CacheStats {
    if (this.state.requests <= 1 || !this.state.first) return { requests: Math.max(0, this.state.requests - 1), hitRate: 0, cached: 0, written: 0, uncached: 0 };
    const usage = subtractUsage(this.state.total, this.state.first);
    const uncached = Math.max(0, usage.prompt - usage.cached - usage.cacheWrite);
    const billed = usage.cached + usage.cacheWrite + uncached;
    return { requests: this.state.requests - 1, hitRate: billed ? usage.cached / billed : 0, cached: usage.cached, written: usage.cacheWrite, uncached };
  }
}

function zeroUsage(): Usage { return { prompt: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, searches: 0 }; }
function addUsage(left: Usage, right: Usage): Usage { return { prompt: left.prompt + right.prompt, cached: left.cached + right.cached, cacheWrite: left.cacheWrite + right.cacheWrite, output: left.output + right.output, reasoning: left.reasoning + right.reasoning, searches: left.searches + right.searches }; }
function subtractUsage(left: Usage, right: Usage): Usage { return { prompt: Math.max(0, left.prompt - right.prompt), cached: Math.max(0, left.cached - right.cached), cacheWrite: Math.max(0, left.cacheWrite - right.cacheWrite), output: Math.max(0, left.output - right.output), reasoning: Math.max(0, left.reasoning - right.reasoning), searches: Math.max(0, left.searches - right.searches) }; }

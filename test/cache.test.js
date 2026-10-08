import assert from "node:assert/strict";
import test from "node:test";
import { CacheMeter } from "../dist/cache.js";

const usage = (prompt, cached = 0, cacheWrite = 0) => ({ prompt, cached, cacheWrite, output: 0, reasoning: 0, searches: 0 });

test("series cache rate excludes the unavoidable cold request", () => {
  const meter = new CacheMeter();
  meter.record(usage(1_000));
  meter.record(usage(1_000, 990));
  meter.record(usage(1_000, 990));
  assert.equal(meter.series().hitRate, 0.99);
  assert.equal(meter.series().requests, 2);
});

test("cache meter state survives chat restoration", () => {
  const meter = new CacheMeter();
  meter.record(usage(1_000));
  meter.record(usage(1_000, 900, 50));
  const restored = new CacheMeter(meter.serialize());
  assert.deepEqual(restored.series(), { requests: 1, hitRate: 0.9, cached: 900, written: 50, uncached: 50 });
});

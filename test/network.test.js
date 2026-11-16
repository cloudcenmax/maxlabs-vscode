import assert from "node:assert/strict";
import test from "node:test";
import { createPinnedLookup, isPublicAddress, requestPublicPage, resolvePublicAddress } from "../dist/network.js";

test("only globally routable addresses are public", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ["::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "2001:db8::1", "64:ff9b::7f00:1", "2002:7f00:1::1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
  assert.equal(isPublicAddress("not-an-address"), false);
});

test("private literal hosts never reach the network", async () => {
  await assert.rejects(resolvePublicAddress("127.0.0.1"), /private or local/);
  await assert.rejects(resolvePublicAddress("::1"), /private or local/);
  await assert.rejects(resolvePublicAddress("::ffff:127.0.0.1"), /private or local/);
  await assert.rejects(requestPublicPage(new URL("http://127.0.0.1/")), /private or local/);
  await assert.rejects(requestPublicPage(new URL("http://[::1]/")), /private or local/);
});

test("the request lookup is pinned to the validated address", () => {
  const lookup = createPinnedLookup({ address: "93.184.216.34", family: 4 });
  let single;
  lookup("example.test", {}, (...values) => { single = values; });
  assert.deepEqual(single, [null, "93.184.216.34", 4]);
  let all;
  lookup("example.test", { all: true }, (...values) => { all = values; });
  assert.deepEqual(all, [null, [{ address: "93.184.216.34", family: 4 }]]);
});

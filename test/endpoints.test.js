import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_API_BASE, DEFAULT_GATEWAY, isSafeVerificationUrl, safeApiBaseUrl, safeGatewayUrl } from "../dist/endpoints.js";

test("endpoint settings accept only the trusted Cenmax AI hosts over HTTPS", () => {
  assert.equal(safeGatewayUrl(DEFAULT_GATEWAY), DEFAULT_GATEWAY);
  assert.equal(safeApiBaseUrl(DEFAULT_API_BASE), DEFAULT_API_BASE);
  assert.equal(safeGatewayUrl("https://attacker.example"), DEFAULT_GATEWAY);
  assert.equal(safeApiBaseUrl("https://attacker.example/v1"), DEFAULT_API_BASE);
  assert.equal(safeGatewayUrl("http://console.ai.cenmax.in"), DEFAULT_GATEWAY, "plain HTTP is refused");
  assert.equal(safeGatewayUrl("https://console.ai.cenmax.in.evil.example"), DEFAULT_GATEWAY);
  assert.equal(safeGatewayUrl("https://user:pass@console.ai.cenmax.in"), DEFAULT_GATEWAY);
  assert.equal(safeGatewayUrl("https://console.ai.cenmax.in/?redirect=evil"), DEFAULT_GATEWAY);
});

test("loopback development URLs and path normalization are handled explicitly", () => {
  assert.equal(safeGatewayUrl("http://localhost:8080"), "http://localhost:8080");
  assert.equal(safeGatewayUrl("http://127.0.0.1:9000"), "http://127.0.0.1:9000");
  assert.equal(safeApiBaseUrl("https://api.ai.cenmax.in/v1/"), "https://api.ai.cenmax.in/v1");
  assert.equal(safeApiBaseUrl("https://api.ai.cenmax.in/"), "https://api.ai.cenmax.in");
});

test("the OAuth verification link must belong to the gateway origin", () => {
  assert.equal(isSafeVerificationUrl("https://console.ai.cenmax.in/device?code=abc", DEFAULT_GATEWAY), true);
  assert.equal(isSafeVerificationUrl("https://attacker.example/device", DEFAULT_GATEWAY), false);
  assert.equal(isSafeVerificationUrl("http://console.ai.cenmax.in/device", DEFAULT_GATEWAY), false);
  assert.equal(isSafeVerificationUrl("javascript:alert(1)", DEFAULT_GATEWAY), false);
  assert.equal(isSafeVerificationUrl("http://localhost:3000/device", "http://localhost:9000"), true);
});

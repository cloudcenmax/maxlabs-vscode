import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeImages, MAX_CHAT_IMAGES } from "../dist/protocol.js";
import { bytesToBase64, imageFilesFromPaste, prepareImage } from "../media/images.js";

test("image sanitizer bounds count, mime type, and base64 shape", () => {
  const valid = { mimeType: "image/png", data: "AQID" };
  assert.deepEqual(sanitizeImages([valid]), [valid]);
  assert.deepEqual(sanitizeImages("not an array"), []);
  assert.deepEqual(sanitizeImages([{ mimeType: "image/svg+xml", data: "AQID" }]), []);
  assert.deepEqual(sanitizeImages([{ mimeType: "image/png", data: "not base64!" }]), []);
  assert.equal(sanitizeImages(Array.from({ length: MAX_CHAT_IMAGES + 2 }, () => valid)).length, MAX_CHAT_IMAGES);
});

test("clipboard extraction only keeps image files", () => {
  const image = { type: "image/png" };
  const files = imageFilesFromPaste({
    items: [
      { kind: "file", type: "image/png", getAsFile: () => image },
      { kind: "string", type: "text/plain", getAsFile: () => undefined },
      { kind: "file", type: "text/html", getAsFile: () => ({ type: "text/html" }) },
    ],
  });
  assert.deepEqual(files, [image]);
});

test("pasted images are downscaled and re-encoded for the request", async () => {
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toBlob: (callback) => callback(new Blob([Uint8Array.from([1, 2, 3])], { type: "image/jpeg" })) };
  globalThis.createImageBitmap = async () => ({ width: 3200, height: 1600, close() {} });
  globalThis.document = { createElement: () => canvas };
  try {
    const image = await prepareImage({ type: "image/png", size: 1024 });
    assert.equal(image.mimeType, "image/jpeg");
    assert.equal(image.data, bytesToBase64(Uint8Array.from([1, 2, 3])));
    assert.equal(canvas.width, 1600);
    assert.equal(canvas.height, 800);
  } finally {
    delete globalThis.createImageBitmap;
    delete globalThis.document;
  }
});

test("pasted images reject unsupported types and oversized files", async () => {
  await assert.rejects(prepareImage({ type: "image/svg+xml", size: 10 }), /Only PNG/);
  await assert.rejects(prepareImage({ type: "image/png", size: 13 * 1024 * 1024 }), /too large/);
});

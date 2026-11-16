export const MAX_IMAGES = 4;
export const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
export const MAX_EDGE = 1600;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** Extracts image files from a paste event's clipboard data. */
export function imageFilesFromPaste(clipboardData) {
  const files = [];
  for (const item of clipboardData?.items || []) {
    if (item.kind !== "file" || !String(item.type || "").toLowerCase().startsWith("image/")) continue;
    const file = item.getAsFile?.();
    if (file) files.push(file);
  }
  return files;
}

/** Validates, downscales, and re-encodes a pasted image for the chat request. */
export async function prepareImage(file) {
  const mimeType = String(file?.type || "").toLowerCase();
  if (!IMAGE_TYPES.includes(mimeType)) throw new Error("Only PNG, JPEG, WebP, or GIF images can be attached.");
  if (Number(file.size) > MAX_SOURCE_BYTES) throw new Error("That image is too large. Attach an image under 12 MB.");
  return compressImage(file);
}

async function compressImage(file) {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return readFile(file);
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { return readFile(file); }
  try {
    const width = Math.max(1, Number(bitmap.width) || 1);
    const height = Math.max(1, Number(bitmap.height) || 1);
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext?.("2d");
    if (!context) return readFile(file);
    context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob) return readFile(file);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { mimeType: "image/jpeg", data: bytesToBase64(bytes) };
  } finally {
    bitmap.close?.();
  }
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || "");
      const comma = value.indexOf(",");
      if (comma < 0) { reject(new Error("That image could not be read.")); return; }
      resolve({ mimeType: file.type, data: value.slice(comma + 1) });
    };
    reader.onerror = () => reject(new Error("That image could not be read."));
    reader.readAsDataURL(file);
  });
}

export function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  return btoa(binary);
}

                                                                   
                                                                         
                                                  

                                                         
                                                                             
                                                                                                     
                                                                                                         
                                                                             
                                                                                             
                                                                                                      
                                                                                                                    
                                                                                                                                  
export const emptyUsage = ()        => ({ prompt: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, searches: 0 });

/** An image attached to a chat message, kept as base64 without a data: prefix. */
                                                             

export const MAX_CHAT_IMAGES = 4;
export const MAX_CHAT_IMAGE_CHARACTERS = 8_000_000;
export const CHAT_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** Defensive bounds for images arriving from the webview before they enter history or a request. */
export function sanitizeImages(value         )              {
  if (!Array.isArray(value)) return [];
  const images              = [];
  for (const candidate of value) {
    if (images.length >= MAX_CHAT_IMAGES) break;
    if (!candidate || typeof candidate !== "object") continue;
    const entry = candidate                           ;
    const mimeType = String(entry.mimeType || "").toLowerCase();
    const data = typeof entry.data === "string" ? entry.data : "";
    if (!CHAT_IMAGE_MIME_TYPES.includes(mimeType)) continue;
    if (!data || data.length > MAX_CHAT_IMAGE_CHARACTERS) continue;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) continue;
    images.push({ mimeType, data });
  }
  return images;
}


//# sourceURL=../src/protocol.ts
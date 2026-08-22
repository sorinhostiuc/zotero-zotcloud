/**
 * SHA-256 file hashing for attachment deduplication.
 * Uses SubtleCrypto API available in Firefox 115+ (Zotero's engine).
 */

export async function computeFileHash(filePath: string): Promise<string> {
  // Read file as ArrayBuffer
  const file = await IOUtils.read(filePath);

  // Compute SHA-256
  const hashBuffer = await crypto.subtle.digest("SHA-256", file);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

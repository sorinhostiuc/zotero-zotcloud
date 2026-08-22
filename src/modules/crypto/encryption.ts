/**
 * AES-256-GCM encryption for cloud data.
 * Uses Web Crypto API (SubtleCrypto) available in Firefox 115+.
 *
 * Format: [4-byte salt length][salt][12-byte IV][ciphertext+tag]
 * Key derived from user password via PBKDF2 (100k iterations, SHA-256).
 */

const PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

export class Encryption {
  /** Encrypt data with a password. Returns binary blob with salt+IV prepended. */
  static async encrypt(
    data: ArrayBuffer,
    password: string,
  ): Promise<ArrayBuffer> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const key = await deriveKey(password, salt);

    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      data,
    );

    // Pack: [saltLen:4][salt][iv:12][ciphertext]
    const saltLenBuf = new Uint8Array(4);
    new DataView(saltLenBuf.buffer).setUint32(0, SALT_LENGTH, true);

    const result = new Uint8Array(
      4 + SALT_LENGTH + IV_LENGTH + ciphertext.byteLength,
    );
    result.set(saltLenBuf, 0);
    result.set(salt, 4);
    result.set(iv, 4 + SALT_LENGTH);
    result.set(new Uint8Array(ciphertext), 4 + SALT_LENGTH + IV_LENGTH);

    return result.buffer;
  }

  /** Decrypt data encrypted with encrypt(). */
  static async decrypt(
    data: ArrayBuffer,
    password: string,
  ): Promise<ArrayBuffer> {
    const view = new DataView(data);
    const saltLen = view.getUint32(0, true);

    const salt = new Uint8Array(data, 4, saltLen);
    const iv = new Uint8Array(data, 4 + saltLen, IV_LENGTH);
    const ciphertext = new Uint8Array(data, 4 + saltLen + IV_LENGTH);

    const key = await deriveKey(password, salt);

    return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  }

  /** Encrypt a string. Convenience wrapper. */
  static async encryptString(
    text: string,
    password: string,
  ): Promise<ArrayBuffer> {
    return Encryption.encrypt(new TextEncoder().encode(text).buffer, password);
  }

  /** Decrypt to string. Convenience wrapper. */
  static async decryptString(
    data: ArrayBuffer,
    password: string,
  ): Promise<string> {
    const decrypted = await Encryption.decrypt(data, password);
    return new TextDecoder().decode(decrypted);
  }
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

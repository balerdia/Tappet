/**
 * Credential encryption with AES-GCM via WebCrypto, so it works the same on
 * Node and Workers. The key comes from the environment (CREDENTIALS_KEY,
 * 32 random bytes, base64) and never touches the database.
 */

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function importKey(keyBase64: string) {
  const raw = fromBase64(keyBase64);
  if (raw.length !== 32) throw new Error("CREDENTIALS_KEY must be 32 bytes, base64 encoded.");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(keyBase64: string, plaintext: string): Promise<string> {
  const key = await importKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  return `v1.${toBase64(iv)}.${toBase64(data)}`;
}

export async function decryptSecret(keyBase64: string, sealed: string): Promise<string> {
  const [version, iv, data] = sealed.split(".");
  if (version !== "v1" || !iv || !data) throw new Error("Unrecognised secret format.");
  const key = await importKey(keyBase64);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv) },
    key,
    fromBase64(data),
  );
  return new TextDecoder().decode(plain);
}

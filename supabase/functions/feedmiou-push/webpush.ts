// Web Push without dependencies: payload encryption (RFC 8291, aes128gcm) and VAPID (RFC 8292),
// using only WebCrypto and fetch so it runs the same on Supabase Edge (Deno) and in Node for the tests.

export type Subscription = { endpoint: string; p256dh: string; auth: string };
export type Vapid = { publicKey: string; privateKey: string; subject: string };

const te = new TextEncoder();

export function b64u(buf: ArrayBuffer | Uint8Array): string {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64u(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const u8 = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u8[i] = b.charCodeAt(i);
  return u8;
}

const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

// An uncompressed P-256 point (0x04 || x || y) plus the private scalar, as a JWK WebCrypto can import.
function jwk(pub: Uint8Array, d?: string): JsonWebKey {
  return { kty: "EC", crv: "P-256", x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ...(d ? { d } : {}), ext: true };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

// `fixed` is only for the RFC test vector: a known sender key pair and salt instead of random ones.
export async function encrypt(sub: Subscription, plaintext: Uint8Array, fixed?: { senderPublic: string; senderPrivate: string; salt: string }) {
  const uaPublic = fromB64u(sub.p256dh), authSecret = fromB64u(sub.auth);
  let asPublic: Uint8Array, asPrivate: CryptoKey;
  if (fixed) {
    asPublic = fromB64u(fixed.senderPublic);
    asPrivate = await crypto.subtle.importKey("jwk", jwk(asPublic, fixed.senderPrivate), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  } else {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    asPrivate = pair.privateKey;
  }
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPrivate, 256));
  const ikm = await hkdf(authSecret, shared, cat(te.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = fixed ? fromB64u(fixed.salt) : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // a single record: the plaintext followed by the 0x02 "last record" delimiter
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, cat(plaintext, new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return cat(header, asPublic, ct);
}

// VAPID JWT, signed with ES256. WebCrypto already returns the raw r || s signature JWT expects.
export async function vapidHeader(endpoint: string, vapid: Vapid, now = Date.now()) {
  const pub = fromB64u(vapid.publicKey);
  const key = await crypto.subtle.importKey("jwk", jwk(pub, vapid.privateKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(te.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: vapid.subject })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${vapid.publicKey}`;
}

// Returns the push service's HTTP status: 201 means delivered to the service, 404 and 410 mean the
// subscription is gone and should be forgotten.
export async function sendPush(sub: Subscription, payload: string, vapid: Vapid, opts: { ttl?: number; urgency?: string } = {}) {
  const body = await encrypt(sub, te.encode(payload));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidHeader(sub.endpoint, vapid),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(opts.ttl ?? 3600),
      Urgency: opts.urgency ?? "normal"
    },
    body
  });
  await res.body?.cancel();
  return res.status;
}

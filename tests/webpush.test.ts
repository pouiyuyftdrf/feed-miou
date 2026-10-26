// node tests/webpush.test.ts
// Checks the Web Push sender against the RFC 8291 test vector, decrypts a random message with
// node:crypto (independent of WebCrypto), and verifies the VAPID signature.
import { createECDH, createDecipheriv, hkdfSync, createPublicKey, verify } from "node:crypto";
import assert from "node:assert/strict";
import { encrypt, vapidHeader, makeVapid, b64u, fromB64u } from "../supabase/functions/feedmiou-push/webpush.ts";

const te = new TextEncoder();

// RFC 8291, appendix A
const rfc = await encrypt(
  { endpoint: "https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV", p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
  te.encode("When I grow up, I want to be a watermelon"),
  { senderPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8", senderPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", salt: "DGv6ra1nlYgDCS1FRnbzlw" }
);
assert.equal(b64u(rfc), "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
console.log("ok  RFC 8291 test vector");

// A browser-side key pair, then decrypt what we encrypt with node:crypto only
const ua = createECDH("prime256v1"); ua.generateKeys();
const auth = crypto.getRandomValues(new Uint8Array(16));
const msg = JSON.stringify({ id: "fed_x", e: "é".repeat(300) });
const body = await encrypt({ endpoint: "https://x", p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) }, te.encode(msg));
const salt = body.subarray(0, 16), rs = new DataView(body.buffer, body.byteOffset).getUint32(16), idlen = body[20];
const asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
assert.equal(rs, 4096);
const shared = ua.computeSecret(asPublic);
const ikm = Buffer.from(hkdfSync("sha256", shared, auth, Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic]), 32));
const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
const d = createDecipheriv("aes-128-gcm", cek, nonce);
d.setAuthTag(ct.subarray(ct.length - 16));
const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
assert.equal(pt[pt.length - 1], 2);
assert.equal(pt.subarray(0, -1).toString("utf8"), msg);
console.log("ok  round trip through node:crypto");

// VAPID: a fresh key pair, then check the JWT claims and signature
const v = createECDH("prime256v1"); v.generateKeys();
const vapid = { publicKey: b64u(v.getPublicKey()), privateKey: b64u(v.getPrivateKey()), subject: "https://example.org/" };
const h = await vapidHeader("https://web.push.apple.com/QGuQyavXutnMH8ycXkxM", vapid, 1_700_000_000_000);
const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h);
assert.ok(m);
const claims = JSON.parse(Buffer.from(fromB64u(m[2])).toString());
assert.deepEqual(claims, { aud: "https://web.push.apple.com", exp: 1_700_000_000 + 12 * 3600, sub: "https://example.org/" });
assert.equal(m[4], vapid.publicKey);
const pubKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(v.getPublicKey().subarray(1, 33)), y: b64u(v.getPublicKey().subarray(33)) }, format: "jwk" });
assert.ok(verify("sha256", Buffer.from(`${m[1]}.${m[2]}`), { key: pubKey, dsaEncoding: "ieee-p1363" }, Buffer.from(fromB64u(m[3]))));
console.log("ok  VAPID signature");

// A key pair from makeVapid signs headers that verify against its own public key
const made = await makeVapid("https://example.org/");
const h2 = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(await vapidHeader("https://fcm.googleapis.com/fcm/send/x", made));
assert.ok(h2);
const pub2 = fromB64u(made.publicKey);
assert.equal(pub2.length, 65);
const madeKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(pub2.subarray(1, 33)), y: b64u(pub2.subarray(33)) }, format: "jwk" });
assert.ok(verify("sha256", Buffer.from(`${h2[1]}.${h2[2]}`), { key: madeKey, dsaEncoding: "ieee-p1363" }, Buffer.from(fromB64u(h2[3]))));
console.log("ok  makeVapid key pair");

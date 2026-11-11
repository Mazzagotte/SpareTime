// Web Push from a Worker with no dependencies: VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291).
import { b64urlDecode, b64urlEncode } from './util.js';

const enc = new TextEncoder();

function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

// Encrypts `payload` (Uint8Array) for a subscription's p256dh/auth keys. Returns the request body.
export async function encryptPayload(payload, p256dhB64, authB64, { salt, serverKeys } = {}) {
  const uaPublic = b64urlDecode(p256dhB64);
  const authSecret = b64urlDecode(authB64);
  salt = salt || crypto.getRandomValues(new Uint8Array(16));
  serverKeys = serverKeys || (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeys.publicKey));

  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, serverKeys.privateKey, 256));

  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded = concat(payload, new Uint8Array([2])); // single record: delimiter 0x02, no padding
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

// The VAPID key pair: from secrets if set, otherwise created once and kept in the database.
let cachedKeys = null;
export async function vapidKeys(env) {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) return { pub: env.VAPID_PUBLIC_KEY, priv: env.VAPID_PRIVATE_KEY };
  if (cachedKeys) return cachedKeys;
  const read = async () => {
    const { results } = await env.DB.prepare("SELECT key, value FROM config WHERE key IN ('vapid_public', 'vapid_private')").all();
    const m = Object.fromEntries(results.map((r) => [r.key, r.value]));
    return m.vapid_public && m.vapid_private ? { pub: m.vapid_public, priv: m.vapid_private } : null;
  };
  let keys = await read();
  if (!keys) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pub = b64urlEncode(await crypto.subtle.exportKey('raw', kp.publicKey));
    const priv = (await crypto.subtle.exportKey('jwk', kp.privateKey)).d;
    // Both rows in one batch; INSERT OR IGNORE means a simultaneous first request can't create a second pair.
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO config (key, value) VALUES ('vapid_public', ?)").bind(pub),
      env.DB.prepare("INSERT OR IGNORE INTO config (key, value) VALUES ('vapid_private', ?)").bind(priv),
    ]);
    keys = await read();
  }
  cachedKeys = keys;
  return keys;
}

let cachedSigner = null;
async function vapidSigner(env) {
  const { pub: pubB64, priv } = await vapidKeys(env);
  if (cachedSigner && cachedSigner.pub === pubB64) return cachedSigner.key;
  const pub = b64urlDecode(pubB64); // 65-byte uncompressed point
  const jwk = {
    kty: 'EC', crv: 'P-256', ext: true,
    x: b64urlEncode(pub.slice(1, 33)),
    y: b64urlEncode(pub.slice(33, 65)),
    d: priv,
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  cachedSigner = { pub: pubB64, key };
  return key;
}

export async function vapidHeader(env, endpoint) {
  const aud = new URL(endpoint).origin;
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(enc.encode(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || 'mailto:admin@example.com',
  })));
  const unsigned = `${header}.${claims}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await vapidSigner(env), enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64urlEncode(sig)}, k=${(await vapidKeys(env)).pub}`;
}

// Sends one notification. Returns 'ok' | 'gone' (subscription expired) | 'error'.
export async function sendPush(env, sub, message) {
  const body = await encryptPayload(enc.encode(JSON.stringify(message)), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(env, sub.endpoint),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'normal',
    },
    body,
  });
  if (res.status === 404 || res.status === 410) return 'gone';
  return res.ok ? 'ok' : 'error';
}

// Sends to every device a person has turned notifications on for, and drops dead subscriptions.
export async function pushToUser(env, userId, message) {
  const { results } = await env.DB.prepare('SELECT * FROM push_subs WHERE user_id = ?').bind(userId).all();
  await Promise.all(results.map(async (sub) => {
    try {
      const r = await sendPush(env, sub, message);
      if (r === 'gone') await env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(sub.id).run();
    } catch (e) {
      console.log('push failed', e && e.message);
    }
  }));
}

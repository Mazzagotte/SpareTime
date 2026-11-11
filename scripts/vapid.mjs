// Generates the key pair that lets your Worker send push notifications.
// Run once: `npm run vapid`, then store both values as Worker secrets.
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
const b64url = (u8) => Buffer.from(u8).toString('base64url');
console.log('VAPID_PUBLIC_KEY=' + b64url(raw));
console.log('VAPID_PRIVATE_KEY=' + jwk.d);
console.log('\nSave them with:\n  npx wrangler secret put VAPID_PUBLIC_KEY\n  npx wrangler secret put VAPID_PRIVATE_KEY');

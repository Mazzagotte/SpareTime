// SpareTime — a shared calendar for two. API under /api, the app itself is served from /public.
import { handleApi } from './api.js';
import { runCronSafe } from './cron.js';
import { HttpError, json } from './util.js';

// Changes the apps poll for (anything that alters what the other person would see).
const QUIET = /^\/api\/(login|logout|push\/|activity\/read|prefs|password|dev\/)/;
async function bumpRev(env) {
  try {
    await env.DB.prepare("INSERT INTO config (key, value) VALUES ('rev', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1").run();
  } catch (e) {
    console.log('rev bump failed', e && e.message);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        const res = await handleApi(request, env, ctx);
        if (res.ok && request.method !== 'GET' && !QUIET.test(url.pathname)) await bumpRev(env);
        return res;
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        console.log('api error', e && e.stack);
        return json({ error: 'Something went wrong' }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCronSafe(env, ctx));
  },
};

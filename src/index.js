// SpareTime — a shared calendar for two. API under /api, the app itself is served from /public.
import { handleApi } from './api.js';
import { runCron } from './cron.js';
import { HttpError, json } from './util.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, ctx);
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        console.log('api error', e && e.stack);
        return json({ error: 'Something went wrong' }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env, ctx));
  },
};

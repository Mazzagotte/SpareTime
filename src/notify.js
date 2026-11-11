// Activity feed + push, filtered by each person's notification settings.
import { pushToUser } from './push.js';

export const PREF_DEFAULTS = {
  partner_changes: 1, // the other person adds, changes or removes something
  reactions: 1,       // reactions and on-my-way / running-late
  partner_morning: 1, // morning-of heads-up for the other person's events
  both_booked: 1,     // you both have something the same day
  weather: 1,         // rain / snow alerts the evening before
  recap: 1,           // Sunday night recap
};

export async function getPrefs(env, userId) {
  const { results } = await env.DB.prepare('SELECT key, value FROM prefs WHERE user_id = ?').bind(userId).all();
  const prefs = { ...PREF_DEFAULTS };
  for (const r of results) if (r.key in prefs) prefs[r.key] = r.value ? 1 : 0;
  return prefs;
}

// Records an item in someone's Activity feed and (if their settings allow) pushes it to their phone.
export async function notify(env, ctx, { to, pref, kind, actorId = null, eventId = null, occDate = null, lead, body, url = '/#/activity', feed = true }) {
  if (feed) {
    await env.DB.prepare(
      'INSERT INTO activity (user_id, kind, actor_id, event_id, occ_date, lead, body) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(to, kind, actorId, eventId, occDate, lead, body).run();
  }
  if (pref) {
    const prefs = await getPrefs(env, to);
    if (!prefs[pref]) return;
  }
  const work = pushToUser(env, to, { title: lead.replace(/:$/, ''), body, url, tag: kind + (eventId ? `-${eventId}` : '') });
  if (ctx && ctx.waitUntil) ctx.waitUntil(work);
  else await work;
}

// Marks a scheduled notification as sent. Returns false if it was already sent.
export async function claim(env, key) {
  const r = await env.DB.prepare('INSERT OR IGNORE INTO sent (key) VALUES (?)').bind(key).run();
  return r.meta.changes > 0;
}

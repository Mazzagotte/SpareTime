// Runs every 5 minutes: reminders, morning heads-ups, 6 PM weather alerts, 7 PM Sunday recap.
import { weekSummary } from './api.js';
import { claim, getPrefs, notify } from './notify.js';
import { pushToUser } from './push.js';
import { addDays, occurrences, prettyDate, prettyTime, safeJson, weekday, zonedParts, zonedToUtc } from './util.js';
import { forecast, isBadWeather } from './weather.js';

const WINDOW_MS = 7 * 60000; // a little longer than the 5-minute schedule; `sent` keys stop doubles

async function loadOcc(env, from, to) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM events WHERE date <= ? AND (repeat != 'none' OR date >= ?)"
  ).bind(to, from).all();
  const out = [];
  for (const ev of results) for (const d of occurrences(ev, from, to)) out.push({ ev, date: d });
  out.sort((a, b) => (a.date + (a.ev.start_time || '00:00')).localeCompare(b.date + (b.ev.start_time || '00:00')));
  return out;
}

const hiddenFor = (ev, uid) => ev.visibility === 'private' && ev.owner_id != null && ev.owner_id !== uid && ev.created_by !== uid;
const maskedFor = (ev, uid) => ev.visibility === 'busy' && ev.owner_id != null && ev.owner_id !== uid && ev.created_by !== uid;

function due(fireAt, now) {
  return fireAt > now - WINDOW_MS && fireAt <= now;
}

function joinDays(dates) {
  const names = dates.map((d) => prettyDate(d).split(',')[0]);
  if (names.length <= 1) return names.join('');
  return names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1];
}

export async function runCron(env, ctx, now = Date.now()) {
  const tz = env.TIMEZONE;
  const log = [];
  const local = zonedParts(tz, new Date(now));
  const today = local.date;
  const { results: ppl } = await env.DB.prepare('SELECT id, name FROM users ORDER BY id').all();
  if (!ppl.length) return;
  const nameOf = (id) => (ppl.find((p) => p.id === id) || {}).name || 'Someone';

  // Look 32 days ahead so reminders set up to a month before an event still fire.
  const occ = await loadOcc(env, addDays(today, -1), addDays(today, 32));

  // ---- per-event reminders ----
  // Two people's reminder settings are a small table — load it whole (D1 caps bound parameters at 100).
  const remRows = occ.length ? (await env.DB.prepare('SELECT * FROM event_reminders').all()).results : [];
  for (const { ev, date } of occ) {
    const start = ev.all_day ? '09:00' : ev.start_time || '09:00';
    const startAt = zonedToUtc(tz, date, start);
    for (const row of remRows.filter((r) => r.event_id === ev.id)) {
      const uid = row.user_id;
      if (hiddenFor(ev, uid)) continue;
      for (const kind of safeJson(row.kinds, [])) {
        let fireAt; let lead;
        if (kind === 'night') { fireAt = zonedToUtc(tz, addDays(date, -1), '20:00'); lead = 'Tomorrow'; }
        else if (kind === 'morning') { fireAt = zonedToUtc(tz, date, '08:00'); lead = 'Today'; }
        else if (kind === 'hour') { if (ev.all_day) continue; fireAt = startAt - 3600000; lead = 'In 1 hour'; }
        else if (typeof kind === 'number') {
          if (ev.all_day && kind < 1440) continue; // all-day events: day/week reminders only (counted from 9 AM)
          fireAt = startAt - kind * 60000;
          lead = kind < 60 ? `In ${kind} min` : kind < 1440 ? `In ${kind % 60 ? (kind / 60).toFixed(1) : kind / 60} hr`
            : kind === 1440 ? 'Tomorrow' : kind === 43200 ? 'In 1 month' : kind % 10080 === 0 ? `In ${kind / 10080} week${kind > 10080 ? 's' : ''}` : `In ${Math.round(kind / 1440)} days`;
        }
        else continue;
        if (!due(fireAt, now)) continue;
        if (!(await claim(env, `rem:${ev.id}:${date}:${uid}:${kind}`))) continue;
        const whose = ev.owner_id != null && ev.owner_id !== uid ? `${nameOf(ev.owner_id)} has ` : '';
        const title = maskedFor(ev, uid) ? 'Busy' : ev.title;
        const time = ev.all_day ? 'All day' : prettyTime(ev.start_time);
        log.push(`reminder → ${nameOf(uid)}: ${lead}: ${whose}${title}`);
        ctx.waitUntil(pushToUser(env, uid, {
          title: `${lead}: ${whose}${title}`,
          body: [time, !maskedFor(ev, uid) && ev.location].filter(Boolean).join(' · '),
          url: `/#/event/${ev.id}/${date}`,
          tag: `rem-${ev.id}-${date}`,
        }));
      }
    }
  }

  // ---- 8 AM: what the other person has today ----
  if (due(zonedToUtc(tz, today, '08:00'), now)) {
    for (const p of ppl) {
      const theirs = occ.filter((o) => o.date === today && o.ev.owner_id != null && o.ev.owner_id !== p.id && !hiddenFor(o.ev, p.id));
      if (!theirs.length) continue;
      if (!(await claim(env, `pm:${today}:${p.id}`))) continue;
      if (!(await getPrefs(env, p.id)).partner_morning) continue;
      const other = nameOf(theirs[0].ev.owner_id);
      log.push(`morning → ${p.name}: ${theirs.length} of ${nameOf(theirs[0].ev.owner_id)}'s`);
      const list = theirs.slice(0, 3).map((o) => `${maskedFor(o.ev, p.id) ? 'Busy' : o.ev.title}${o.ev.all_day ? '' : ' at ' + prettyTime(o.ev.start_time)}`);
      ctx.waitUntil(pushToUser(env, p.id, { title: `Today: ${other} has ${theirs.length === 1 ? 'something' : theirs.length + ' things'}`, body: list.join(' · '), url: `/#/month/${today}`, tag: `pm-${today}` }));
    }
  }

  // ---- 6 PM: weather alert for tomorrow ----
  const tomorrow = addDays(today, 1);
  if (due(zonedToUtc(tz, today, '18:00'), now)) {
    let wx = null;
    try { wx = await forecast(env); } catch { wx = null; }
    const day = wx && wx.days[tomorrow];
    if (isBadWeather(day)) {
      for (const p of ppl) {
        const mine = occ.filter((o) => o.date === tomorrow && (o.ev.owner_id == null || o.ev.owner_id === p.id));
        if (!mine.length) continue;
        if (!(await claim(env, `wx:${tomorrow}:${p.id}`))) continue;
        const first = mine[0].ev;
        log.push(`weather → ${p.name}`);
        const what = day.snow > 0 ? 'Snow' : day.icon === 'storm' ? 'Storms' : `${day.text} (${day.precip}%)`;
        await notify(env, ctx, {
          to: p.id, pref: 'weather', kind: 'weather', eventId: first.id, occDate: tomorrow,
          lead: 'Weather:', body: `${what} tomorrow in ${wx.place}. ${first.title}${first.all_day ? '' : ' at ' + prettyTime(first.start_time)}${mine.length > 1 ? ` + ${mine.length - 1} more` : ''} — leave a little early.`,
          url: `/#/event/${first.id}/${tomorrow}`,
        });
      }
    }
  }

  // ---- Sunday 7 PM: recap of the week ahead ----
  if (weekday(today) === 0 && due(zonedToUtc(tz, today, '19:00'), now)) {
    for (const p of ppl) {
      if (!(await claim(env, `recap:${today}:${p.id}`))) continue;
      const w = await weekSummary(env, tomorrow, p, ppl);
      const counts = w.counts.map((c) => `${c.n} for ${c.id === p.id ? 'you' : c.name}`).join(', ');
      const bits = [`Next week: ${counts}.`];
      if (w.free.length) bits.push(`Free together ${joinDays(w.free.slice(0, 3))}.`);
      if (w.both_booked.length) bits.push(`Both booked ${joinDays(w.both_booked)}.`);
      log.push(`recap → ${p.name}: ${bits.join(' ')}`);
      await notify(env, ctx, { to: p.id, pref: 'recap', kind: 'recap', lead: 'Sunday recap:', body: bits.join(' '), url: '/#/activity' });
    }
  }

  // ---- 3 AM housekeeping ----
  if (due(zonedToUtc(tz, today, '03:00'), now)) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sent WHERE at < datetime('now', '-30 days')"),
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
      env.DB.prepare("DELETE FROM activity WHERE created_at < datetime('now', '-90 days')"),
    ]);
  }
  return log;
}

// Wraps the scheduled job: records a heartbeat, and if something breaks, alerts both of you (once a day).
export async function runCronSafe(env, ctx) {
  try {
    await runCron(env, ctx);
    await env.DB.prepare("INSERT INTO config (key, value) VALUES ('cron_last', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .bind(String(Date.now())).run();
  } catch (e) {
    const message = (e && e.message) || String(e);
    console.log('cron failed', e && e.stack);
    try {
      await env.DB.prepare("INSERT INTO config (key, value) VALUES ('cron_error', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
        .bind(JSON.stringify({ at: Date.now(), message: message.slice(0, 200) })).run();
      const today = zonedParts(env.TIMEZONE).date;
      if (await claim(env, `cronerr:${today}`)) {
        const { results: ppl } = await env.DB.prepare('SELECT id FROM users').all();
        await Promise.all(ppl.map((p) => pushToUser(env, p.id, {
          title: 'SpareTime hit a problem',
          body: 'Reminders may be delayed. It keeps retrying every 5 minutes.',
          url: '/#/activity', tag: 'health',
        })));
      }
    } catch { /* nothing else we can do */ }
  }
}

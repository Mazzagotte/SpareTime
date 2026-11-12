// JSON API for the app. Every route except state/setup/login requires a signed-in person.
import { checkOrigin, createSession, currentUser, destroySession, hashPassword, requireUser, verifyPassword } from './auth.js';
import { PREF_DEFAULTS, claim, getPrefs, notify } from './notify.js';
import { pushToUser, vapidKeys } from './push.js';
import {
  COLOR_RE, DATE_RE, HttpError, TIME_RE, addDays, daysBetween, json, occurrenceDays, occurrences, prettyDate, readJson,
  safeJson, spanDays, str, todayLocal, weekday, whenText,
} from './util.js';
import { forecast, weatherFor } from './weather.js';

const REPEATS = ['none', 'daily', 'weekly', 'biweekly', 'monthly', 'yearly'];
const MAX_SPAN_DAYS = 31;
const MAX_REMINDER_MIN = 43200; // 30 days
const VISIBILITY = ['shared', 'busy', 'private'];
const REMINDER_WORDS = ['night', 'morning', 'hour'];
const OTHER = { id: null, name: 'Other', color: '#6B7280' };

// ---------- people & permissions ----------
async function people(env) {
  const { results } = await env.DB.prepare('SELECT id, name, color FROM users ORDER BY id').all();
  return results;
}
function partnerOf(me, ppl) {
  return ppl.find((p) => p.id !== me.id) || null;
}
function canSeeFully(ev, me) {
  return ev.owner_id == null || ev.owner_id === me.id || ev.created_by === me.id || ev.visibility === 'shared';
}
function isHidden(ev, me) {
  return ev.visibility === 'private' && ev.owner_id != null && ev.owner_id !== me.id && ev.created_by !== me.id;
}
function canEdit(ev, me) {
  return ev.owner_id == null || ev.owner_id === me.id || ev.created_by === me.id;
}
// Everyone who should hear about an event other than `me`.
function audience(ev, me, ppl) {
  return ppl.filter((p) => p.id !== me.id).map((p) => p.id);
}

// ---------- loading ----------
async function categoryMap(env) {
  const { results } = await env.DB.prepare('SELECT * FROM categories').all();
  return new Map(results.map((c) => [c.id, c]));
}

// One entry per day an event covers: { ev, date (that day), start (occurrence's first day), index, span }.
async function eventsInRange(env, from, to) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM events WHERE date <= ? AND (repeat != 'none' OR COALESCE(end_date, date) >= ?)"
  ).bind(to, addDays(from, -MAX_SPAN_DAYS)).all();
  const occ = [];
  for (const ev of results) for (const o of occurrenceDays(ev, from, to)) occ.push({ ev, date: o.day, start: o.start, index: o.index, span: o.span });
  const key = (o) => o.date + String(99 - Math.min(o.span, 99)).padStart(2, '0') + (o.ev.all_day || o.index > 0 ? '00' : o.ev.start_time || '99');
  occ.sort((a, b) => key(a).localeCompare(key(b)) || a.ev.id - b.ev.id);
  return occ;
}

// o: { start, date, index, span } for a covered day (single-day events: index 0, span 1).
function view(ev, o, me, cats, ppl) {
  const date = o.start;
  const owner = ppl.find((p) => p.id === ev.owner_id) || null;
  const cat = ev.category_id ? cats.get(ev.category_id) : null;
  const category = cat && !cat.deleted_at ? { id: cat.id, name: cat.name, color: cat.color } : OTHER;
  const base = {
    id: ev.id,
    occ_date: date,
    day: o.date,
    day_index: o.index,
    span: o.span,
    end_date: o.span > 1 ? addDays(date, o.span - 1) : null,
    owner_id: ev.owner_id,
    owner_name: owner ? owner.name : 'Both of us',
    start_time: ev.all_day ? null : ev.start_time,
    end_time: ev.all_day ? null : ev.end_time,
    all_day: !!ev.all_day,
    repeat: ev.repeat,
    visibility: ev.visibility,
  };
  if (!canSeeFully(ev, me)) {
    return { ...base, masked: true, title: 'Busy', category: { id: null, name: 'Busy', color: '#6B7280' } };
  }
  return {
    ...base,
    masked: false,
    title: ev.title,
    category,
    location: ev.location,
    notes: ev.notes,
    repeat_until: ev.repeat_until,
    date: ev.date,
    can_edit: canEdit(ev, me),
  };
}

async function loadEvent(env, id) {
  const ev = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
  if (!ev) throw new HttpError(404, 'Event not found');
  return ev;
}

// ---------- validation ----------
async function eventInput(env, body, me, ppl) {
  const title = str(body.title, 120);
  if (!title) throw new HttpError(400, 'Give the event a name');
  if (!DATE_RE.test(body.date || '')) throw new HttpError(400, 'Pick a date');
  const allDay = !!body.all_day;
  const start = allDay ? null : body.start_time || null;
  const end = allDay ? null : body.end_time || null;
  if (!allDay && (!start || !TIME_RE.test(start))) throw new HttpError(400, 'Pick a start time');
  if (end && !TIME_RE.test(end)) throw new HttpError(400, 'End time looks off');
  if (end && start && end <= start && !(body.end_date && body.end_date > body.date)) throw new HttpError(400, 'The end time is before the start');
  let endDate = body.end_date && DATE_RE.test(body.end_date) && body.end_date > body.date ? body.end_date : null;
  if (endDate && daysBetween(body.date, endDate) > MAX_SPAN_DAYS - 1) throw new HttpError(400, `Events can last up to ${MAX_SPAN_DAYS} days`);
  const repeat = REPEATS.includes(body.repeat) ? body.repeat : 'none';
  if (endDate && repeat === 'daily') throw new HttpError(400, "A multi-day event can't repeat every day");
  const until = body.repeat_until && DATE_RE.test(body.repeat_until) ? body.repeat_until : null;
  let ownerId = null;
  if (body.owner_id != null) {
    ownerId = Number(body.owner_id);
    if (!ppl.some((p) => p.id === ownerId)) throw new HttpError(400, 'Unknown person');
  }
  let categoryId = body.category_id ? Number(body.category_id) : null;
  if (categoryId) {
    const c = await env.DB.prepare('SELECT * FROM categories WHERE id = ? AND deleted_at IS NULL').bind(categoryId).first();
    if (!c) throw new HttpError(400, 'That category was deleted');
  }
  const visibility = ownerId == null ? 'shared' : VISIBILITY.includes(body.visibility) ? body.visibility : 'shared';
  return {
    owner_id: ownerId, category_id: categoryId, title, date: body.date, end_date: endDate, start_time: start, end_time: end,
    all_day: allDay ? 1 : 0, location: str(body.location, 160), notes: str(body.notes, 2000), repeat,
    repeat_until: repeat === 'none' ? null : until, visibility,
    notify_partner: body.notify_partner === false ? 0 : 1,
  };
}

function cleanKinds(kinds) {
  if (!Array.isArray(kinds)) return [];
  const out = [];
  for (const k of kinds) {
    if (REMINDER_WORDS.includes(k) && !out.includes(k)) out.push(k);
    else if (Number.isInteger(k) && k > 0 && k <= MAX_REMINDER_MIN && !out.includes(k)) out.push(k);
  }
  return out.slice(0, 6);
}

async function setKinds(env, eventId, userId, kinds) {
  await env.DB.prepare(
    'INSERT INTO event_reminders (event_id, user_id, kinds) VALUES (?, ?, ?) ON CONFLICT (event_id, user_id) DO UPDATE SET kinds = excluded.kinds'
  ).bind(eventId, userId, JSON.stringify(cleanKinds(kinds))).run();
}

async function categoryDefaults(env, userId, categoryId) {
  if (!categoryId) return null;
  const r = await env.DB.prepare('SELECT kinds FROM category_reminders WHERE user_id = ? AND category_id = ?').bind(userId, categoryId).first();
  return r ? safeJson(r.kinds, null) : null;
}

const TEMP_WORDS = ['strike', 'spare', 'lane', 'pin', 'frame', 'split', 'hook', 'gutter', 'ball', 'tenpin', 'double', 'turkey'];
function tempPassword() {
  const r = crypto.getRandomValues(new Uint32Array(3));
  return `${TEMP_WORDS[r[0] % TEMP_WORDS.length]}-${TEMP_WORDS[r[1] % TEMP_WORDS.length]}-${100 + (r[2] % 900)}`;
}

// Moves reactions/statuses for occurrences on or after `fromDate` (or exactly `onlyDate`) to another event, shifting dates by `shift` days.
async function moveOccurrenceData(env, fromId, toId, { onlyDate = null, fromDate = null, shift = 0 }) {
  for (const table of ['reactions', 'statuses']) {
    const where = onlyDate ? 'occ_date = ?' : 'occ_date >= ?';
    await env.DB.prepare(`UPDATE OR IGNORE ${table} SET event_id = ?, occ_date = date(occ_date, ?) WHERE event_id = ? AND ${where}`)
      .bind(toId, `${shift >= 0 ? '+' : ''}${shift} days`, fromId, onlyDate || fromDate).run();
  }
}

async function getKinds(env, eventId, userId) {
  const r = await env.DB.prepare('SELECT kinds FROM event_reminders WHERE event_id = ? AND user_id = ?').bind(eventId, userId).first();
  return r ? safeJson(r.kinds, []) : [];
}

// ---------- both-booked check ----------
async function checkBothBooked(env, ctx, date, ppl) {
  if (ppl.length < 2) return;
  const occ = await eventsInRange(env, date, date);
  const owners = new Set(occ.filter((o) => o.ev.owner_id != null && o.ev.visibility !== 'private').map((o) => o.ev.owner_id));
  if (!ppl.every((p) => owners.has(p.id))) return;
  if (date < todayLocal(env.TIMEZONE)) return;
  if (!(await claim(env, `both:${date}`))) return;
  for (const p of ppl) {
    await notify(env, ctx, {
      to: p.id, pref: 'both_booked', kind: 'both_booked', occDate: date,
      lead: 'Heads-up:', body: `you're both booked ${prettyDate(date)}`, url: `/#/month/${date}`,
    });
  }
}

// ---------- week summary (Activity card + Sunday recap) ----------
export async function weekSummary(env, from, me, ppl) {
  const to = addDays(from, 6);
  const occ = await eventsInRange(env, from, to);
  const counts = Object.fromEntries(ppl.map((p) => [p.id, 0]));
  const perDay = {};
  const ownersByDay = {};
  const seen = new Set();
  for (const o of occ) {
    if (isHidden(o.ev, me)) continue;
    perDay[o.date] = (perDay[o.date] || 0) + 1;
    const once = `${o.ev.id}:${o.start}`;
    if (!seen.has(once)) {
      seen.add(once);
      if (o.ev.owner_id == null) ppl.forEach((p) => counts[p.id]++);
      else counts[o.ev.owner_id] = (counts[o.ev.owner_id] || 0) + 1;
    }
    (ownersByDay[o.date] ||= new Set()).add(o.ev.owner_id == null ? 'both' : o.ev.owner_id);
  }
  const free = await freeTimes(env, from, to, null);
  const bothBooked = Object.keys(ownersByDay).filter((d) => ppl.every((p) => ownersByDay[d].has(p.id))).sort();
  let busiest = null;
  for (const [d, n] of Object.entries(perDay)) if (!busiest || n > busiest.n || (n === busiest.n && d < busiest.date)) busiest = { date: d, n };
  return {
    from, to,
    counts: ppl.map((p) => ({ id: p.id, name: p.name, n: counts[p.id] || 0 })),
    free: free.map((f) => f.date),
    both_booked: bothBooked,
    busiest,
  };
}

// ---------- free together ----------
function toMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function fromMin(n) { return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`; }

async function freeTimes(env, from, to, wx) {
  const occ = await eventsInRange(env, from, to);
  const byDay = {};
  for (const o of occ) {
    const ev = o.ev;
    const last = o.index === o.span - 1;
    // Middle days of a multi-day event are fully busy; the first runs to midnight, the last from midnight.
    if (ev.all_day || (o.index > 0 && !last)) (byDay[o.date] ||= []).push({ all_day: 1 });
    else if (o.span > 1 && o.index === 0) (byDay[o.date] ||= []).push({ start_time: ev.start_time || '00:00', end_time: '23:59' });
    else if (o.span > 1) (byDay[o.date] ||= []).push({ start_time: '00:00', end_time: ev.end_time || '23:59' });
    else (byDay[o.date] ||= []).push(ev);
  }
  const out = [];
  const today = todayLocal(env.TIMEZONE);
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const evs = byDay[d] || [];
    const weekend = [0, 6].includes(weekday(d));
    const w = wx && wx.days[d] ? { icon: wx.days[d].icon, text: wx.days[d].text, high: wx.days[d].high } : null;
    if (evs.some((e) => e.all_day)) continue;
    if (!evs.length && weekend) { out.push({ date: d, kind: 'day', weekend, after: null, weather: w }); continue; }
    // Evening window 5–10 PM: free if whatever is going on wraps up by 7 PM.
    let latest = 17 * 60;
    let blocked = false;
    for (const e of evs) {
      const s = toMin(e.start_time || '00:00');
      const end = e.end_time ? toMin(e.end_time) : s + 120;
      if (end <= 17 * 60) continue;
      if (s >= 22 * 60) continue;
      if (end > 19 * 60) { blocked = true; break; }
      latest = Math.max(latest, end);
    }
    if (blocked) continue;
    if (d === today && zonedHour(env) >= 21) continue;
    out.push({ date: d, kind: 'evening', weekend, after: fromMin(latest), weather: w });
  }
  return out;
}

function zonedHour(env) {
  return new Date(new Date().toLocaleString('en-US', { timeZone: env.TIMEZONE })).getHours();
}

// ---------- router ----------
export async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '');
  const method = request.method;
  checkOrigin(request);

  // --- public ---
  if (path === '/state' && method === 'GET') {
    const ppl = await people(env);
    const me = ppl.length ? await currentUser(env, request) : null;
    let health = null;
    if (me) {
      const { results: cfg } = await env.DB.prepare("SELECT key, value FROM config WHERE key IN ('cron_last', 'cron_error')").all();
      const c = Object.fromEntries(cfg.map((x) => [x.key, x.value]));
      const first = await env.DB.prepare('SELECT MIN(created_at) AS t FROM users').first();
      const since = c.cron_last ? Number(c.cron_last) : Date.parse((first.t || '').replace(' ', 'T') + 'Z');
      const err = c.cron_error ? safeJson(c.cron_error, null) : null;
      health = {
        stale: Number.isFinite(since) && Date.now() - since > 30 * 60000,
        error: err && Date.now() - err.at < 24 * 3600000 ? err.message : null,
      };
    }
    return json({
      setup_needed: ppl.length === 0,
      health,
      me,
      people: ppl,
      vapid_public: ppl.length ? (await vapidKeys(env)).pub : null,
      today: todayLocal(env.TIMEZONE),
      home: env.HOME_NAME,
    });
  }

  if (path === '/setup' && method === 'POST') {
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    if (count.n > 0) throw new HttpError(403, 'Already set up');
    const body = await readJson(request);
    const ppl = Array.isArray(body.people) ? body.people.slice(0, 2) : [];
    if (ppl.length !== 2) throw new HttpError(400, 'Set up both people');
    for (const p of ppl) {
      if (!str(p.name, 40)) throw new HttpError(400, 'Each person needs a name');
      if (!p.password || String(p.password).length < 6) throw new HttpError(400, 'Passwords need at least 6 characters');
    }
    const colors = ['#2563EB', '#7C3AED'];
    const ids = [];
    for (let i = 0; i < 2; i++) {
      const { hash, salt } = await hashPassword(String(ppl[i].password));
      const r = await env.DB.prepare('INSERT INTO users (name, color, pass_hash, pass_salt) VALUES (?, ?, ?, ?)')
        .bind(str(ppl[i].name, 40), colors[i], hash, salt).run();
      ids.push(r.meta.last_row_id);
    }
    const seed = [
      [ids[0], 'Umpiring', '#2F7D4A', 1], [ids[0], 'Bowling', '#2563EB', 0], [ids[0], 'Ada County USBC', '#0E7490', 0],
      [ids[1], 'Bowling', '#7C3AED', 0], [ids[1], 'Gutter Gussie', '#BE185D', 0],
      [null, 'Date night', '#B45309', 0], [null, 'Family', '#C2410C', 0],
    ];
    await env.DB.batch(seed.map((s, i) =>
      env.DB.prepare('INSERT INTO categories (owner_id, name, color, outdoor, sort) VALUES (?, ?, ?, ?, ?)').bind(s[0], s[1], s[2], s[3], i)));
    const meIndex = body.me === 1 ? 1 : 0;
    const cookie = await createSession(env, ids[meIndex]);
    return json({ ok: true }, 200, { 'set-cookie': cookie });
  }

  if (path === '/login' && method === 'POST') {
    const body = await readJson(request);
    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(Number(body.user_id)).first();
    if (!user || !(await verifyPassword(user, String(body.password || '')))) throw new HttpError(401, "That password didn't match");
    return json({ ok: true }, 200, { 'set-cookie': await createSession(env, user.id) });
  }

  if (path === '/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': await destroySession(env, request) });
  }

  // Local testing only: run the scheduled job as if it were a given time (DEV_TOOLS=1 in .dev.vars).
  if (path === '/dev/cron' && env.DEV_TOOLS === '1') {
    const { runCron } = await import('./cron.js');
    const at = url.searchParams.get('at');
    return json(await runCron(env, ctx, at ? Date.parse(at) : Date.now()));
  }

  // --- signed in ---
  const me = await requireUser(env, request);
  const ppl = await people(env);
  const partner = partnerOf(me, ppl);
  let m;

  if (path === '/password' && method === 'POST') {
    const b = await readJson(request);
    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(me.id).first();
    if (!(await verifyPassword(user, String(b.current || '')))) throw new HttpError(400, "Current password didn't match");
    if (!b.next || String(b.next).length < 6) throw new HttpError(400, 'New password needs at least 6 characters');
    const { hash, salt } = await hashPassword(String(b.next));
    await env.DB.prepare('UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?').bind(hash, salt, me.id).run();
    return json({ ok: true });
  }

  // Live updates: the app polls this; `rev` changes whenever either person changes something.
  if (path === '/rev' && method === 'GET') {
    const [rev, unread] = await Promise.all([
      env.DB.prepare("SELECT value FROM config WHERE key = 'rev'").first(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM activity WHERE user_id = ? AND read_at IS NULL').bind(me.id).first(),
    ]);
    return json({ rev: rev ? rev.value : '0', unread: unread.n });
  }

  // Forgot password: either person can give the other a temporary password.
  if (path === '/partner/reset-password' && method === 'POST') {
    if (!partner) throw new HttpError(400, 'No one else to reset');
    const pw = tempPassword();
    const { hash, salt } = await hashPassword(pw);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?').bind(hash, salt, partner.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(partner.id),
    ]);
    await notify(env, ctx, { to: partner.id, kind: 'password', actorId: me.id, lead: `${me.name} reset your password`, body: 'Sign in with the temporary password they gave you, then change it under Activity → Settings.', feed: true });
    return json({ password: pw, name: partner.name });
  }

  // Backup: everything you can see, as a JSON file.
  if (path === '/export' && method === 'GET') {
    const [events, cats, rems] = await Promise.all([
      env.DB.prepare('SELECT * FROM events ORDER BY date').all(),
      env.DB.prepare('SELECT id, owner_id, name, color, deleted_at FROM categories').all(),
      env.DB.prepare('SELECT * FROM event_reminders').all(),
    ]);
    const visible = events.results.filter((ev) => !isHidden(ev, me));
    const ids = new Set(visible.map((ev) => ev.id));
    const body = JSON.stringify({
      app: 'SpareTime', version: 1, exported_at: new Date().toISOString(), exported_by: me.name,
      people: ppl.map((p) => ({ id: p.id, name: p.name })),
      categories: cats.results,
      events: visible,
      reminders: rems.results.filter((r) => ids.has(r.event_id)),
    }, null, 2);
    return new Response(body, { headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="sparetime-backup-${todayLocal(env.TIMEZONE)}.json"`,
      'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow',
    } });
  }

  // Categories
  if (path === '/categories' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM events e WHERE e.category_id = c.id) AS events
       FROM categories c WHERE c.deleted_at IS NULL ORDER BY c.sort, c.id`
    ).all();
    const { results: defs } = await env.DB.prepare('SELECT category_id, kinds FROM category_reminders WHERE user_id = ?').bind(me.id).all();
    const defMap = new Map(defs.map((d) => [d.category_id, safeJson(d.kinds, null)]));
    return json(results.map((c) => ({
      id: c.id, owner_id: c.owner_id, name: c.name, color: c.color, outdoor: !!c.outdoor, events: c.events,
      can_edit: c.owner_id == null || c.owner_id === me.id,
      my_reminders: defMap.has(c.id) ? defMap.get(c.id) : null,
    })));
  }
  if (path === '/categories' && method === 'POST') {
    const b = await readJson(request);
    const name = str(b.name, 40);
    if (!name) throw new HttpError(400, 'Name the category');
    const color = COLOR_RE.test(b.color || '') ? b.color : '#475569';
    const r = await env.DB.prepare('INSERT INTO categories (owner_id, name, color, outdoor, sort) VALUES (?, ?, ?, ?, 100)')
      .bind(b.shared ? null : me.id, name, color, b.outdoor ? 1 : 0).run();
    return json({ id: r.meta.last_row_id });
  }
  if ((m = path.match(/^\/categories\/(\d+)\/reminders$/)) && method === 'PUT') {
    const c = await env.DB.prepare('SELECT id FROM categories WHERE id = ? AND deleted_at IS NULL').bind(Number(m[1])).first();
    if (!c) throw new HttpError(404, 'Category not found');
    const b = await readJson(request);
    if (b.kinds == null) {
      await env.DB.prepare('DELETE FROM category_reminders WHERE user_id = ? AND category_id = ?').bind(me.id, c.id).run();
      return json({ kinds: null });
    }
    const kinds = cleanKinds(b.kinds);
    await env.DB.prepare(
      'INSERT INTO category_reminders (user_id, category_id, kinds) VALUES (?, ?, ?) ON CONFLICT (user_id, category_id) DO UPDATE SET kinds = excluded.kinds'
    ).bind(me.id, c.id, JSON.stringify(kinds)).run();
    return json({ kinds });
  }

  if ((m = path.match(/^\/categories\/(\d+)(\/restore)?$/))) {
    const c = await env.DB.prepare('SELECT * FROM categories WHERE id = ?').bind(Number(m[1])).first();
    if (!c) throw new HttpError(404, 'Category not found');
    if (c.owner_id != null && c.owner_id !== me.id) throw new HttpError(403, `Only ${partner ? partner.name : 'its owner'} can change that`);
    if (m[2] && method === 'POST') {
      await env.DB.prepare('UPDATE categories SET deleted_at = NULL WHERE id = ?').bind(c.id).run();
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await env.DB.prepare('UPDATE categories SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').bind(c.id).run();
      return json({ ok: true });
    }
    if (method === 'PATCH') {
      const b = await readJson(request);
      const name = b.name != null ? str(b.name, 40) : c.name;
      const color = COLOR_RE.test(b.color || '') ? b.color : c.color;
      const outdoor = b.outdoor != null ? (b.outdoor ? 1 : 0) : c.outdoor;
      await env.DB.prepare('UPDATE categories SET name = ?, color = ?, outdoor = ? WHERE id = ?').bind(name || c.name, color, outdoor, c.id).run();
      return json({ ok: true });
    }
  }

  // Events in a range
  if (path === '/events' && method === 'GET') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '') || to < from) throw new HttpError(400, 'Bad range');
    if (addDays(from, 100) < to) throw new HttpError(400, 'Range too long');
    const cats = await categoryMap(env);
    const occ = await eventsInRange(env, from, to);
    return json(occ.filter((o) => !isHidden(o.ev, me)).map((o) => view(o.ev, o, me, cats, ppl)));
  }

  if (path === '/events' && method === 'POST') {
    const b = await readJson(request);
    const e = await eventInput(env, b, me, ppl);
    const r = await env.DB.prepare(
      `INSERT INTO events (owner_id, category_id, title, date, end_date, start_time, end_time, all_day, location, notes, repeat, repeat_until, visibility, notify_partner, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(e.owner_id, e.category_id, e.title, e.date, e.end_date, e.start_time, e.end_time, e.all_day, e.location, e.notes,
      e.repeat, e.repeat_until, e.visibility, e.notify_partner, me.id).run();
    const id = r.meta.last_row_id;
    const kinds = cleanKinds(b.reminders || (await categoryDefaults(env, me.id, e.category_id)) || ['night']);
    const partnerDefault = async () => (partner && (await categoryDefaults(env, partner.id, e.category_id))) || ['night'];
    if (e.owner_id == null) {
      // Shared: your reminders are yours. The other person gets their own defaults unless you turned that off (e.g. their birthday).
      await setKinds(env, id, me.id, kinds);
      if (partner && b.remind_partner !== false) await setKinds(env, id, partner.id, await partnerDefault());
    } else if (e.owner_id === me.id) {
      await setKinds(env, id, me.id, kinds);
      if (partner && b.partner_night && e.visibility !== 'private') await setKinds(env, id, partner.id, ['night']);
    } else {
      await setKinds(env, id, e.owner_id, await partnerDefault());
    }
    const ev = await loadEvent(env, id);
    if (e.notify_partner && e.visibility !== 'private') {
      const label = e.visibility === 'busy' ? 'a busy block' : e.title;
      for (const to of audience(ev, me, ppl)) {
        await notify(env, ctx, {
          to, pref: 'partner_changes', kind: 'added', actorId: me.id, eventId: id, occDate: e.date,
          lead: `${me.name} added`, body: `${label} · ${whenText(e.date, e.start_time, e.all_day, e.end_date)}${e.repeat !== 'none' ? ` (repeats ${e.repeat})` : ''}`,
          url: `/#/event/${id}/${e.date}`,
        });
      }
    }
    for (let i = 0; i <= Math.min(e.end_date ? daysBetween(e.date, e.end_date) : 0, 6); i++) await checkBothBooked(env, ctx, addDays(e.date, i), ppl);
    return json({ id });
  }

  if ((m = path.match(/^\/events\/(\d+)$/))) {
    const ev = await loadEvent(env, Number(m[1]));
    if (isHidden(ev, me)) throw new HttpError(404, 'Event not found');

    if (method === 'GET') {
      const date = DATE_RE.test(url.searchParams.get('date') || '') ? url.searchParams.get('date') : ev.date;
      const cats = await categoryMap(env);
      const base = view(ev, { start: date, date, index: 0, span: spanDays(ev) + 1 }, me, cats, ppl);
      if (base.masked) return json(base);
      const [reactions, statuses, mine, also, wx] = await Promise.all([
        env.DB.prepare('SELECT r.text, r.created_at, r.user_id, u.name FROM reactions r JOIN users u ON u.id = r.user_id WHERE event_id = ? AND occ_date = ? ORDER BY r.id').bind(ev.id, date).all(),
        env.DB.prepare('SELECT s.status, s.user_id, s.updated_at, u.name FROM statuses s JOIN users u ON u.id = s.user_id WHERE event_id = ? AND occ_date = ?').bind(ev.id, date).all(),
        getKinds(env, ev.id, me.id),
        eventsInRange(env, date, date),
        weatherFor(env, date, ev.all_day ? null : ev.start_time),
      ]);
      let headsUp = null;
      if (partner && ev.owner_id === me.id && ev.visibility !== 'private') {
        headsUp = { notify_partner: !!ev.notify_partner, partner_night: (await getKinds(env, ev.id, partner.id)).includes('night') };
      }
      return json({
        ...base,
        my_reminders: mine,
        heads_up: headsUp,
        partner: partner ? { id: partner.id, name: partner.name } : null,
        reactions: reactions.results,
        statuses: statuses.results,
        also: also.filter((o) => o.ev.id !== ev.id && !isHidden(o.ev, me)).map((o) => view(o.ev, o, me, cats, ppl)),
        series_end_date: ev.end_date,
        weather: wx,
        is_today: date === todayLocal(env.TIMEZONE),
      });
    }

    if (method === 'PUT') {
      if (!canEdit(ev, me)) throw new HttpError(403, "You can't change this event");
      const b = await readJson(request);
      const e = await eventInput(env, b, me, ppl);
      const occ = url.searchParams.get('date');
      let scope = url.searchParams.get('scope');
      if (ev.repeat === 'none' || !DATE_RE.test(occ || '') || (scope === 'future' && occ <= ev.date)) scope = 'all';
      if (scope === 'one' || scope === 'future') {
        // Split the series: the edited occurrence(s) become a new event, the old series skips/ends before them.
        const shift = daysBetween(occ, e.date);
        const newRepeat = scope === 'one' ? 'none' : e.repeat;
        const exdates = scope === 'future' ? JSON.stringify(safeJson(ev.exdates, []).filter((d) => d >= occ).map((d) => addDays(d, shift))) : '[]';
        const r = await env.DB.prepare(
          `INSERT INTO events (owner_id, category_id, title, date, end_date, start_time, end_time, all_day, location, notes, repeat, repeat_until, exdates, visibility, notify_partner, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(e.owner_id, e.category_id, e.title, e.date, e.end_date, e.start_time, e.end_time, e.all_day, e.location, e.notes,
          newRepeat, newRepeat === 'none' ? null : e.repeat_until, exdates, e.visibility, e.notify_partner, ev.created_by).run();
        const newId = r.meta.last_row_id;
        if (scope === 'one') {
          const ex = safeJson(ev.exdates, []);
          if (!ex.includes(occ)) ex.push(occ);
          await env.DB.prepare('UPDATE events SET exdates = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(JSON.stringify(ex), ev.id).run();
          await moveOccurrenceData(env, ev.id, newId, { onlyDate: occ, shift });
        } else {
          await env.DB.prepare('UPDATE events SET repeat_until = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(addDays(occ, -1), ev.id).run();
          await moveOccurrenceData(env, ev.id, newId, { fromDate: occ, shift });
        }
        const { results: rems } = await env.DB.prepare('SELECT user_id, kinds FROM event_reminders WHERE event_id = ?').bind(ev.id).all();
        for (const row of rems) await setKinds(env, newId, row.user_id, row.user_id === me.id && Array.isArray(b.reminders) ? b.reminders : safeJson(row.kinds, []));
        if (Array.isArray(b.reminders) && !rems.some((x) => x.user_id === me.id)) await setKinds(env, newId, me.id, b.reminders);
        if (e.notify_partner && e.visibility !== 'private') {
          for (const to of audience(ev, me, ppl)) {
            await notify(env, ctx, {
              to, pref: 'partner_changes', kind: 'changed', actorId: me.id, eventId: newId, occDate: e.date,
              lead: `${me.name} changed`,
              body: `${e.visibility === 'shared' || e.owner_id == null ? e.title : 'a busy block'} · ${scope === 'one' ? `${whenText(e.date, e.start_time, e.all_day, e.end_date)} (just that day)` : `from ${prettyDate(e.date)} on`}`,
              url: `/#/event/${newId}/${e.date}`,
            });
          }
        }
        await checkBothBooked(env, ctx, e.date, ppl);
        return json({ ok: true, id: newId });
      }
      await env.DB.prepare(
        `UPDATE events SET owner_id=?, category_id=?, title=?, date=?, end_date=?, start_time=?, end_time=?, all_day=?, location=?, notes=?, repeat=?, repeat_until=?,
         visibility=?, notify_partner=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`
      ).bind(e.owner_id, e.category_id, e.title, e.date, e.end_date, e.start_time, e.end_time, e.all_day, e.location, e.notes,
        e.repeat, e.repeat_until, e.visibility, e.notify_partner, ev.id).run();
      if (Array.isArray(b.reminders)) await setKinds(env, ev.id, me.id, b.reminders);
      if (e.notify_partner && !(e.visibility === 'private' && ev.visibility === 'private')) {
        for (const to of audience(ev, me, ppl)) {
          await notify(env, ctx, {
            to, pref: 'partner_changes', kind: 'changed', actorId: me.id, eventId: ev.id, occDate: e.date,
            lead: `${me.name} changed`, body: `${e.visibility === 'shared' || e.owner_id == null ? e.title : 'a busy block'} · ${whenText(e.date, e.start_time, e.all_day, e.end_date)}`,
            url: `/#/event/${ev.id}/${e.date}`,
          });
        }
      }
      for (let i = 0; i <= Math.min(e.end_date ? daysBetween(e.date, e.end_date) : 0, 6); i++) await checkBothBooked(env, ctx, addDays(e.date, i), ppl);
      return json({ ok: true, id: ev.id });
    }

    if (method === 'DELETE') {
      if (!canEdit(ev, me)) throw new HttpError(403, "You can't delete this event");
      const date = url.searchParams.get('date');
      const one = url.searchParams.get('scope') === 'one' && ev.repeat !== 'none' && DATE_RE.test(date || '');
      const future = url.searchParams.get('scope') === 'future' && ev.repeat !== 'none' && DATE_RE.test(date || '') && date > ev.date;
      if (future) {
        await env.DB.prepare('UPDATE events SET repeat_until = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(addDays(date, -1), ev.id).run();
      } else if (one) {
        const ex = safeJson(ev.exdates, []);
        if (!ex.includes(date)) ex.push(date);
        await env.DB.prepare('UPDATE events SET exdates = ? WHERE id = ?').bind(JSON.stringify(ex), ev.id).run();
      } else {
        await env.DB.prepare('DELETE FROM events WHERE id = ?').bind(ev.id).run();
      }
      if (ev.notify_partner && ev.visibility !== 'private') {
        for (const to of audience(ev, me, ppl)) {
          await notify(env, ctx, {
            to, pref: 'partner_changes', kind: 'removed', actorId: me.id,
            lead: `${me.name} removed`,
            body: `${ev.visibility === 'shared' || ev.owner_id == null ? ev.title : 'a busy block'} · ${future ? `from ${prettyDate(date)} on` : one ? `${prettyDate(date)} (just that day)` : whenText(ev.date, ev.start_time, ev.all_day, ev.end_date)}`,
          });
        }
      }
      return json({ ok: true });
    }
  }

  if ((m = path.match(/^\/events\/(\d+)\/(reminders|heads-up|react|status)$/)) && method !== 'GET') {
    const ev = await loadEvent(env, Number(m[1]));
    if (isHidden(ev, me) || !canSeeFully(ev, me)) throw new HttpError(404, 'Event not found');
    const b = await readJson(request);
    const what = m[2];

    if (what === 'reminders') {
      await setKinds(env, ev.id, me.id, b.kinds);
      return json({ kinds: await getKinds(env, ev.id, me.id) });
    }

    if (what === 'heads-up') {
      if (ev.owner_id !== me.id || !partner) throw new HttpError(403, 'Only for your own events');
      if (b.notify_partner != null) await env.DB.prepare('UPDATE events SET notify_partner = ? WHERE id = ?').bind(b.notify_partner ? 1 : 0, ev.id).run();
      if (b.partner_night != null) {
        const k = (await getKinds(env, ev.id, partner.id)).filter((x) => x !== 'night');
        if (b.partner_night) k.unshift('night');
        await setKinds(env, ev.id, partner.id, k);
      }
      return json({ ok: true });
    }

    const date = DATE_RE.test(b.date || '') ? b.date : ev.date;
    if (what === 'react') {
      const text = str(b.text, 140);
      if (!text) throw new HttpError(400, 'Say something');
      await env.DB.prepare('INSERT INTO reactions (event_id, occ_date, user_id, text) VALUES (?, ?, ?, ?)').bind(ev.id, date, me.id, text).run();
      for (const to of audience(ev, me, ppl)) {
        await notify(env, ctx, {
          to, pref: 'reactions', kind: 'reaction', actorId: me.id, eventId: ev.id, occDate: date,
          lead: `${me.name} reacted`, body: `“${text}” to ${ev.title}`, url: `/#/event/${ev.id}/${date}`,
        });
      }
      return json({ ok: true });
    }

    if (what === 'status') {
      if (!b.status) {
        await env.DB.prepare('DELETE FROM statuses WHERE event_id = ? AND occ_date = ? AND user_id = ?').bind(ev.id, date, me.id).run();
        return json({ ok: true });
      }
      if (!['on_way', 'late'].includes(b.status)) throw new HttpError(400, 'Unknown status');
      await env.DB.prepare(
        `INSERT INTO statuses (event_id, occ_date, user_id, status) VALUES (?, ?, ?, ?)
         ON CONFLICT (event_id, occ_date, user_id) DO UPDATE SET status = excluded.status, updated_at = CURRENT_TIMESTAMP`
      ).bind(ev.id, date, me.id, b.status).run();
      for (const to of audience(ev, me, ppl)) {
        await notify(env, ctx, {
          to, pref: 'reactions', kind: 'status', actorId: me.id, eventId: ev.id, occDate: date,
          lead: b.status === 'on_way' ? `${me.name} is on the way` : `${me.name} is running late`,
          body: `${b.status === 'on_way' ? 'to' : 'for'} ${ev.title}`, url: `/#/event/${ev.id}/${date}`,
        });
      }
      return json({ ok: true });
    }
  }

  // Activity, prefs, recap
  if (path === '/activity' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT id, kind, actor_id, event_id, occ_date, lead, body, created_at, read_at FROM activity WHERE user_id = ? ORDER BY id DESC LIMIT 60'
    ).bind(me.id).all();
    const today = todayLocal(env.TIMEZONE);
    return json({
      items: results,
      unread: results.filter((r) => !r.read_at).length,
      prefs: await getPrefs(env, me.id),
      week: await weekSummary(env, today, me, ppl),
    });
  }
  if (path === '/activity/read' && method === 'POST') {
    await env.DB.prepare('UPDATE activity SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND read_at IS NULL').bind(me.id).run();
    return json({ ok: true });
  }
  if (path === '/unread' && method === 'GET') {
    const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM activity WHERE user_id = ? AND read_at IS NULL').bind(me.id).first();
    return json({ unread: r.n });
  }
  if (path === '/prefs' && method === 'PUT') {
    const b = await readJson(request);
    for (const [k, v] of Object.entries(b)) {
      if (!(k in PREF_DEFAULTS)) continue;
      await env.DB.prepare('INSERT INTO prefs (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value')
        .bind(me.id, k, v ? 1 : 0).run();
    }
    return json(await getPrefs(env, me.id));
  }

  // Push subscriptions
  if (path === '/push/subscribe' && method === 'POST') {
    const b = await readJson(request);
    const endpoint = b.endpoint;
    const p256dh = b.keys && b.keys.p256dh;
    const auth = b.keys && b.keys.auth;
    if (!endpoint || !/^https:\/\//.test(endpoint) || !p256dh || !auth) throw new HttpError(400, 'Bad subscription');
    await env.DB.prepare(
      'INSERT INTO push_subs (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth'
    ).bind(me.id, endpoint, p256dh, auth).run();
    return json({ ok: true });
  }
  if (path === '/push/unsubscribe' && method === 'POST') {
    const b = await readJson(request);
    await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').bind(b.endpoint || '', me.id).run();
    return json({ ok: true });
  }
  if (path === '/push/test' && method === 'POST') {
    await pushToUser(env, me.id, { title: 'Notifications are on', body: `You'll hear about ${partner ? partner.name + "'s" : 'new'} plans here.`, url: '/#/activity', tag: 'test' });
    return json({ ok: true });
  }

  // Search titles, places, notes and category names across all visible events.
  if (path === '/search' && method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
    if (q.length < 2) return json([]);
    const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const { results } = await env.DB.prepare(
      `SELECT e.* FROM events e LEFT JOIN categories c ON c.id = e.category_id AND c.deleted_at IS NULL
       WHERE e.title LIKE ?1 ESCAPE '\\' OR e.location LIKE ?1 ESCAPE '\\' OR e.notes LIKE ?1 ESCAPE '\\' OR c.name LIKE ?1 ESCAPE '\\'
       LIMIT 200`
    ).bind(like).all();
    const cats = await categoryMap(env);
    const today = todayLocal(env.TIMEZONE);
    const hits = [];
    for (const ev of results) {
      if (isHidden(ev, me) || !canSeeFully(ev, me)) continue;
      const span = spanDays(ev) + 1;
      let start = ev.date;
      if (ev.repeat !== 'none') {
        const next = occurrences(ev, addDays(today, -(span - 1)), addDays(today, 800))[0];
        if (next) start = next;
        else { const past = occurrences(ev, ev.date, today); start = past[past.length - 1] || ev.date; }
      }
      hits.push(view(ev, { start, date: start, index: 0, span }, me, cats, ppl));
    }
    const upcoming = hits.filter((h) => (h.end_date || h.occ_date) >= today).sort((x, y) => x.occ_date.localeCompare(y.occ_date));
    const past = hits.filter((h) => (h.end_date || h.occ_date) < today).sort((x, y) => y.occ_date.localeCompare(x.occ_date));
    return json({ upcoming: upcoming.slice(0, 40), past: past.slice(0, 40) });
  }

  // Free together + weather
  if (path === '/free' && method === 'GET') {
    const from = todayLocal(env.TIMEZONE);
    const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 21, 1), 60);
    let wx = null;
    try { wx = await forecast(env); } catch { wx = null; }
    return json(await freeTimes(env, from, addDays(from, days - 1), wx));
  }
  if (path === '/weather' && method === 'GET') {
    try {
      const f = await forecast(env);
      return json({ place: f.place, days: f.days });
    } catch {
      return json({ place: env.HOME_NAME, days: {} });
    }
  }

  throw new HttpError(404, 'Not found');
}

// Shared helpers: responses, encoding, dates in the app's time zone, repeat expansion, formatting.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', ...headers },
  });
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'Expected a JSON body');
  }
}

// ---------- base64url ----------
export function b64urlEncode(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 32) {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return b64urlEncode(d);
}

// ---------- validation ----------
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function str(v, max = 200) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

// ---------- dates (plain YYYY-MM-DD strings, computed in UTC to avoid DST drift) ----------
export function parseDate(d) {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}
export function fmtDate(dt) {
  return dt.toISOString().slice(0, 10);
}
export function addDays(d, n) {
  const dt = parseDate(d);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fmtDate(dt);
}
export function weekday(d) {
  return parseDate(d).getUTCDay(); // 0 = Sunday
}
export function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}

// Local wall-clock parts for an instant in a time zone.
export function zonedParts(tz, instant = new Date()) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(instant).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

function tzOffsetMs(tz, utcMs) {
  const p = zonedParts(tz, new Date(utcMs));
  const [y, m, d] = p.date.split('-').map(Number);
  const asUtc = Date.UTC(y, m - 1, d, p.hour, p.minute);
  return asUtc - Math.floor(utcMs / 60000) * 60000;
}

// UTC milliseconds for a local date + 'HH:MM' in the time zone.
export function zonedToUtc(tz, date, time = '00:00') {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ts = guess - tzOffsetMs(tz, guess);
  ts = guess - tzOffsetMs(tz, ts); // second pass settles DST edges
  return ts;
}

export function todayLocal(tz) {
  return zonedParts(tz).date;
}

// ---------- repeating events ----------
// Returns the dates (YYYY-MM-DD) an event occurs on within [from, to].
export function occurrences(ev, from, to) {
  const ex = new Set(safeJson(ev.exdates, []));
  const until = ev.repeat_until && ev.repeat_until < to ? ev.repeat_until : to;
  const out = [];
  const push = (d) => { if (d >= from && d <= until && !ex.has(d)) out.push(d); };
  if (!ev.repeat || ev.repeat === 'none') {
    if (ev.date >= from && ev.date <= to && !ex.has(ev.date)) out.push(ev.date);
    return out;
  }
  if (ev.date > until) return out;
  if (ev.repeat === 'monthly') {
    const start = parseDate(ev.date);
    const dom = start.getUTCDate();
    for (let i = 0; i < 240; i++) {
      const dt = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, dom));
      if (dt.getUTCDate() !== dom) continue; // skip months without that day
      const d = fmtDate(dt);
      if (d > until) break;
      push(d);
    }
    return out;
  }
  const step = ev.repeat === 'daily' ? 1 : ev.repeat === 'biweekly' ? 14 : 7;
  let d = ev.date;
  if (d < from) {
    const jumps = Math.floor(daysBetween(d, from) / step);
    d = addDays(d, jumps * step);
  }
  for (let i = 0; i < 2000 && d <= until; i++, d = addDays(d, step)) push(d);
  return out;
}

export function safeJson(text, fallback) {
  try {
    const v = JSON.parse(text);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

// ---------- formatting for notifications ----------
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function prettyDate(d) {
  const dt = parseDate(d);
  return `${DOW[dt.getUTCDay()]}, ${MON[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
}
export function prettyTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
}
export function whenText(date, time, allDay) {
  return allDay || !time ? prettyDate(date) : `${prettyDate(date)} at ${prettyTime(time)}`;
}

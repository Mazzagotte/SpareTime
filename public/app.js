// SpareTime front end — a small single-page app, no build step.
import { parseQuick } from './quickadd.js';
import { holidaysBetween } from './holidays.js';

const $app = document.getElementById('app');
const $overlay = document.getElementById('overlay');
const $toast = document.getElementById('toast');

const S = {
  loaded: false, setup_needed: false, me: null, people: [], partner: null, today: '', vapid: null, home: '',
  cats: [], unread: 0, filter: localStorage.getItem('st-filter') || 'both',
  holidays: localStorage.getItem('st-holidays') || 'all', // all | federal | off
  monthSel: null, monthCache: null, agendaFrom: null, base: '#/month', sheetPushed: false,
};

// ---------------------------------------------------------------- helpers
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dt = (d) => { const [y, m, day] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, day)); };
const iso = (x) => x.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = dt(d); x.setUTCDate(x.getUTCDate() + n); return iso(x); };
const dow = (d) => dt(d).getUTCDay();
const daysBetween = (a, b) => Math.round((dt(b) - dt(a)) / 86400000);
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
function prettyDate(d, long = false) {
  const x = dt(d);
  return `${long ? DOW[x.getUTCDay()] : DOW[x.getUTCDay()].slice(0, 3)}, ${long ? MON[x.getUTCMonth()] : MON[x.getUTCMonth()].slice(0, 3)} ${x.getUTCDate()}`;
}
function prettyTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`;
}
function timeText(e) {
  if (e.span > 1) return `${prettyDate(e.occ_date)} – ${prettyDate(e.end_date)}`;
  if (e.all_day) return 'All day';
  return e.end_time ? `${prettyTime(e.start_time)} – ${prettyTime(e.end_time)}` : prettyTime(e.start_time);
}
// For one day of a multi-day event: "Day 2 of 3 · ends 6:00 PM".
function spanText(e) {
  const last = e.day_index === e.span - 1;
  const t = e.all_day ? '' : e.day_index === 0 && e.start_time ? ` · starts ${prettyTime(e.start_time)}` : last && e.end_time ? ` · ends ${prettyTime(e.end_time)}` : '';
  return `Day ${e.day_index + 1} of ${e.span}${t}`;
}
const dayOf = (e) => e.day || e.occ_date;
function relDay(d) {
  const n = daysBetween(S.today, d);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  return prettyDate(d);
}
function ago(utc) {
  const t = new Date(utc.replace(' ', 'T') + 'Z');
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return t.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
const person = (id) => S.people.find((p) => p.id === id);
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const I = {
  left: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  right: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
  cal: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="3"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  list: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  bell: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
  plus: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  plusSm: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  users: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  clock: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  pin: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>',
  note: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8"/></svg>',
  heart: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z"/></svg>',
  trash: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>',
  bolt: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
  import: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
  check: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  share: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="m16 6-4-4-4 4"/><path d="M12 2v13"/></svg>',
  search: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  flag: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 22V4"/><path d="M4 4h13l-2 4 2 4H4"/></svg>',
  car: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 17h14v-5l-2-5H7l-2 5z"/><circle cx="7.5" cy="17.5" r="1.5"/><circle cx="16.5" cy="17.5" r="1.5"/></svg>',
  wx: {
    sun: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    partly: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v2M4.9 4.9l1.4 1.4M2 12h2M19.1 4.9l-1.4 1.4"/><path d="M15.9 9.6A4 4 0 1 0 8.1 11"/><path d="M17 20H9a4 4 0 1 1 .9-7.9A5 5 0 0 1 19 15a2.5 2.5 0 0 1-2 5Z"/></svg>',
    cloud: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9Z"/></svg>',
    rain: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2"/><path d="M16 14v6M8 14v6M12 16v6"/></svg>',
    snow: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2"/><path d="M8 15h.01M8 19h.01M12 17h.01M12 21h.01M16 15h.01M16 19h.01"/></svg>',
    storm: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16.3A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 .5 9"/><path d="m13 12-3 5h4l-3 5"/></svg>',
  },
};

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method, credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Can't reach SpareTime — check your connection");
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (res.status === 401 && !path.startsWith('/login')) {
    S.me = null;
    route();
    throw new Error('Please sign in again');
  }
  if (!res.ok) throw new Error((data && data.error) || 'Something went wrong');
  return data;
}

let toastTimer;
function toast(msg, { action, onAction, ms = 3200 } = {}) {
  clearTimeout(toastTimer);
  $toast.innerHTML = `<div class="inner"><span>${esc(msg)}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}</div>`;
  $toast.classList.add('show');
  if (action) $toast.querySelector('button').onclick = () => { $toast.classList.remove('show'); onAction && onAction(); };
  toastTimer = setTimeout(() => $toast.classList.remove('show'), ms);
}
const fail = (e) => toast(e.message || 'Something went wrong');

function holidayRows(list) {
  return (list || []).map((h) => `<div class="holiday-row">${I.flag}<span><b>${esc(h.name)}</b>${h.federal ? ' · Federal holiday' : ''}</span></div>`).join('');
}

function on(root, sel, evt, fn) {
  root.querySelectorAll(sel).forEach((el) => el.addEventListener(evt, (e) => fn(e, el)));
}

function avatar(e, cls = '') {
  if (e.owner_id == null) {
    const ini = S.people.map((p) => p.name[0]).join('+');
    return `<span class="avatar both ${cls}" aria-hidden="true" style="background:${esc(e.category.color)}">${esc(ini)}</span>`;
  }
  const p = person(e.owner_id);
  return `<span class="avatar ${cls}" aria-hidden="true" style="background:${esc(e.category.color)}">${esc(p ? p.name[0] : '?')}</span>`;
}

function evCard(e, { showTime = false } = {}) {
  const multi = e.span > 1;
  const when = multi ? spanText(e) : timeText(e);
  const meta = e.masked
    ? `${e.owner_name} · Private`
    : [showTime && !multi ? null : when, e.owner_name, e.category.name !== 'Other' ? e.category.name : null].filter(Boolean).join(' · ');
  const right = multi ? `${e.day_index + 1}/${e.span}` : e.all_day ? 'All day' : prettyTime(e.start_time);
  const inner = `${avatar(e)}<span class="grow"><span class="t">${esc(e.title)}</span><span class="s">${esc(meta)}</span></span>${showTime ? `<span class="time">${esc(right)}</span>` : `<span style="color:var(--muted)">${I.right}</span>`}`;
  if (e.masked) return `<div class="evcard">${inner}</div>`;
  return `<a class="evcard" href="#/event/${e.id}/${e.occ_date}">${inner}</a>`;
}

function navHtml(active) {
  const tab = (key, href, icon, label) =>
    `<a href="${href}" ${active === key ? 'aria-current="page"' : ''}>${icon}${label}${key === 'activity' && S.unread && active !== 'activity' ? `<span class="badge" aria-label="${S.unread} unread">${S.unread > 9 ? '9+' : S.unread}</span>` : ''}</a>`;
  return `<div class="navwrap"><nav class="nav" aria-label="Main">${tab('month', '#/month', I.cal, 'Month')}${tab('agenda', '#/agenda', I.list, 'Agenda')}${tab('activity', '#/activity', I.bell, 'Activity')}</nav>
    <a class="fab" href="#/add" aria-label="Add event">${I.plus}</a></div>`;
}

function setScreen(html) {
  $app.innerHTML = html;
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- boot & routing
async function loadState() {
  const st = await api('/state');
  S.loaded = true;
  S.setup_needed = st.setup_needed;
  S.me = st.me;
  S.people = st.people;
  S.partner = st.me ? st.people.find((p) => p.id !== st.me.id) || null : null;
  S.today = st.today;
  S.vapid = st.vapid_public;
  S.home = st.home;
  if (S.me) {
    const [cats] = await Promise.all([api('/categories'), refreshUnread()]);
    S.cats = cats;
    syncPush();
  }
}

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [p, q] = h.split('?');
  return { parts: p.split('/').filter(Boolean), q: new URLSearchParams(q || '') };
}

let routing = Promise.resolve();
function route() {
  routing = routing.then(doRoute).catch(fail);
  return routing;
}

async function doRoute() {
  if (!S.loaded) await loadState();
  if (S.setup_needed) { $overlay.innerHTML = ''; return viewSetup(); }
  if (!S.me) { $overlay.innerHTML = ''; return viewLogin(); }
  const { parts, q } = parseHash();
  const [view, a, b] = parts;
  if (view === 'add' || view === 'edit') {
    if (!$app.querySelector('.screen')) await renderBase(S.base);
    return openEventSheet(view === 'edit' ? Number(a) : null, b, q);
  }
  $overlay.innerHTML = '';
  S.sheetPushed = false;
  if (view === 'search' && S.base && !S.base.startsWith('#/search') && !S.base.startsWith('#/event')) S.searchBack = S.base;
  S.base = location.hash || '#/month';
  return renderBase(S.base);
}

async function renderBase(hash) {
  const parts = hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
  const [view, a, b] = parts;
  switch (view) {
    case 'agenda': return viewAgenda();
    case 'event': return viewEvent(Number(a), b);
    case 'activity': return viewActivity();
    case 'categories': return viewCategories();
    case 'free': return viewFree();
    case 'search': return viewSearch();
    default: return viewMonth(isDate(a) ? a : null);
  }
}

window.addEventListener('hashchange', () => { S.hops = (S.hops || 0) + 1; route(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.me) {
    refreshUnread();
    if (/^#\/(month|agenda|activity)?/.test(location.hash) && !$overlay.innerHTML) route();
  }
});

async function refreshUnread() {
  try {
    const r = await api('/unread');
    S.unread = r.unread;
    const badge = document.querySelector('.nav a[href="#/activity"]');
    if (badge && !badge.hasAttribute('aria-current')) {
      const old = badge.querySelector('.badge');
      if (old) old.remove();
      if (S.unread) badge.insertAdjacentHTML('beforeend', `<span class="badge" aria-label="${S.unread} unread">${S.unread > 9 ? '9+' : S.unread}</span>`);
    }
    if (navigator.setAppBadge) S.unread ? navigator.setAppBadge(S.unread).catch(() => {}) : navigator.clearAppBadge().catch(() => {});
  } catch { /* offline */ }
}

// ---------------------------------------------------------------- setup & sign in
function viewSetup() {
  setScreen(`<form class="welcome" id="setup">
    <div class="hero"><img src="/icons/icon-512.png" alt="SpareTime app icon"><h1>SpareTime</h1><p class="lead">One calendar for the two of you. Let's set up you both.</p></div>
    <div class="card" style="padding:16px;display:flex;flex-direction:column;gap:12px">
      <div class="field"><label class="lbl" for="n1">First person's name</label><input class="input" id="n1" required autocomplete="off" value="James"></div>
      <div class="field"><label class="lbl" for="p1">Their password</label><input class="input" id="p1" type="password" required minlength="6" autocomplete="new-password"></div>
    </div>
    <div class="card" style="padding:16px;display:flex;flex-direction:column;gap:12px">
      <div class="field"><label class="lbl" for="n2">Second person's name</label><input class="input" id="n2" required autocomplete="off" value="Kelsey"></div>
      <div class="field"><label class="lbl" for="p2">Their password <span style="font-weight:400">(they can change it later)</span></label><input class="input" id="p2" type="password" required minlength="6" autocomplete="new-password"></div>
    </div>
    <div class="field"><span class="lbl" id="who-lbl">Who's using this phone?</span><div class="seg" role="group" aria-labelledby="who-lbl"><button type="button" aria-pressed="true" data-me="0" id="me0">First person</button><button type="button" aria-pressed="false" data-me="1" id="me1">Second person</button></div></div>
    <p class="error" id="err" hidden></p>
    <button class="btn" type="submit">Create our calendar</button>
  </form>`);
  let me = 0;
  const sync = () => {
    $app.querySelector('#me0').textContent = $app.querySelector('#n1').value || 'First person';
    $app.querySelector('#me1').textContent = $app.querySelector('#n2').value || 'Second person';
  };
  sync();
  on($app, '#n1, #n2', 'input', sync);
  on($app, '[data-me]', 'click', (e, el) => {
    me = Number(el.dataset.me);
    $app.querySelectorAll('[data-me]').forEach((b) => b.setAttribute('aria-pressed', String(b === el)));
  });
  $app.querySelector('#setup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await api('/setup', { method: 'POST', body: { me, people: [
        { name: $app.querySelector('#n1').value, password: $app.querySelector('#p1').value },
        { name: $app.querySelector('#n2').value, password: $app.querySelector('#p2').value },
      ] } });
      S.loaded = false;
      location.hash = '#/month';
      route();
    } catch (err) {
      const el = $app.querySelector('#err'); el.textContent = err.message; el.hidden = false; btn.disabled = false;
    }
  });
}

function installTip() {
  if (!isIOS || standalone) return '';
  return `<div class="banner info">${I.share}<span>On iPhone, tap <b>Share</b>, then <b>Add to Home Screen</b>, and open SpareTime from there so notifications can reach you.</span></div>`;
}

function viewLogin() {
  let who = Number(localStorage.getItem('st-last-user')) || (S.people[0] && S.people[0].id);
  setScreen(`<form class="welcome" id="login">
    <div class="hero"><img src="/icons/icon-512.png" alt="SpareTime app icon"><h1>SpareTime</h1><p class="lead">One calendar for the two of you.</p></div>
    <div class="who" role="group" aria-label="Who are you?">${S.people.map((p) => `<button type="button" data-id="${p.id}" aria-pressed="${p.id === who}"><span class="avatar round" style="background:${esc(p.color)}" aria-hidden="true">${esc(p.name[0])}</span>${esc(p.name)}</button>`).join('')}</div>
    <div class="field"><label class="lbl" for="pw">Password</label><input class="input" id="pw" type="password" required autocomplete="current-password"></div>
    <p class="error" id="err" hidden></p>
    <div class="spacer"></div>
    ${installTip()}
    <button class="btn" type="submit">Sign in</button>
  </form>`);
  on($app, '.who button', 'click', (e, el) => {
    who = Number(el.dataset.id);
    $app.querySelectorAll('.who button').forEach((b) => b.setAttribute('aria-pressed', String(b === el)));
    $app.querySelector('#pw').focus();
  });
  $app.querySelector('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/login', { method: 'POST', body: { user_id: who, password: $app.querySelector('#pw').value } });
      localStorage.setItem('st-last-user', who);
      S.loaded = false;
      if (!location.hash) location.hash = '#/month';
      route();
    } catch (err) {
      const el = $app.querySelector('#err'); el.textContent = err.message; el.hidden = false;
    }
  });
}

// ---------------------------------------------------------------- month
function filterEvents(list) {
  if (S.filter === 'me') return list.filter((e) => e.owner_id == null || e.owner_id === S.me.id);
  if (S.filter === 'partner') return list.filter((e) => e.owner_id == null || (S.partner && e.owner_id === S.partner.id));
  return list;
}

async function viewMonth(dateParam) {
  const sel = dateParam || S.monthSel || S.today;
  S.monthSel = sel;
  const first = sel.slice(0, 8) + '01';
  const start = addDays(first, -dow(first));
  const dim = new Date(Date.UTC(Number(sel.slice(0, 4)), Number(sel.slice(5, 7)), 0)).getUTCDate();
  const weeks = Math.ceil((dow(first) + dim) / 7);
  const end = addDays(start, weeks * 7 - 1);
  let events = S.monthCache && S.monthCache.key === start + end ? S.monthCache.events : null;
  if (!events) {
    renderMonth(sel, start, weeks, [], true);
    events = await api(`/events?from=${start}&to=${end}`);
    S.monthCache = { key: start + end, events };
  }
  renderMonth(sel, start, weeks, events, false);
}

function renderMonth(sel, start, weeks, all, loading) {
  const events = filterEvents(all);
  const month = sel.slice(0, 7);
  const byDay = {};
  for (const e of events) (byDay[dayOf(e)] ||= []).push(e);
  const hol = holidaysBetween(start, addDays(start, weeks * 7 - 1), S.holidays);
  const yr = sel.slice(0, 4) !== S.today.slice(0, 4) ? ` ${sel.slice(0, 4)}` : '';
  let cells = '';
  for (let i = 0; i < weeks * 7; i++) {
    const d = addDays(start, i);
    const evs = byDay[d] || [];
    const cls = ['day', d.slice(0, 7) !== month && 'out', d === S.today && 'today', d === sel && 'sel'].filter(Boolean).join(' ');
    const h = hol[d] || [];
    const room = h.length ? 1 : 2;
    const bars = (h.length ? `<span class="bar holiday">${esc(h[0].name.replace(' (observed)', ''))}</span>` : '')
      + evs.slice(0, room).map((e) => {
        if (!(e.span > 1)) return `<span class="bar" style="background:${esc(e.category.color)}">${esc(e.masked ? 'Busy' : e.title)}</span>`;
        const wd = dow(d);
        const cls = [e.day_index > 0 && wd !== 0 && 'cont-l', e.day_index < e.span - 1 && wd !== 6 && 'cont-r'].filter(Boolean).join(' ');
        const label = e.day_index === 0 || wd === 0 ? (e.masked ? 'Busy' : e.title) : '\u00a0';
        return `<span class="bar ${cls}" style="background:${esc(e.category.color)}">${esc(label)}</span>`;
      }).join('');
    const more = evs.length > room ? `<span class="more">+${evs.length - room}</span>` : '';
    cells += `<button class="${cls}" data-date="${d}" aria-label="${prettyDate(d, true)}${h.length ? ', ' + esc(h.map((x) => x.name).join(', ')) : ''}, ${evs.length} event${evs.length === 1 ? '' : 's'}${d === S.today ? ', today' : ''}"><span class="n">${Number(d.slice(8))}</span>${bars}${more}</button>`;
  }
  const dayEvents = byDay[sel] || [];
  const owners = new Set(dayEvents.filter((e) => e.owner_id != null).map((e) => e.owner_id));
  const both = S.filter === 'both' && S.partner && owners.has(S.me.id) && owners.has(S.partner.id);
  const seg = [['both', 'Both'], ['me', S.me.name], ['partner', S.partner ? S.partner.name : 'Partner']];
  setScreenKeep(`<main class="screen">
    <header class="head">
      <div><p class="kicker"><img src="/icons/mark.png" alt="">${esc(S.people.map((p) => p.name).join(' & '))}</p><h1 class="title">${MON[Number(sel.slice(5, 7)) - 1]}${yr}</h1></div>
      <div style="display:flex;gap:8px"><a class="circle" href="#/search" aria-label="Search" style="color:var(--text)">${I.search}</a><button class="circle" data-nav="-1" aria-label="Previous month">${I.left}</button><button class="circle" data-nav="1" aria-label="Next month">${I.right}</button></div>
    </header>
    <div class="seg" role="group" aria-label="Whose events to show">${seg.map(([k, l]) => `<button data-filter="${k}" aria-pressed="${S.filter === k}">${esc(l)}</button>`).join('')}</div>
    <section class="cal" aria-label="${MON[Number(sel.slice(5, 7)) - 1]} calendar" ${loading ? 'aria-busy="true"' : ''}>
      <div class="cal-dow" aria-hidden="true">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((x) => `<span>${x}</span>`).join('')}</div>
      <div class="cal-grid">${cells}</div>
    </section>
    <section class="section" style="margin-top:4px">
      <div class="section-head"><h2 style="font-size:19px;font-weight:700">${prettyDate(sel, true).replace(/^(\w+), (\w+)/, (m, a, b) => `${a}, ${b.slice(0, 3)}`)}</h2><span class="muted">${dayEvents.length === 1 ? '1 event' : `${dayEvents.length} events`}</span></div>
      ${holidayRows(hol[sel])}
      ${both ? `<div class="banner warn">${I.users}You're both booked this day</div>` : ''}
      ${dayEvents.map((e) => evCard(e)).join('')}
      ${!dayEvents.length && !loading ? `<div class="empty">Nothing on the calendar.<a class="btn small" href="#/add?date=${sel}">${I.plusSm} Add something</a></div>` : ''}
    </section>
  </main>${navHtml('month')}`);

  on($app, '[data-date]', 'click', (e, el) => {
    history.replaceState(null, '', `#/month/${el.dataset.date}`);
    S.base = location.hash;
    viewMonth(el.dataset.date).catch(fail);
  });
  on($app, '[data-nav]', 'click', (e, el) => shiftMonth(Number(el.dataset.nav)));
  on($app, '[data-filter]', 'click', (e, el) => {
    S.filter = el.dataset.filter;
    localStorage.setItem('st-filter', S.filter);
    viewMonth(S.monthSel).catch(fail);
  });
  const cal = $app.querySelector('.cal');
  let x0 = null;
  cal.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  cal.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0;
    x0 = null;
    if (Math.abs(dx) > 60) shiftMonth(dx < 0 ? 1 : -1);
  });
}

function shiftMonth(n) {
  const [y, m] = S.monthSel.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const d = iso(target);
  const pick = d.slice(0, 7) === S.today.slice(0, 7) ? S.today : d;
  history.replaceState(null, '', `#/month/${pick}`);
  S.base = location.hash;
  viewMonth(pick).catch(fail);
}

// Re-render without jumping scroll position (used for in-place updates).
function setScreenKeep(html) {
  const y = window.scrollY;
  $app.innerHTML = html;
  window.scrollTo(0, y);
}

// ---------------------------------------------------------------- agenda
async function viewAgenda() {
  const from = S.today;
  const to = addDays(from, 44);
  const events = await api(`/events?from=${from}&to=${to}`);
  const start = S.agendaFrom && S.agendaFrom >= from ? S.agendaFrom : from;
  const byDay = {};
  for (const e of events) (byDay[dayOf(e)] ||= []).push(e);
  const hol = holidaysBetween(from, to, S.holidays);

  const upcoming = events.filter((e) => !e.masked && (e.occ_date > from || (!e.all_day && e.start_time)));
  const big = upcoming.find((e) => /tourn|tourney|game|ump|trip/i.test(e.title) && e.occ_date > from && !(e.day_index > 0)) || null;
  let countdown = '';
  if (big) {
    const n = daysBetween(from, big.occ_date);
    countdown = `<a class="countdown" href="#/event/${big.id}/${big.occ_date}" style="background:${esc(big.category.color)};box-shadow:0 10px 24px ${esc(big.category.color)}47">
      <span class="grow"><span class="k">Next big event</span><span class="t">${esc(big.title)}</span><span class="s">${prettyDate(big.occ_date)} · ${esc(timeText(big))} · ${esc(big.owner_name)}</span></span>
      <span class="num"><b>${n}</b><span>${n === 1 ? 'day' : 'days'}</span></span></a>`;
  }

  let strip = '';
  for (let i = 0; i < 21; i++) {
    const d = addDays(from, i);
    const evs = byDay[d] || [];
    strip += `<button data-day="${d}" aria-pressed="${d === start}" aria-label="${prettyDate(d, true)}${i === 0 ? ', today' : ''}, ${evs.length} events"><span class="w">${DOW[dow(d)].slice(0, 3)}</span><span class="n">${Number(d.slice(8))}</span><span class="dots">${evs.slice(0, 3).map((e) => `<i style="background:${esc(e.category.color)}"></i>`).join('')}</span></button>`;
  }

  let groups = '';
  for (let i = 0; i < 14; i++) {
    const d = addDays(start, i);
    const evs = byDay[d] || [];
    if (!evs.length && !hol[d]) continue;
    const owners = new Set(evs.filter((e) => e.owner_id != null).map((e) => e.owner_id));
    const both = S.partner && owners.has(S.me.id) && owners.has(S.partner.id);
    groups += `<section class="section"><div class="section-head"><h2 class="h2">${daysBetween(S.today, d) <= 1 && daysBetween(S.today, d) >= 0 ? relDay(d) + ' · ' : ''}${prettyDate(d)}</h2>${both ? '<span class="tag">Both booked</span>' : ''}</div>${holidayRows(hol[d])}${evs.map((e) => evCard(e, { showTime: true })).join('')}</section>`;
  }

  setScreen(`<main class="screen">
    <header class="head"><div><p class="kicker">Next two weeks</p><h1 class="title">Coming up</h1></div>
      <div style="display:flex;gap:8px;align-items:center"><a class="circle" href="#/search" aria-label="Search" style="color:var(--text)">${I.search}</a><a class="pill amber" href="#/free">${I.heart}Free together</a></div></header>
    ${countdown}
    <div class="strip" role="group" aria-label="Start from day">${strip}</div>
    ${groups || `<div class="empty">Nothing in the next two weeks. Enjoy the quiet.<a class="btn small" href="#/add">${I.plusSm} Add something</a></div>`}
  </main>${navHtml('agenda')}`);
  on($app, '[data-day]', 'click', (e, el) => { S.agendaFrom = el.dataset.day; viewAgenda().catch(fail); });
  const selBtn = $app.querySelector('.strip [aria-pressed="true"]');
  if (selBtn) selBtn.scrollIntoView({ inline: 'center', block: 'nearest' });
}

// ---------------------------------------------------------------- event detail
const KIND_LABELS = { night: 'Night before', morning: 'Morning of', hour: '1 hour before' };
const kindLabel = (k) => KIND_LABELS[k] || (k < 60 ? `${k} min before` : `${Math.round(k / 60)} hr before`);

async function viewEvent(id, date) {
  const e = await api(`/events/${id}${isDate(date) ? `?date=${date}` : ''}`);
  const back = `<a class="textbtn" href="#/month/${e.occ_date}" data-back>${I.left}${MON[Number(e.occ_date.slice(5, 7)) - 1]}</a>`;
  if (e.masked) {
    setScreen(`<main class="screen no-nav"><div class="topbar">${back}</div>
      <h1 class="title">Busy</h1><p class="muted">${esc(e.owner_name)} marked this time as busy. ${esc(e.span > 1 ? '' : prettyDate(e.occ_date, true) + ' · ')}${esc(timeText(e))}</p></main>`);
    return bindBack();
  }
  const mine = e.owner_id === S.me.id;
  const other = S.partner ? S.partner.name : 'them';
  const dirs = e.location ? (isIOS ? `https://maps.apple.com/?q=${encodeURIComponent(e.location)}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(e.location)}`) : null;
  const wx = e.weather;
  const repeatText = { daily: 'Repeats every day', weekly: 'Repeats every week', biweekly: 'Repeats every 2 weeks', monthly: 'Repeats every month', yearly: 'Repeats every year' }[e.repeat];
  const multi = e.span > 1;
  const whenTitle = multi ? `${prettyDate(e.occ_date)} – ${prettyDate(e.end_date)}` : prettyDate(e.occ_date, true);
  const whenSub = multi
    ? [e.all_day ? `${e.span} days` : null, !e.all_day && e.start_time ? `Starts ${prettyTime(e.start_time)}` : null, !e.all_day && e.end_time ? `ends ${prettyTime(e.end_time)}` : null, e.all_day ? null : `${e.span} days`].filter(Boolean).join(' · ')
    : timeText(e);
  const myStatus = (e.statuses.find((s) => s.user_id === S.me.id) || {}).status;
  const theirStatus = e.statuses.filter((s) => s.user_id !== S.me.id);
  const replies = mine ? ['Thank you!', 'Love you', 'Wish me luck'] : ['Good luck!', 'Have fun', 'Proud of you', 'Love you'];
  const catTint = `background:${esc(e.category.color)}22;color:var(--text)`;

  setScreen(`<main class="screen no-nav">
    <div class="topbar">${back}${e.can_edit ? `<a class="textbtn strong" href="#/edit/${e.id}/${e.occ_date}">Edit</a>` : ''}</div>
    <div style="display:flex;flex-direction:column;gap:10px">
      <span class="catpill" style="${catTint}"><span class="dot" style="background:${esc(e.category.color)};width:8px;height:8px"></span>${esc(e.owner_name)} · ${esc(e.category.name)}</span>
      <h1 class="title">${esc(e.title)}</h1>
      ${e.visibility !== 'shared' && mine ? `<p class="muted">${e.visibility === 'busy' ? `${esc(other)} sees this as “Busy”` : 'Only you can see this'}</p>` : ''}
    </div>
    <div class="card rows">
      <div class="row">${I.clock}<span class="grow"><span class="t">${esc(whenTitle)}</span><span class="s">${esc(whenSub)}${repeatText ? ` · ${repeatText}` : ''}</span></span></div>
      ${wx ? `<div class="row" style="color:var(--sub)">${I.wx[wx.icon] || I.wx.cloud}<span class="grow"><span class="t" style="color:var(--text)">${esc(wx.text)} · ${wx.temp != null ? wx.temp : wx.high}°</span><span class="s">${wx.temp != null ? `Forecast at ${prettyTime(e.start_time)} in ${esc(wx.place)}` : `High ${wx.high}° · Low ${wx.low}° in ${esc(wx.place)}`}${wx.precip >= 30 ? ` · ${wx.precip}% chance of precipitation` : ''}</span></span></div>` : ''}
      ${e.location ? `<a class="row" href="${dirs}" target="_blank" rel="noopener">${I.pin}<span class="grow"><span class="t">${esc(e.location)}</span><span class="s" style="color:var(--link);font-weight:600">Get directions</span></span></a>` : ''}
      ${e.notes ? `<div class="row" style="align-items:flex-start">${I.note}<span class="grow"><span class="s" style="color:var(--text);white-space:pre-wrap;font-size:15px">${esc(e.notes)}</span></span></div>` : ''}
    </div>

    ${theirStatus.map((s) => `<div class="banner ${s.status === 'late' ? 'warn' : 'ok'}">${I.car}${esc(s.name)} ${s.status === 'late' ? 'is running late' : 'is on the way'} · ${esc(ago(s.updated_at))}</div>`).join('')}

    ${e.is_today ? `<section class="section"><h2 class="h2">On the day</h2>
      <div class="status-row"><button class="way" data-status="on_way" aria-pressed="${myStatus === 'on_way'}">${I.car}On my way</button><button class="late" data-status="late" aria-pressed="${myStatus === 'late'}">${I.clock}Running late</button></div>
      <span class="muted">One tap lets ${esc(other)} know.</span></section>` : ''}

    <section class="section"><h2 class="h2">${e.reactions.length ? 'Messages' : `Send ${mine ? 'a note' : 'some love'}`}</h2>
      ${e.reactions.map((r) => `<div class="reaction ${r.user_id === S.me.id ? 'mine' : ''}">${r.user_id === S.me.id ? '' : `<span class="avatar round" style="background:${esc((person(r.user_id) || {}).color || '#7C3AED')};width:32px;height:32px;font-size:13px" aria-hidden="true">${esc(r.name[0])}</span>`}<div class="bubble ${r.user_id === S.me.id ? 'mine' : ''}"><span style="font-size:15px;font-weight:600">${esc(r.text)}</span><span class="muted" style="font-size:12px">${r.user_id === S.me.id ? 'You' : esc(r.name)} · ${esc(ago(r.created_at))}</span></div></div>`).join('')}
      <div class="chips">${replies.map((t) => `<button class="chip" data-react="${esc(t)}">${esc(t)}</button>`).join('')}</div>
      <form class="inline-form" id="react-form"><label class="sr" for="react-text">Write a message</label><input class="input" id="react-text" placeholder="Write something…" maxlength="140" style="height:44px"><button class="btn small" type="submit">Send</button></form>
    </section>

    <section class="section"><h2 class="h2">Remind me</h2>
      <div class="chips">${['night', 'morning', 'hour'].map((k) => `<button class="chip solid" data-kind="${k}" aria-pressed="${e.my_reminders.includes(k)}">${kindLabel(k)}</button>`).join('')}
      ${e.my_reminders.filter((k) => typeof k === 'number').map((k) => `<button class="chip solid" data-kind="${k}" aria-pressed="true">${kindLabel(k)}</button>`).join('')}
      <button class="chip dashed" data-custom>${I.plusSm}Custom</button></div>
    </section>

    ${e.heads_up ? `<section class="section"><h2 class="h2">${esc(other)} gets a heads-up</h2><div class="card rows">
      ${toggleRow('hu-notify', 'When this is added or changed', e.heads_up.notify_partner)}
      ${toggleRow('hu-night', 'Night before', e.heads_up.partner_night)}
    </div></section>` : ''}

    ${e.also.length ? `<section class="section"><h2 class="h2">Also that day</h2>${e.also.map((a) => evCard(a)).join('')}</section>` : ''}

    ${e.can_edit ? `<button class="btn danger" id="delete">${I.trash}Delete event</button>` : ''}
  </main>`);
  bindBack();

  on($app, '[data-status]', 'click', async (ev, el) => {
    const next = el.getAttribute('aria-pressed') === 'true' ? null : el.dataset.status;
    try {
      await api(`/events/${e.id}/status`, { method: 'POST', body: { date: e.occ_date, status: next } });
      if (next) toast(`${other} got a ping`);
      viewEvent(e.id, e.occ_date);
    } catch (err) { fail(err); }
  });
  const sendReaction = async (text) => {
    if (!text) return;
    try {
      await api(`/events/${e.id}/react`, { method: 'POST', body: { date: e.occ_date, text } });
      toast(`Sent to ${other}`);
      viewEvent(e.id, e.occ_date);
    } catch (err) { fail(err); }
  };
  on($app, '[data-react]', 'click', (ev, el) => sendReaction(el.dataset.react));
  $app.querySelector('#react-form').addEventListener('submit', (ev) => { ev.preventDefault(); sendReaction($app.querySelector('#react-text').value.trim()); });

  let kinds = [...e.my_reminders];
  const saveKinds = async () => {
    try { kinds = (await api(`/events/${e.id}/reminders`, { method: 'PUT', body: { kinds } })).kinds; } catch (err) { fail(err); }
  };
  on($app, '[data-kind]', 'click', (ev, el) => {
    const k = /^\d+$/.test(el.dataset.kind) ? Number(el.dataset.kind) : el.dataset.kind;
    const onNow = el.getAttribute('aria-pressed') !== 'true';
    el.setAttribute('aria-pressed', String(onNow));
    kinds = onNow ? [...kinds, k] : kinds.filter((x) => x !== k);
    saveKinds();
  });
  const custom = $app.querySelector('[data-custom]');
  if (custom) custom.addEventListener('click', () => askMinutes(async (mins) => { kinds = [...kinds, mins]; await saveKinds(); viewEvent(e.id, e.occ_date); }));

  bindToggle('hu-notify', (v) => api(`/events/${e.id}/heads-up`, { method: 'PUT', body: { notify_partner: v } }));
  bindToggle('hu-night', (v) => api(`/events/${e.id}/heads-up`, { method: 'PUT', body: { partner_night: v } }));

  const del = $app.querySelector('#delete');
  if (del) del.addEventListener('click', () => confirmDelete(e));
}

function bindBack() {
  const b = $app.querySelector('[data-back]');
  if (b) b.addEventListener('click', (ev) => {
    if (S.hops > 0) { ev.preventDefault(); history.back(); }
  });
}

function toggleRow(id, label, on, sub = '') {
  return `<div class="toggle-row"><span class="label"><span id="${id}-l">${esc(label)}</span>${sub ? `<span class="muted">${esc(sub)}</span>` : ''}</span><button class="switch" role="switch" id="${id}" aria-checked="${!!on}" aria-labelledby="${id}-l"><span></span></button></div>`;
}
function bindToggle(id, save, root = $app) {
  const el = root.querySelector('#' + id);
  if (!el) return;
  el.addEventListener('click', async () => {
    const v = el.getAttribute('aria-checked') !== 'true';
    el.setAttribute('aria-checked', String(v));
    try { await save(v); } catch (err) { el.setAttribute('aria-checked', String(!v)); fail(err); }
  });
}

function dialog(html, bind) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="backdrop" data-close></div><div class="dialog" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', close));
  bind(wrap, close);
  const f = wrap.querySelector('input, button:not([data-close])');
  if (f) f.focus();
  return close;
}

function askMinutes(done) {
  dialog(`<h2 class="h2">Custom reminder</h2>
    <div class="chips">${[15, 30, 90, 120, 180].map((m) => `<button class="chip" data-m="${m}">${m < 60 ? m + ' min' : m / 60 + ' hr'} before</button>`).join('')}</div>
    <button class="btn ghost" data-close>Cancel</button>`, (w, close) => {
    w.querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', () => { close(); done(Number(b.dataset.m)); }));
  });
}

function confirmDelete(e) {
  const repeating = e.repeat && e.repeat !== 'none';
  dialog(`<h2 class="h2">Delete “${esc(e.title)}”?</h2>
    ${repeating ? `<button class="btn" data-scope="one">Just ${esc(prettyDate(e.occ_date))}</button><button class="btn ghost" data-scope="all" style="color:var(--danger)">Every time it repeats</button>`
      : `<button class="btn" data-scope="all" style="background:var(--danger);color:#fff">Delete</button>`}
    <button class="btn ghost" data-close>Cancel</button>`, (w, close) => {
    w.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', async () => {
      close();
      try {
        await api(`/events/${e.id}?date=${e.occ_date}&scope=${b.dataset.scope}`, { method: 'DELETE' });
        S.monthCache = null;
        toast('Deleted');
        location.hash = `#/month/${e.occ_date}`;
      } catch (err) { fail(err); }
    }));
  });
}

// ---------------------------------------------------------------- add / edit sheet
const REMINDER_OPTS = ['night', 'morning', 'hour'];
const SWATCHES = ['#2563EB', '#7C3AED', '#2F7D4A', '#0E7490', '#BE185D', '#B45309', '#C2410C', '#4F46E5', '#0F766E', '#475569', '#A21CAF', '#9F1239'];

function ownerKey(ownerId) { return ownerId == null ? 'both' : ownerId === S.me.id ? 'me' : 'partner'; }
function ownerId(key) { return key === 'both' ? null : key === 'partner' ? S.partner && S.partner.id : S.me.id; }

function catsFor(owner) {
  const oid = ownerId(owner);
  return S.cats.filter((c) => (owner === 'both' ? c.owner_id == null : c.owner_id === oid || c.owner_id == null));
}

async function openEventSheet(editId, date, q) {
  S.sheetPushed = true;
  let f;
  if (editId) {
    const e = await api(`/events/${editId}${isDate(date) ? `?date=${date}` : ''}`);
    f = {
      title: e.title, owner: ownerKey(e.owner_id), category_id: e.category.id, all_day: e.all_day, date: e.date,
      multi: !!e.series_end_date, end_date: e.series_end_date || '',
      start_time: e.start_time || '', end_time: e.end_time || '', repeat: e.repeat, repeat_until: e.repeat_until || '',
      location: e.location || '', notes: e.notes || '', reminders: e.my_reminders, visibility: e.visibility,
      notify_partner: e.heads_up ? e.heads_up.notify_partner : true, partner_night: e.heads_up ? e.heads_up.partner_night : false,
      occ: e.occ_date,
    };
  } else {
    const d = isDate(q.get('date')) ? q.get('date') : (S.monthSel && S.monthSel >= S.today ? S.monthSel : S.today);
    const who = ['me', 'partner', 'both'].includes(q.get('who')) ? q.get('who') : 'me';
    f = {
      title: '', owner: who, category_id: null, all_day: false, date: d, multi: false, end_date: '', start_time: q.get('time') || '18:00', end_time: '',
      repeat: 'none', repeat_until: '', location: '', notes: '', reminders: ['night', 'hour'], visibility: 'shared',
      notify_partner: true, partner_night: false,
    };
    if (who === 'both') { const dn = S.cats.find((c) => c.owner_id == null && /date/i.test(c.name)); if (dn) f.category_id = dn.id; }
  }
  const other = S.partner ? S.partner.name : 'them';

  $overlay.innerHTML = `<div class="backdrop" data-dismiss></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <div class="grab" aria-hidden="true"></div>
      <div class="sheet-head"><button class="textbtn" data-dismiss style="width:76px">Cancel</button><h1 id="sheet-title">${editId ? 'Edit event' : 'New event'}</h1><span style="width:76px"></span></div>
      <div class="sheet-body">
        ${editId ? '' : `<div class="card quick"><label class="lbl" for="quick" style="display:flex;align-items:center;gap:6px;font-weight:700">${I.bolt}Quick add — just type it</label>
          <input id="quick" type="text" autocomplete="off" placeholder="GG league every Thu 6:30" enterkeyhint="done">
          <div id="parsed" hidden></div></div>`}
        <div id="form-fields" style="display:flex;flex-direction:column;gap:18px"></div>
      </div>
      <div class="sheet-foot"><p class="error" id="sheet-err" hidden style="margin-bottom:8px"></p><button class="btn" id="save"></button></div>
    </div>`;
  const sheet = $overlay.querySelector('.sheet');
  const fields = $overlay.querySelector('#form-fields');
  let addingCat = false;
  let newCatColor = SWATCHES[5];

  function render() {
    const cats = catsFor(f.owner);
    if (f.category_id && !cats.some((c) => c.id === f.category_id)) f.category_id = null;
    const ownerOpts = [['me', S.me.name], ...(S.partner ? [['partner', S.partner.name]] : []), ['both', 'Both of us']];
    const mine = f.owner === 'me';
    const visHelp = f.visibility === 'shared' ? `${other} sees everything about this event.` : f.visibility === 'busy' ? `${other} sees a gray “Busy” block — no title or details.` : 'Only you can see this. Good for surprises.';
    fields.innerHTML = `
      <div class="field"><label class="lbl" for="f-title">What</label><input class="input" id="f-title" maxlength="120" placeholder="Tournament, league night, game…" value="${esc(f.title)}"></div>
      <div class="field"><span class="lbl" id="who-l">Whose event</span><div class="seg" role="group" aria-labelledby="who-l">${ownerOpts.map(([k, l]) => `<button type="button" data-owner="${k}" aria-pressed="${f.owner === k}">${esc(l)}</button>`).join('')}</div></div>
      <div class="field"><span class="lbl" id="cat-l">Category</span><div class="chips" role="group" aria-labelledby="cat-l">
        ${cats.map((c) => `<button type="button" class="chip" data-cat="${c.id}" aria-pressed="${f.category_id === c.id}"><span class="dot" style="background:${esc(c.color)}"></span>${esc(c.name)}</button>`).join('')}
        ${f.owner !== 'partner' ? `<button type="button" class="chip dashed" id="new-cat" aria-expanded="${addingCat}">${I.plusSm}New</button>` : ''}
      </div>
      ${addingCat ? `<div class="card" style="padding:14px;display:flex;flex-direction:column;gap:10px;margin-top:4px">
        <label class="lbl" for="nc-name">New ${f.owner === 'both' ? 'shared ' : ''}category</label><input class="input" id="nc-name" maxlength="40" placeholder="e.g. Golf, Work trip" style="height:46px">
        <div class="swatches" role="group" aria-label="Color">${SWATCHES.map((c) => `<button type="button" data-sw="${c}" aria-pressed="${c === newCatColor}" aria-label="Color ${c}"><i style="background:${c}"></i></button>`).join('')}</div>
        <button type="button" class="btn small" id="nc-add" style="align-self:flex-start">Add category</button></div>` : ''}</div>
      <div class="card rows pickers">
        ${toggleRow('f-allday', 'All day', f.all_day)}
        ${toggleRow('f-multi', 'Multiple days', f.multi)}
        <div class="prow"><label for="f-date" style="font-size:15px;font-weight:500">${f.multi ? 'First day' : f.repeat !== 'none' ? 'Starting' : 'Date'}</label><input type="date" id="f-date" value="${esc(f.date)}" required></div>
        ${f.multi ? `<div class="prow"><label for="f-enddate" style="font-size:15px;font-weight:500">Last day</label><input type="date" id="f-enddate" value="${esc(f.end_date)}" min="${esc(addDays(f.date, 1))}"></div>` : ''}
        ${f.all_day ? '' : `<div class="prow"><label for="f-start" style="font-size:15px;font-weight:500">Starts${f.multi ? ' <span class="muted">(first day)</span>' : ''}</label><input type="time" id="f-start" value="${esc(f.start_time)}"></div>
        <div class="prow"><label for="f-end" style="font-size:15px;font-weight:500">Ends <span class="muted">${f.multi ? '(last day)' : '(optional)'}</span></label><input type="time" id="f-end" value="${esc(f.end_time)}"></div>`}
        <div class="prow"><label for="f-repeat" style="font-size:15px;font-weight:500">Repeats</label><select id="f-repeat">${[['none', 'Never'], ...(f.multi ? [] : [['daily', 'Every day']]), ['weekly', 'Every week'], ['biweekly', 'Every 2 weeks'], ['monthly', 'Every month'], ['yearly', 'Every year']].map(([k, l]) => `<option value="${k}" ${f.repeat === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        ${f.repeat !== 'none' ? `<div class="prow"><label for="f-until" style="font-size:15px;font-weight:500">Until <span class="muted">(optional)</span></label><input type="date" id="f-until" value="${esc(f.repeat_until)}"></div>` : ''}
      </div>
      <div class="field"><label class="lbl" for="f-where">Where</label><input class="input" id="f-where" maxlength="160" placeholder="Bowling center or field" value="${esc(f.location)}"></div>
      <div class="field"><label class="lbl" for="f-notes">Notes</label><textarea class="input" id="f-notes" maxlength="2000" placeholder="Lane assignments, what to bring…">${esc(f.notes)}</textarea></div>
      <div class="field"><span class="lbl" id="rem-l">Remind me</span><div class="chips" role="group" aria-labelledby="rem-l">${REMINDER_OPTS.map((k) => `<button type="button" class="chip solid" data-rem="${k}" aria-pressed="${f.reminders.includes(k)}">${kindLabel(k)}</button>`).join('')}${f.reminders.filter((k) => typeof k === 'number').map((k) => `<button type="button" class="chip solid" data-rem="${k}" aria-pressed="true">${kindLabel(k)}</button>`).join('')}</div></div>
      ${mine && S.partner ? `<div class="field"><span class="lbl" id="vis-l">Who can see it</span><div class="seg" role="group" aria-labelledby="vis-l">${[['shared', 'Shared'], ['busy', 'Busy only'], ['private', 'Private']].map(([k, l]) => `<button type="button" data-vis="${k}" aria-pressed="${f.visibility === k}">${l}</button>`).join('')}</div><span class="muted">${esc(visHelp)}</span></div>` : ''}
      ${S.partner && f.visibility !== 'private' ? `<div class="card rows">${toggleRow('f-notify', f.owner === 'both' ? `Let ${other} know` : f.owner === 'partner' ? `Let ${other} know you added it` : `Let ${other} know`, f.notify_partner, 'Sends a notification when you save')}
        ${mine ? toggleRow('f-pnight', `Remind ${other} the night before`, f.partner_night) : ''}</div>` : ''}`;
    updateSave();

    const val = (id) => { const el = fields.querySelector('#' + id); return el ? el.value : ''; };
    fields.querySelector('#f-title').addEventListener('input', (e) => { f.title = e.target.value; });
    fields.querySelector('#f-date').addEventListener('change', (e) => {
      f.date = e.target.value;
      if (f.multi && (!f.end_date || f.end_date <= f.date)) { f.end_date = addDays(f.date, 1); render(); }
    });
    const ed = fields.querySelector('#f-enddate'); if (ed) ed.addEventListener('change', () => { f.end_date = val('f-enddate'); });
    const st = fields.querySelector('#f-start'); if (st) st.addEventListener('change', () => { f.start_time = val('f-start'); });
    const en = fields.querySelector('#f-end'); if (en) en.addEventListener('change', () => { f.end_time = val('f-end'); });
    fields.querySelector('#f-repeat').addEventListener('change', (e) => { f.repeat = e.target.value; render(); });
    const un = fields.querySelector('#f-until'); if (un) un.addEventListener('change', () => { f.repeat_until = val('f-until'); });
    fields.querySelector('#f-where').addEventListener('input', (e) => { f.location = e.target.value; });
    fields.querySelector('#f-notes').addEventListener('input', (e) => { f.notes = e.target.value; });
    on(fields, '[data-owner]', 'click', (e, el) => { f.owner = el.dataset.owner; if (f.owner !== 'me') f.visibility = 'shared'; render(); });
    on(fields, '[data-cat]', 'click', (e, el) => { f.category_id = Number(el.dataset.cat); render(); });
    on(fields, '[data-vis]', 'click', (e, el) => { f.visibility = el.dataset.vis; render(); });
    on(fields, '[data-rem]', 'click', (e, el) => {
      const k = /^\d+$/.test(el.dataset.rem) ? Number(el.dataset.rem) : el.dataset.rem;
      f.reminders = f.reminders.includes(k) ? f.reminders.filter((x) => x !== k) : [...f.reminders, k];
      el.setAttribute('aria-pressed', String(f.reminders.includes(k)));
    });
    const nc = fields.querySelector('#new-cat');
    if (nc) nc.addEventListener('click', () => { addingCat = !addingCat; render(); if (addingCat) fields.querySelector('#nc-name').focus(); });
    on(fields, '[data-sw]', 'click', (e, el) => { newCatColor = el.dataset.sw; fields.querySelectorAll('[data-sw]').forEach((b) => b.setAttribute('aria-pressed', String(b === el))); });
    const add = fields.querySelector('#nc-add');
    if (add) add.addEventListener('click', async () => {
      const name = val('nc-name').trim();
      if (!name) return fields.querySelector('#nc-name').focus();
      try {
        const r = await api('/categories', { method: 'POST', body: { name, color: newCatColor, shared: f.owner === 'both' } });
        S.cats = await api('/categories');
        f.category_id = r.id;
        addingCat = false;
        render();
      } catch (err) { fail(err); }
    });
    bindToggle('f-allday', async (v) => { f.all_day = v; render(); }, fields);
    bindToggle('f-multi', async (v) => {
      f.multi = v;
      if (v && (!f.end_date || f.end_date <= f.date)) f.end_date = addDays(f.date, 2);
      if (v && f.repeat === 'daily') f.repeat = 'none';
      render();
    }, fields);
    bindToggle('f-notify', async (v) => { f.notify_partner = v; updateSave(); }, fields);
    bindToggle('f-pnight', async (v) => { f.partner_night = v; }, fields);
  }

  function updateSave() {
    const btn = $overlay.querySelector('#save');
    const notify = S.partner && f.notify_partner && f.visibility !== 'private';
    btn.textContent = editId ? 'Save changes' : notify ? (f.owner === 'both' ? 'Save & notify both of us' : `Save & notify ${other}`) : 'Save event';
  }

  // Quick add
  const quick = $overlay.querySelector('#quick');
  if (quick) {
    quick.addEventListener('input', () => {
      const p = parseQuick(quick.value, { today: S.today, me: S.me, partner: S.partner, cats: S.cats });
      const box = $overlay.querySelector('#parsed');
      if (!p) { box.hidden = true; return; }
      if (p.title) f.title = p.title;
      if (p.owner) f.owner = p.owner;
      if (p.category_id) f.category_id = p.category_id;
      if (p.date) f.date = p.date;
      f.multi = !!p.end_date;
      f.end_date = p.end_date || '';
      f.all_day = p.all_day;
      if (p.start_time) f.start_time = p.start_time;
      if (p.end_time) f.end_time = p.end_time;
      f.repeat = p.repeat;
      if (f.owner !== 'me') f.visibility = 'shared';
      const cat = S.cats.find((c) => c.id === f.category_id);
      const bits = [
        [f.title, cat ? cat.color : 'var(--muted)'],
        [f.owner === 'both' ? 'Both of us' : (f.owner === 'me' ? S.me : S.partner || S.me).name, 'var(--muted)'],
        [p.end_date ? `${prettyDate(f.date)} – ${prettyDate(p.end_date)}` : null, 'var(--muted)'],
        [p.repeat !== 'none' ? { daily: 'Every day', weekly: `Every ${DOW[dow(f.date)].slice(0, 3)}`, biweekly: `Every other ${DOW[dow(f.date)].slice(0, 3)}`, monthly: 'Every month', yearly: `Every year on ${MON[Number(f.date.slice(5, 7)) - 1].slice(0, 3)} ${Number(f.date.slice(8))}` }[p.repeat] : p.end_date ? null : relDay(f.date), 'var(--muted)'],
        [p.all_day ? 'All day' : p.start_time ? prettyTime(p.start_time) + (p.end_time ? ` – ${prettyTime(p.end_time)}` : '') : null, 'var(--muted)'],
      ].filter((b) => b[0]);
      box.hidden = false;
      box.innerHTML = `<div class="parsed">${bits.map(([t, c]) => `<span><span class="dot" style="width:8px;height:8px;background:${c}"></span>${esc(t)}</span>`).join('')}</div><span class="muted" style="font-size:12px;display:block;margin-top:8px">Filled in below — change anything that's off.</span>`;
      render();
    });
    setTimeout(() => quick.focus(), 300);
  }

  render();

  $overlay.querySelector('#save').addEventListener('click', async () => {
    const err = $overlay.querySelector('#sheet-err');
    err.hidden = true;
    const body = {
      title: f.title, owner_id: ownerId(f.owner), category_id: f.category_id, all_day: f.all_day, date: f.date,
      end_date: f.multi ? f.end_date : null,
      start_time: f.all_day ? null : f.start_time, end_time: f.all_day ? null : f.end_time || null,
      repeat: f.repeat, repeat_until: f.repeat_until || null, location: f.location, notes: f.notes,
      reminders: f.reminders, visibility: f.visibility, notify_partner: f.notify_partner, partner_night: f.partner_night,
    };
    if (f.multi && !(f.end_date > f.date)) { err.textContent = 'Pick a last day after the first day'; err.hidden = false; return; }
    if (!f.multi && body.end_time && body.start_time && body.end_time <= body.start_time) { err.textContent = 'The end time is before the start'; err.hidden = false; return; }
    const btn = $overlay.querySelector('#save');
    btn.disabled = true;
    try {
      if (editId) {
        await api(`/events/${editId}`, { method: 'PUT', body });
        if (S.partner && f.owner === 'me') await api(`/events/${editId}/heads-up`, { method: 'PUT', body: { partner_night: f.partner_night } }).catch(() => {});
      } else {
        await api('/events', { method: 'POST', body });
      }
      S.monthCache = null;
      S.monthSel = f.date;
      toast(editId ? 'Saved' : body.notify_partner && S.partner && f.visibility !== 'private' ? `Saved — ${other} got a heads-up` : 'Saved');
      closeSheet(editId ? `#/event/${editId}/${f.date}` : `#/month/${f.date}`);
    } catch (e2) {
      err.textContent = e2.message; err.hidden = false; btn.disabled = false;
    }
  });

  on($overlay, '[data-dismiss]', 'click', () => closeSheet());

  // Swipe down on the handle/header to dismiss.
  const head = $overlay.querySelector('.sheet-head');
  const grab = $overlay.querySelector('.grab');
  let y0 = null; let dy = 0;
  const startDrag = (e) => { y0 = (e.touches ? e.touches[0] : e).clientY; dy = 0; sheet.style.transition = 'none'; };
  const moveDrag = (e) => { if (y0 == null) return; dy = Math.max(0, (e.touches ? e.touches[0] : e).clientY - y0); sheet.style.transform = `translateY(${dy}px)`; };
  const endDrag = () => {
    if (y0 == null) return;
    y0 = null;
    sheet.style.transition = 'transform 0.2s ease-out';
    if (dy > 110) closeSheet(); else sheet.style.transform = '';
  };
  [head, grab].forEach((el) => { el.addEventListener('touchstart', startDrag, { passive: true }); el.addEventListener('touchmove', moveDrag, { passive: true }); el.addEventListener('touchend', endDrag); });
}

function closeSheet(goTo) {
  const sheet = $overlay.querySelector('.sheet');
  const finish = () => {
    $overlay.innerHTML = '';
    if (goTo) {
      if (S.sheetPushed) history.replaceState(null, '', goTo);
      else location.hash = goTo;
      S.sheetPushed = false;
      route();
    } else if (S.sheetPushed && history.length > 1) {
      S.sheetPushed = false;
      history.back();
    } else {
      location.hash = S.base || '#/month';
    }
  };
  if (!sheet) return finish();
  sheet.classList.add('closing');
  const bd = $overlay.querySelector('.backdrop');
  if (bd) bd.style.opacity = '0';
  setTimeout(finish, 200);
}

// ---------------------------------------------------------------- activity
function rangeText(a, b) {
  const [ma, da] = [MON[Number(a.slice(5, 7)) - 1].slice(0, 3), Number(a.slice(8))];
  const [mb, db] = [MON[Number(b.slice(5, 7)) - 1].slice(0, 3), Number(b.slice(8))];
  return ma === mb ? `${ma} ${da}–${db}` : `${ma} ${da} – ${mb} ${db}`;
}
async function viewActivity() {
  const a = await api('/activity');
  S.unread = 0;
  if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
  if (a.unread) api('/activity/read', { method: 'POST' }).catch(() => {});
  const w = a.week;
  const other = S.partner ? S.partner.name : null;
  const dayName = (d) => DOW[dow(d)].slice(0, 3);
  const freeText = w.free.length ? `Free together ${w.free.slice(0, 3).map(dayName).join(', ')}${w.free.length > 3 ? ` + ${w.free.length - 3} more` : ''}.` : 'No free evenings together this week.';
  const recapText = [w.busiest ? `Busiest day is ${DOW[dow(w.busiest.date)]}${w.both_booked.includes(w.busiest.date) ? " — you're both booked" : ''}.` : 'A quiet week so far.', freeText].join(' ');
  const today = S.today;
  const groups = { Today: [], Earlier: [] };
  for (const it of a.items) (new Date(it.created_at.replace(' ', 'T') + 'Z').toLocaleDateString('en-CA') === new Date().toLocaleDateString('en-CA') ? groups.Today : groups.Earlier).push(it);
  const feedIcon = (it) => {
    if (it.actor_id) { const p = person(it.actor_id); return `<span class="avatar round" style="background:${esc(p ? p.color : '#475569')}" aria-hidden="true">${esc(p ? p.name[0] : '?')}</span>`; }
    const c = it.kind === 'weather' ? '#475569' : it.kind === 'recap' ? '#16181D' : '#B45309';
    return `<span class="avatar round" style="background:${c}" aria-hidden="true">${it.kind === 'recap' ? I.cal.replace('width="22" height="22"', 'width="16" height="16"') : '!'}</span>`;
  };
  const item = (it) => {
    const href = it.event_id ? `#/event/${it.event_id}/${it.occ_date || ''}` : it.occ_date ? `#/month/${it.occ_date}` : null;
    const inner = `${feedIcon(it)}<span class="grow"><span><b>${esc(it.lead)}</b> ${esc(it.body)}</span><span class="muted" style="font-size:12px">${esc(ago(it.created_at))}</span></span>${it.read_at ? '' : '<span class="unread-dot" aria-label="Unread"></span>'}`;
    return href && it.kind !== 'removed' ? `<a class="feed-item" href="${href}">${inner}</a>` : `<div class="feed-item">${inner}</div>`;
  };
  const prefRows = [
    ['partner_changes', other ? `${other} adds or changes something` : 'Changes to the calendar'],
    ['reactions', 'Messages and on-my-way'],
    ['partner_morning', other ? `Morning of ${other}'s events` : 'Morning heads-up'],
    ['both_booked', 'We’re both booked'],
    ['weather', 'Weather alerts'],
    ['recap', 'Sunday night recap'],
  ];
  const myCount = (w.counts.find((c) => c.id === S.me.id) || {}).n || 0;
  const theirCount = other ? (w.counts.find((c) => c.id === S.partner.id) || {}).n || 0 : 0;

  setScreen(`<main class="screen">
    <header class="head"><div><p class="kicker">${other ? 'Pings between you two' : 'Your pings'}</p><h1 class="title">Activity</h1></div></header>
    <div id="push-card"></div>
    <section class="recap" aria-label="This week">
      <div style="display:flex;align-items:center;justify-content:space-between"><span class="k">This week · ${esc(rangeText(w.from, w.to))}</span></div>
      <div class="tiles"><div class="tile"><b>${myCount}</b><span>for you</span></div>${other ? `<div class="tile"><b>${theirCount}</b><span>for ${esc(other)}</span></div>` : ''}<a class="tile amber" href="#/free" style="text-decoration:none"><b>${w.free.length}</b><span>free together</span></a></div>
      <p>${esc(recapText)}</p>
    </section>
    ${Object.entries(groups).filter(([, l]) => l.length).map(([k, l]) => `<section class="section"><h2 class="h2">${k}</h2><div class="card rows">${l.map(item).join('')}</div></section>`).join('') || `<div class="empty">Nothing yet. When ${esc(other || 'someone')} adds plans or sends a message, it shows up here.</div>`}
    <section class="section"><h2 class="h2">Notify me when</h2><div class="card rows">${prefRows.map(([k, l]) => toggleRow('pref-' + k, l, a.prefs[k])).join('')}</div></section>
    <section class="section"><h2 class="h2">Settings</h2><div class="card rows">
      <div class="row" style="flex-wrap:wrap;gap:10px"><span class="grow"><span class="t" id="hol-l">U.S. holidays</span><span class="s">Shown on this phone's calendar</span></span>
        <div class="seg" role="group" aria-labelledby="hol-l" style="width:100%">${[['all', 'All'], ['federal', 'Federal only'], ['off', 'Off']].map(([k, l]) => `<button data-hol="${k}" aria-pressed="${S.holidays === k}">${l}</button>`).join('')}</div></div>
      <a class="row" href="#/categories"><span class="grow"><span class="t">Categories</span><span class="s">Add, remove or recolor yours</span></span>${I.right}</a>
      <button class="row" id="pw-btn" style="border:0;background:none;width:100%;text-align:left"><span class="grow"><span class="t">Change password</span></span>${I.right}</button>
      <button class="row" id="signout" style="border:0;background:none;width:100%;text-align:left;color:var(--danger)"><span class="grow"><span class="t">Sign out</span></span></button>
    </div></section>
  </main>${navHtml('activity')}`);

  for (const [k] of prefRows) bindToggle('pref-' + k, (v) => api('/prefs', { method: 'PUT', body: { [k]: v } }));
  on($app, '[data-hol]', 'click', (e, el) => {
    S.holidays = el.dataset.hol;
    localStorage.setItem('st-holidays', S.holidays);
    $app.querySelectorAll('[data-hol]').forEach((b) => b.setAttribute('aria-pressed', String(b === el)));
    toast(S.holidays === 'off' ? 'Holidays hidden' : S.holidays === 'federal' ? 'Showing federal holidays' : 'Showing all holidays');
  });
  $app.querySelector('#signout').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    S.me = null; S.loaded = false; location.hash = '';
    route();
  });
  $app.querySelector('#pw-btn').addEventListener('click', () => dialog(`<h2 class="h2">Change password</h2>
    <div class="field"><label class="lbl" for="pw-cur">Current password</label><input class="input" id="pw-cur" type="password" autocomplete="current-password"></div>
    <div class="field"><label class="lbl" for="pw-new">New password</label><input class="input" id="pw-new" type="password" minlength="6" autocomplete="new-password"></div>
    <p class="error" id="pw-err" hidden></p><button class="btn" id="pw-save">Save</button><button class="btn ghost" data-close>Cancel</button>`, (wr, close) => {
    wr.querySelector('#pw-save').addEventListener('click', async () => {
      try {
        await api('/password', { method: 'POST', body: { current: wr.querySelector('#pw-cur').value, next: wr.querySelector('#pw-new').value } });
        close(); toast('Password changed');
      } catch (err) { const el = wr.querySelector('#pw-err'); el.textContent = err.message; el.hidden = false; }
    });
  }));
  renderPushCard();
}

// ---------------------------------------------------------------- push
function b64ToBytes(b64) {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function currentSub() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function syncPush() {
  try {
    const sub = await currentSub();
    if (sub && Notification.permission === 'granted') await api('/push/subscribe', { method: 'POST', body: sub.toJSON() });
  } catch { /* fine */ }
}

async function renderPushCard() {
  const box = $app.querySelector('#push-card');
  if (!box || !S.vapid) return;
  if (!pushSupported()) {
    box.innerHTML = isIOS && !standalone
      ? `<div class="banner info">${I.share}<span>To get notifications on iPhone, tap <b>Share</b> → <b>Add to Home Screen</b>, then open SpareTime from your home screen and come back here.</span></div>`
      : `<div class="banner info"><span>This browser can't show notifications. Try Chrome on Android or Safari on iPhone (from the home screen).</span></div>`;
    return;
  }
  const sub = await currentSub();
  if (Notification.permission === 'denied') {
    box.innerHTML = `<div class="banner warn">${I.bell}<span>Notifications are blocked. Turn them on for SpareTime in your phone's Settings.</span></div>`;
  } else if (sub && Notification.permission === 'granted') {
    box.innerHTML = `<div class="card toggle-row" style="padding:10px 12px 10px 16px"><span class="label"><span style="font-weight:700">Notifications are on</span><span class="muted">for this phone</span></span><button class="btn small ghost" id="push-test">Send a test</button></div>`;
    box.querySelector('#push-test').addEventListener('click', async () => { await api('/push/test', { method: 'POST' }).catch(fail); toast('Test sent — check your notifications'); });
  } else {
    box.innerHTML = `<div class="card" style="padding:16px;display:flex;flex-direction:column;gap:10px"><span style="font-size:15px;font-weight:700">Turn on notifications</span><span class="muted">Get a ping when ${esc(S.partner ? S.partner.name : 'someone')} adds plans, plus your reminders.</span><button class="btn" id="push-on">${I.bell}Turn on</button></div>`;
    box.querySelector('#push-on').addEventListener('click', enablePush);
  }
}

async function enablePush() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications were not allowed'); return renderPushCard(); }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(S.vapid) });
    await api('/push/subscribe', { method: 'POST', body: sub.toJSON() });
    toast('Notifications are on');
  } catch (e) {
    fail(e);
  }
  renderPushCard();
}

// ---------------------------------------------------------------- categories
let lastDeleted = null;
async function viewCategories() {
  S.cats = await api('/categories');
  const mine = S.cats.filter((c) => c.owner_id === S.me.id);
  const shared = S.cats.filter((c) => c.owner_id == null);
  const theirs = S.partner ? S.cats.filter((c) => c.owner_id === S.partner.id) : [];
  let color = SWATCHES[6];
  let target = 'mine';
  const count = (n) => (n === 0 ? 'No events yet' : n === 1 ? '1 event' : `${n} events`);
  const row = (c, editable) => `<div class="row" style="padding:4px 4px 4px 16px"><span class="dot" style="width:14px;height:14px;background:${esc(c.color)}"></span><span class="grow" style="padding:8px 0"><span class="t">${esc(c.name)}</span><span class="s">${count(c.events)}</span></span>${editable ? `<button class="circle" style="box-shadow:none;background:transparent;color:var(--danger)" data-del="${c.id}" aria-label="Delete ${esc(c.name)}">${I.trash}</button>` : ''}</div>`;
  setScreen(`<main class="screen no-nav">
    <div class="topbar"><a class="textbtn" href="#/activity">${I.left}Back</a></div>
    <div><h1 class="title">Categories</h1><p class="muted" style="font-size:14px;margin-top:4px">Each of you manages your own. Shared ones either of you can change.</p></div>
    <section class="section"><h2 class="h2">Mine</h2><div class="card rows">${mine.map((c) => row(c, true)).join('') || '<div class="row"><span class="s">None yet</span></div>'}</div></section>
    <section class="card" style="padding:16px;display:flex;flex-direction:column;gap:10px">
      <label class="h2" for="cat-name">Add a category</label>
      <input class="input" id="cat-name" maxlength="40" placeholder="e.g. Golf, Work trip, Gym" style="height:48px">
      <div class="swatches" role="group" aria-label="Color">${SWATCHES.map((c) => `<button type="button" data-sw="${c}" aria-pressed="${c === color}" aria-label="Color ${c}"><i style="background:${c}"></i></button>`).join('')}</div>
      ${S.partner ? `<div class="seg" role="group" aria-label="Whose category"><button type="button" data-target="mine" aria-pressed="true">Mine</button><button type="button" data-target="shared" aria-pressed="false">Shared</button></div>` : ''}
      <button class="btn" id="cat-add" style="height:48px">Add category</button>
    </section>
    ${shared.length ? `<section class="section"><h2 class="h2">Shared</h2><div class="card rows">${shared.map((c) => row(c, true)).join('')}</div></section>` : ''}
    ${theirs.length ? `<section class="section"><div class="section-head"><h2 class="h2">${esc(S.partner.name)}'s</h2><span class="muted" style="font-size:12px">Only ${esc(S.partner.name)} can change these</span></div><div class="card rows">${theirs.map((c) => row(c, false)).join('')}</div></section>` : ''}
  </main>`);
  on($app, '[data-sw]', 'click', (e, el) => { color = el.dataset.sw; $app.querySelectorAll('[data-sw]').forEach((b) => b.setAttribute('aria-pressed', String(b === el))); });
  on($app, '[data-target]', 'click', (e, el) => { target = el.dataset.target; $app.querySelectorAll('[data-target]').forEach((b) => b.setAttribute('aria-pressed', String(b === el))); });
  $app.querySelector('#cat-add').addEventListener('click', async () => {
    const name = $app.querySelector('#cat-name').value.trim();
    if (!name) return $app.querySelector('#cat-name').focus();
    try { await api('/categories', { method: 'POST', body: { name, color, shared: target === 'shared' } }); toast(`Added ${name}`); viewCategories(); } catch (err) { fail(err); }
  });
  on($app, '[data-del]', 'click', async (e, el) => {
    const c = S.cats.find((x) => x.id === Number(el.dataset.del));
    try {
      await api(`/categories/${c.id}`, { method: 'DELETE' });
      lastDeleted = c;
      S.monthCache = null;
      await viewCategories();
      toast(c.events ? `Deleted ${c.name}. Its ${count(c.events).toLowerCase()} now show as Other.` : `Deleted ${c.name}`, {
        action: 'Undo', ms: 6000,
        onAction: async () => { await api(`/categories/${lastDeleted.id}/restore`, { method: 'POST' }); S.monthCache = null; viewCategories(); },
      });
    } catch (err) { fail(err); }
  });
}

// ---------------------------------------------------------------- free together
async function viewFree(filter = 'any') {
  const slots = await api('/free?days=21');
  const hol = holidaysBetween(S.today, addDays(S.today, 21), S.holidays);
  const shown = slots.filter((s) => filter === 'any' || (filter === 'wk' ? s.weekend : !s.weekend));
  const title = (s) => (s.kind === 'day' ? `All day ${DOW[dow(s.date)]}` : s.date === S.today ? 'Tonight' : `${DOW[dow(s.date)]} evening`);
  const meta = (s) => (hol[s.date] ? `${hol[s.date][0].name.replace(' (observed)', '')} · ` : '') + (s.kind === 'day' ? 'Nothing scheduled' : `Free after ${prettyTime(s.after)}`) + (s.weather ? ` · ${s.weather.text}, ${s.weather.high}°` : '');
  setScreen(`<main class="screen no-nav">
    <div class="topbar"><a class="textbtn" href="#/agenda">${I.left}Coming up</a></div>
    <div><h1 class="title">Free together</h1><p class="muted" style="font-size:14px;margin-top:4px">Times in the next 3 weeks when neither of you has anything planned.</p></div>
    <div class="seg" role="group" aria-label="Show">${[['any', 'Anytime'], ['eve', 'Weeknights'], ['wk', 'Weekends']].map(([k, l]) => `<button data-f="${k}" aria-pressed="${filter === k}">${l}</button>`).join('')}</div>
    ${shown.map((s) => `<div class="card" style="display:flex;align-items:center;gap:14px;padding:14px">
      <div style="width:52px;height:56px;flex:none;border-radius:14px;background:var(--warn-bg);color:var(--warn-fg);display:flex;flex-direction:column;align-items:center;justify-content:center"><span style="font-size:11px;font-weight:700;text-transform:uppercase">${DOW[dow(s.date)].slice(0, 3)}</span><span style="font-size:20px;font-weight:800;line-height:1.1">${Number(s.date.slice(8))}</span></div>
      <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:3px"><span style="font-size:15px;font-weight:700">${esc(title(s))}</span><span class="muted" style="display:flex;align-items:center;gap:5px">${s.weather ? (I.wx[s.weather.icon] || '').replace('width="20" height="20"', 'width="15" height="15"') : ''}${esc(meta(s))}</span></div>
      <a class="btn small" href="#/add?date=${s.date}&time=${s.kind === 'day' ? '12:00' : s.after > '18:00' ? s.after : '18:30'}&who=both" aria-label="Plan something for ${prettyDate(s.date, true)}">Plan</a></div>`).join('') || '<div class="empty">No shared free time in the next 3 weeks. Busy you two!</div>'}
  </main>`);
  on($app, '[data-f]', 'click', (e, el) => viewFree(el.dataset.f).catch(fail));
}

// ---------------------------------------------------------------- search
function searchCard(e) {
  const when = e.span > 1 ? `${prettyDate(e.occ_date)} – ${prettyDate(e.end_date)}` : `${prettyDate(e.occ_date)}${e.all_day ? '' : ' · ' + prettyTime(e.start_time)}`;
  const meta = [when, e.owner_name, e.category.name !== 'Other' ? e.category.name : null, e.location].filter(Boolean).join(' · ');
  return `<a class="evcard" href="#/event/${e.id}/${e.occ_date}">${avatar(e)}<span class="grow"><span class="t">${esc(e.title)}</span><span class="s">${esc(meta)}</span></span><span style="color:var(--muted)">${I.right}</span></a>`;
}

function viewSearch() {
  setScreen(`<main class="screen no-nav">
    <div class="topbar"><a class="textbtn" href="${esc(S.searchBack || '#/month')}" data-back>${I.left}Back</a></div>
    <div class="field"><label class="sr" for="q">Search events</label>
      <div style="position:relative"><span style="position:absolute;left:14px;top:16px;color:var(--sub)">${I.search}</span>
      <input class="input" id="q" type="search" placeholder="Search events, places, notes" autocomplete="off" enterkeyhint="search" style="padding-left:44px" value="${esc(S.searchQ || '')}"></div></div>
    <div id="results" style="display:flex;flex-direction:column;gap:16px"></div>
  </main>`);
  bindBack();
  const input = $app.querySelector('#q');
  const box = $app.querySelector('#results');
  let timer; let seq = 0;
  const run = async () => {
    const q = input.value.trim();
    S.searchQ = q;
    if (q.length < 2) { box.innerHTML = `<p class="muted" style="text-align:center;padding:24px 0">Type at least 2 letters — titles, places, notes and categories all count.</p>`; return; }
    const mine = ++seq;
    try {
      const r = await api(`/search?q=${encodeURIComponent(q)}`);
      if (mine !== seq) return;
      const section = (label, list) => (list.length ? `<section class="section"><h2 class="h2">${label}</h2>${list.map(searchCard).join('')}</section>` : '');
      box.innerHTML = section('Upcoming', r.upcoming) + section('Past', r.past) || `<div class="empty">Nothing matches “${esc(q)}”.</div>`;
    } catch (err) { fail(err); }
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); run(); input.blur(); } });
  run();
  if (!S.searchQ) setTimeout(() => input.focus(), 100);
}

// ---------------------------------------------------------------- start
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const d = document.querySelector('.dialog');
  if (d) return d.parentElement.remove();
  if ($overlay.querySelector('.sheet')) closeSheet();
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
route();

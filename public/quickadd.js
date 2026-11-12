// Turns "GG league every Thu 6:30" into event fields. Pure function — no DOM.

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_RE = '(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const pad = (n) => String(n).padStart(2, '0');
function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
function dow(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function dayIndex(word) {
  return DAYS.findIndex((d) => d.startsWith(word.slice(0, 3)));
}
function nextDow(today, idx, skipWeek) {
  let diff = (idx - dow(today) + 7) % 7;
  if (skipWeek) diff += 7;
  return addDays(today, diff);
}

// h: hour as typed, ap: 'am'|'pm'|undefined. Unmarked 1–7 → PM, 8–11 → AM, 12 → noon.
function to24(h, min, ap, eveningHint) {
  h = Number(h); min = Number(min || 0);
  if (ap === 'am') { if (h === 12) h = 0; }
  else if (ap === 'pm') { if (h < 12) h += 12; }
  else if (h <= 12) {
    if (eveningHint && h < 12) h += 12;
    else if (h >= 1 && h <= 7) h += 12;
  }
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

const ALIASES = [
  { re: /\b(gg|gussie|gutter gussie)\b/, cat: 'gutter gussie', title: (s) => (/\bleague\b/.test(s) ? 'Gutter Gussie league' : 'Gutter Gussie') },
  { re: /\b(tourney|tournament)\b/, cat: 'bowling', title: () => 'Tournament' },
  { re: /\b(ump|umpire|umpiring)\b/, cat: 'umpiring', title: null },
  { re: /\busbc\b/, cat: 'usbc', title: null },
  { re: /\b(date night|date)\b/, cat: 'date night', who: 'both', title: () => 'Date night' },
  { re: /\bfamily\b/, cat: 'family', who: 'both', title: null },
];

/**
 * @param {string} text
 * @param {{today:string, me:{id:number,name:string}, partner:{id:number,name:string}|null, cats:Array<{id:number,owner_id:number|null,name:string}>}} ctx
 */
export function parseQuick(text, ctx) {
  const raw = (text || '').trim();
  if (!raw) return null;
  let s = ' ' + raw.toLowerCase().replace(/[,]/g, ' ') + ' ';
  const out = { title: null, owner: null, category_id: null, date: null, end_date: null, start_time: null, end_time: null, all_day: false, repeat: 'none' };
  const used = [];
  const take = (re) => {
    const m = s.match(re);
    if (m) { used.push(m[0]); s = s.replace(m[0], ' '); }
    return m;
  };

  // who
  const partnerName = ctx.partner ? ctx.partner.name.toLowerCase() : null;
  const names = [ctx.me.name, ctx.partner && ctx.partner.name].filter(Boolean).map((n) => n.toLowerCase());
  const specialDay = new RegExp(`\\b(${names.join('|')}|my|our)('s)? (birthday|bday|b-day|anniversary)\\b`).test(s);
  if (specialDay) out.owner = 'both';
  else if (partnerName && new RegExp(`\\b${partnerName}('s)?\\b`).test(s)) { out.owner = 'partner'; take(new RegExp(`\\b${partnerName}('s)?\\b`)); }
  else if (/\b(we|us|both|our)\b/.test(s)) out.owner = 'both';

  // all day
  if (take(/\ball[- ]day\b/)) out.all_day = true;

  // repeats
  let m;
  if ((m = take(new RegExp(`\\bevery other ${DAY_RE}\\b`)))) { out.repeat = 'biweekly'; out.date = nextDow(ctx.today, dayIndex(m[1])); }
  else if ((m = take(new RegExp(`\\b(?:every|each) ${DAY_RE}s?\\b`)))) { out.repeat = 'weekly'; out.date = nextDow(ctx.today, dayIndex(m[1])); }
  else if (take(/\b(every day|daily)\b/)) out.repeat = 'daily';
  else if (take(/\b(every week|weekly)\b/)) out.repeat = 'weekly';
  else if (take(/\b(every other week|biweekly)\b/)) out.repeat = 'biweekly';
  else if (take(/\b(every month|monthly)\b/)) out.repeat = 'monthly';
  else if (take(/\b(every year|yearly|annually|annual)\b/)) out.repeat = 'yearly';

  // dates
  const evening = /\btonight\b/.test(s);
  const monthDate = (mon, day) => {
    const mi = MONTHS.indexOf(mon.slice(0, 3));
    const y = Number(ctx.today.slice(0, 4));
    let d = `${y}-${pad(mi + 1)}-${pad(Number(day))}`;
    if (d < ctx.today) d = `${y + 1}-${pad(mi + 1)}-${pad(Number(day))}`;
    return d;
  };
  const RANGE = '\\s*(?:-|–|to|through|thru)\\s*';
  if (!out.date) {
    // Ranges: "nov 20-22", "dec 30 to jan 2", "fri-sun", "this weekend"
    if ((m = take(new RegExp(`\\b(${MONTHS.join('|')})[a-z]*\\.? (\\d{1,2})(?:st|nd|rd|th)?${RANGE}(?:(${MONTHS.join('|')})[a-z]*\\.? )?(\\d{1,2})(?:st|nd|rd|th)?\\b`)))) {
      out.date = monthDate(m[1], m[2]);
      let end = `${out.date.slice(0, 4)}-${pad(MONTHS.indexOf((m[3] || m[1]).slice(0, 3)) + 1)}-${pad(Number(m[4]))}`;
      if (end <= out.date) end = `${Number(end.slice(0, 4)) + 1}${end.slice(4)}`;
      out.end_date = end;
    } else if ((m = take(new RegExp(`\\b${DAY_RE}${RANGE}${DAY_RE}\\b`)))) {
      out.date = nextDow(ctx.today, dayIndex(m[1]));
      out.end_date = addDays(out.date, ((dayIndex(m[2]) - dayIndex(m[1]) + 7) % 7) || 7);
    } else if (take(/\b(this )?weekend\b/)) {
      out.date = dow(ctx.today) === 0 ? ctx.today : nextDow(ctx.today, 6);
      out.end_date = dow(ctx.today) === 0 ? null : addDays(out.date, 1);
      if (!out.end_date) out.all_day = true;
    }
  }
  if (!out.date) {
    if (take(/\b(today|tonight)\b/)) out.date = ctx.today;
    else if (take(/\b(tomorrow|tmrw|tmr)\b/)) out.date = addDays(ctx.today, 1);
    else if ((m = take(new RegExp(`\\b(${MONTHS.join('|')})[a-z]*\\.? (\\d{1,2})(?:st|nd|rd|th)?\\b`)))) {
      const mi = MONTHS.indexOf(m[1].slice(0, 3));
      let y = Number(ctx.today.slice(0, 4));
      let d = `${y}-${pad(mi + 1)}-${pad(Number(m[2]))}`;
      if (d < ctx.today) d = `${y + 1}-${pad(mi + 1)}-${pad(Number(m[2]))}`;
      out.date = d;
    } else if ((m = take(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) {
      let y = m[3] ? Number(m[3].length === 2 ? '20' + m[3] : m[3]) : Number(ctx.today.slice(0, 4));
      let d = `${y}-${pad(Number(m[1]))}-${pad(Number(m[2]))}`;
      if (!m[3] && d < ctx.today) d = `${y + 1}-${pad(Number(m[1]))}-${pad(Number(m[2]))}`;
      out.date = d;
    } else if ((m = take(new RegExp(`\\b(next )?(?:on )?${DAY_RE}\\b`)))) {
      out.date = nextDow(ctx.today, dayIndex(m[2]), !!m[1]);
    }
  }

  // times: ranges first, then single times
  if (!out.all_day) {
    if ((m = take(/\b(?:from )?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?\s*(?:-|–|to|until|til)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?\b/))) {
      const ap1 = m[3] ? (m[3][0] === 'a' ? 'am' : 'pm') : undefined;
      const ap2 = m[6] ? (m[6][0] === 'a' ? 'am' : 'pm') : undefined;
      out.start_time = to24(m[1], m[2], ap1 || (ap2 === 'pm' && Number(m[1]) <= Number(m[4]) ? 'pm' : undefined), evening);
      let end = to24(m[4], m[5], ap2, evening);
      if (end && out.start_time && end <= out.start_time && !ap2) end = to24(Number(m[4]) + 12, m[5], undefined);
      out.end_time = end;
    } else if (take(/\bnoon\b/)) out.start_time = '12:00';
    else if ((m = take(/\b(?:at |@ ?)?(\d{1,2}):(\d{2})\s*(am|pm|a|p)?\b/)) || (m = take(/\b(?:at |@ ?)?(\d{1,2})()\s*(am|pm|a|p)\b/)) || (m = take(/\b(?:at |@ ?)(\d{1,2})()\s*(am|pm|a|p)?\b/))) {
      const ap = m[3] ? (m[3][0] === 'a' ? 'am' : 'pm') : undefined;
      out.start_time = to24(m[1], m[2], ap, evening);
    } else if (out.date && (m = take(/\s(\d{1,2})\s*$/))) {
      out.start_time = to24(m[1], 0, undefined, evening); // "tomorrow 7"
    }
  }

  // Birthdays and anniversaries come around every year and usually last all day.
  if (/\b(birthday|bday|b-day|anniversary)\b/i.test(raw) && !/\bparty\b/i.test(raw)) {
    if (out.repeat === 'none') out.repeat = 'yearly';
    if (!out.start_time) out.all_day = true;
  }
  if (out.end_date && !out.start_time) out.all_day = true;

  // category + owner from keywords or category names
  const lower = raw.toLowerCase();
  let alias = ALIASES.find((a) => a.re.test(lower));
  const resolveOwnerId = (o) => (o === 'partner' ? ctx.partner && ctx.partner.id : o === 'both' ? null : ctx.me.id);
  const pickCat = (needle) => {
    const matches = ctx.cats.filter((c) => c.name.toLowerCase().includes(needle));
    if (!matches.length) return null;
    if (out.owner) {
      const oid = resolveOwnerId(out.owner);
      const own = matches.find((c) => c.owner_id === oid) || matches.find((c) => c.owner_id == null);
      if (own) return own;
    }
    return matches.find((c) => c.owner_id === ctx.me.id) || matches[0];
  };
  let cat = null;
  if (alias) {
    if (alias.who && !out.owner) out.owner = alias.who;
    cat = pickCat(alias.cat);
  }
  if (!cat) {
    const byName = ctx.cats.filter((c) => lower.includes(c.name.toLowerCase())).sort((a, b) => b.name.length - a.name.length);
    cat = byName.length ? pickCat(byName[0].name.toLowerCase()) : null;
  }
  if (cat) {
    out.category_id = cat.id;
    if (!out.owner) out.owner = cat.owner_id == null ? 'both' : cat.owner_id === ctx.me.id ? 'me' : 'partner';
  }

  // title: the original wording minus the date/time/repeat words we used
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let title = ' ' + raw.replace(/,/g, ' ') + ' ';
  for (const u of used) title = title.replace(new RegExp(esc(u.trim()), 'i'), ' ');
  title = title.replace(/\b(at|on|from|every|each|next|the)\b/gi, ' ').replace(/@/g, ' ').replace(/\s+/g, ' ').trim();
  if (alias && alias.title) {
    const leftover = title.replace(new RegExp(alias.re.source, 'i'), ' ').replace(/\b(league|night)\b/i, ' ').replace(/\s+/g, ' ').trim();
    if (!leftover || /^(my|our|her|his|s)$/i.test(leftover) || alias.who) title = alias.title(lower);
    else title = title.replace(/\btourney\b/i, 'tournament').replace(/\bgg\b/i, 'Gutter Gussie');
  }
  title = title.replace(/^(my|our)\s+/i, '').trim();
  out.title = title ? title.charAt(0).toUpperCase() + title.slice(1) : null;
  return out;
}

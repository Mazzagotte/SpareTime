// U.S. holidays, calculated for any year — no outside service needed.

const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const dowOf = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

// nth weekday (0 = Sun) of a month; n = -1 for the last one.
function nthWeekday(y, m, weekday, n) {
  if (n > 0) {
    const first = dowOf(y, m, 1);
    return ymd(y, m, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
  }
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = dowOf(y, m, days);
  return ymd(y, m, days - ((last - weekday + 7) % 7));
}

// Western (Gregorian) Easter — anonymous computus.
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(y, month, day);
}

// When a fixed-date federal holiday falls on a weekend, offices observe Friday or Monday.
function observed(date) {
  const [y, m, d] = date.split('-').map(Number);
  const w = dowOf(y, m, d);
  if (w !== 0 && w !== 6) return null;
  const dt = new Date(Date.UTC(y, m - 1, d + (w === 6 ? -1 : 1)));
  return dt.toISOString().slice(0, 10);
}

/** Holidays for a year: [{ date, name, federal, observedFor? }] */
export function holidaysForYear(y) {
  const list = [];
  const federal = (date, name) => {
    list.push({ date, name, federal: true });
    const obs = observed(date);
    if (obs) list.push({ date: obs, name: `${name} (observed)`, federal: true, observedFor: date });
  };
  const other = (date, name) => list.push({ date, name, federal: false });

  federal(ymd(y, 1, 1), "New Year's Day");
  federal(nthWeekday(y, 1, 1, 3), 'Martin Luther King Jr. Day');
  other(ymd(y, 2, 14), "Valentine's Day");
  federal(nthWeekday(y, 2, 1, 3), "Presidents' Day");
  other(ymd(y, 3, 17), "St. Patrick's Day");
  other(easter(y), 'Easter');
  other(nthWeekday(y, 5, 0, 2), "Mother's Day");
  federal(nthWeekday(y, 5, 1, -1), 'Memorial Day');
  other(nthWeekday(y, 6, 0, 3), "Father's Day");
  federal(ymd(y, 6, 19), 'Juneteenth');
  federal(ymd(y, 7, 4), 'Independence Day');
  federal(nthWeekday(y, 9, 1, 1), 'Labor Day');
  federal(nthWeekday(y, 10, 1, 2), "Columbus / Indigenous Peoples' Day");
  other(ymd(y, 10, 31), 'Halloween');
  federal(ymd(y, 11, 11), 'Veterans Day');
  federal(nthWeekday(y, 11, 4, 4), 'Thanksgiving');
  other(ymd(y, 12, 24), 'Christmas Eve');
  federal(ymd(y, 12, 25), 'Christmas Day');
  other(ymd(y, 12, 31), "New Year's Eve");
  return list;
}

/** Map of date → holidays between two dates (inclusive). `which`: 'all' | 'federal' | 'off'. */
export function holidaysBetween(from, to, which = 'all') {
  const out = {};
  if (which === 'off') return out;
  // +1 year: a Saturday New Year's Day is observed on Dec 31 of the year before.
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)) + 1; y++) {
    for (const h of holidaysForYear(y)) {
      if (h.date < from || h.date > to) continue;
      if (which === 'federal' && !h.federal) continue;
      (out[h.date] ||= []).push(h);
    }
  }
  return out;
}

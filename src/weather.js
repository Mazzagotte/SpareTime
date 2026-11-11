// Forecasts from Open-Meteo (free, no API key) for the home location in the Worker's vars.

let memo = { at: 0, key: '', data: null };

export function describe(code) {
  if (code === 0) return { text: 'Clear', icon: 'sun' };
  if (code <= 2) return { text: 'Partly cloudy', icon: 'partly' };
  if (code === 3) return { text: 'Cloudy', icon: 'cloud' };
  if (code === 45 || code === 48) return { text: 'Fog', icon: 'cloud' };
  if (code >= 51 && code <= 57) return { text: 'Drizzle', icon: 'rain' };
  if (code >= 61 && code <= 67) return { text: 'Rain', icon: 'rain' };
  if (code >= 71 && code <= 77) return { text: 'Snow', icon: 'snow' };
  if (code >= 80 && code <= 82) return { text: 'Showers', icon: 'rain' };
  if (code === 85 || code === 86) return { text: 'Snow showers', icon: 'snow' };
  if (code >= 95) return { text: 'Thunderstorms', icon: 'storm' };
  return { text: 'Mixed', icon: 'cloud' };
}

// Returns { days: { 'YYYY-MM-DD': {...} }, hours: { 'YYYY-MM-DDTHH:00': {...} } } for the next 16 days.
// Local testing only (set WEATHER_FAKE=1 in .dev.vars): a made-up 16-day forecast.
function fakeForecast(env) {
  const codes = [0, 2, 3, 61, 71, 1, 0, 3, 2, 80, 0, 1, 3, 2, 0, 71];
  const base = new Date();
  const days = {};
  const hours = {};
  for (let i = 0; i < 16; i++) {
    const d = new Date(base.getTime() + i * 86400000).toLocaleDateString('en-CA', { timeZone: env.TIMEZONE });
    const code = codes[i];
    days[d] = { date: d, code, ...describe(code), high: 40 + (i % 7), low: 24 + (i % 5), precip: code >= 61 ? 70 : 10, snow: code === 71 ? 2 : 0 };
    for (let h = 0; h < 24; h++) hours[`${d}T${String(h).padStart(2, '0')}:00`] = { temp: 28 + Math.round(12 * Math.sin((h - 9) / 4)), code, ...describe(code), precip: days[d].precip };
  }
  return { place: env.HOME_NAME, days, hours };
}

export async function forecast(env) {
  if (env.WEATHER_FAKE === '1') return fakeForecast(env);
  const key = `${env.HOME_LAT},${env.HOME_LON}`;
  if (memo.data && memo.key === key && Date.now() - memo.at < 30 * 60000) return memo.data;
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({
    latitude: env.HOME_LAT,
    longitude: env.HOME_LON,
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,snowfall_sum',
    hourly: 'temperature_2m,weather_code,precipitation_probability',
    temperature_unit: 'fahrenheit',
    timezone: env.TIMEZONE,
    forecast_days: '16',
  }).toString();
  const res = await fetch(url, { headers: { 'user-agent': 'SpareTime calendar' } });
  if (!res.ok) throw new Error(`weather ${res.status}`);
  const j = await res.json();
  const days = {};
  j.daily.time.forEach((d, i) => {
    const code = j.daily.weather_code[i];
    days[d] = {
      date: d,
      code,
      ...describe(code),
      high: Math.round(j.daily.temperature_2m_max[i]),
      low: Math.round(j.daily.temperature_2m_min[i]),
      precip: j.daily.precipitation_probability_max[i] ?? 0,
      snow: j.daily.snowfall_sum[i] ?? 0,
    };
  });
  const hours = {};
  j.hourly.time.forEach((t, i) => {
    const code = j.hourly.weather_code[i];
    hours[t] = { temp: Math.round(j.hourly.temperature_2m[i]), code, ...describe(code), precip: j.hourly.precipitation_probability[i] ?? 0 };
  });
  const data = { place: env.HOME_NAME, days, hours };
  memo = { at: Date.now(), key, data };
  return data;
}

// Short summary for one date, optionally at a time ('HH:MM'). Null when the date is out of range.
export async function weatherFor(env, date, time) {
  try {
    const f = await forecast(env);
    const day = f.days[date];
    if (!day) return null;
    const hour = time ? f.hours[`${date}T${time.slice(0, 2)}:00`] : null;
    return {
      date,
      icon: (hour || day).icon,
      text: (hour || day).text,
      temp: hour ? hour.temp : null,
      high: day.high,
      low: day.low,
      precip: day.precip,
      snow: day.snow,
      place: f.place,
    };
  } catch (e) {
    console.log('weather unavailable', e && e.message);
    return null;
  }
}

export function isBadWeather(day) {
  return day && (day.snow > 0 || day.precip >= 60 || day.icon === 'storm');
}

# SpareTime

One calendar for the two of you. A home-screen web app for iPhone and Android, running free on Cloudflare Workers + D1.

- Shared, color-coded calendar (Month + Agenda) with each person's own categories
- "Both of us" events, repeating events, private / busy-only events
- Push notifications: partner adds/changes, reminders, both-booked, weather alerts, Sunday recap
- Quick add ("GG league every Thu 6:30"), Free together finder, countdown, reactions, on-my-way
- Multi-day events (tournaments, trips — up to 31 days), yearly repeats (birthdays, anniversaries), and search
- Week view (hour by hour), Sunday/Monday week start, duplicate events, edit/delete "just this one / this and future / all"
- Live updates (the app polls `/api/rev` every 15 s), per-person reminders on shared events, default reminders per category
- Forgot password: either person can reset the other's under Activity → Settings; backups via Activity → Download a backup
- Health: the scheduler records a heartbeat; if it fails you both get one alert a day and Activity shows a banner
- U.S. holidays (federal + popular ones, calculated in `public/holidays.js`); choose All / Federal only / Off under Activity → Settings

## Deploy

The D1 database (`sparetime`) already exists with its tables, and its id is in `wrangler.jsonc`.
Push-notification keys are created automatically the first time the app runs, so there are no secrets to set.

**Automatic (recommended):** Cloudflare dashboard → **Workers & Pages → Create → Import a repository** → pick this repo.
Keep the Worker name `sparetime` and set:

- **Build command:** `npm run migrate` — applies any new database migrations
- **Deploy command:** `npx wrangler deploy`

Every push to `main` then migrates the database (only new migrations run) and redeploys on its own.
If a push doesn't show up under **Deployments → View build history**, check that the Cloudflare Workers and Pages GitHub app has access to this repo.

**From your computer instead:**

```bash
npm install
npx wrangler login
npm run deploy        # applies new migrations, then deploys
```

## First run

1. Open the address on one phone. The setup screen creates both people (name + password each) and picks who's on this phone.
2. **iPhone:** in Safari tap **Share → Add to Home Screen**, then open SpareTime from the home screen. (iPhone only allows notifications for home-screen apps.)
   **Android:** Chrome will offer **Install app**, or use the ⋮ menu → **Add to Home screen**.
3. In the app go to **Activity → Turn on notifications**, then **Send a test**.
4. The other person signs in on their phone with the password you chose, and can change it under **Activity → Change password**.

## The address

The app runs only at `sparetime.mazzagotte.dev`; the `workers.dev` address is turned off so there's one place to install it from.
This needs `mazzagotte.dev` to be on Cloudflare (it shows under **Websites** in the dashboard). If it isn't yet, add it there
(free plan) and switch the domain's nameservers at your registrar to the two Cloudflare gives you — once that's active, deploy.

To use a different address, change the `pattern` in `wrangler.jsonc` **before** you both add the app to your home screens —
the icon and notifications are tied to the exact address.

## How it works

| Piece | Where |
|---|---|
| API (auth, events, categories, reactions, free time) | `src/api.js` |
| Scheduled job every 5 min (reminders, 8 AM partner heads-up, 6 PM weather, Sunday 7 PM recap) | `src/cron.js` |
| Web Push, no dependencies (VAPID + aes128gcm) | `src/push.js` |
| Weather (Open-Meteo, free, no key) | `src/weather.js` |
| Database schema | `migrations/0001_init.sql` |
| The app (no build step) | `public/` — `app.js`, `quickadd.js`, `styles.css`, `sw.js` |

Times are stored as wall-clock values in the `TIMEZONE` var (America/Denver).
Setup seeds categories you can rename or delete: Umpiring, Bowling, Ada County USBC (first person); Bowling, Gutter Gussie (second); Date night, Family (shared).

Everything fits Cloudflare's free plan: Workers (100k requests/day), D1 (5 GB), Cron Triggers.

## Search engines

The app sends `X-Robots-Tag: noindex` on every response and has a `noindex` meta tag, so Google won't list it.
`robots.txt` deliberately allows crawling — blocking it would stop Google from seeing the noindex.

## Local development

```bash
cp .dev.vars.example .dev.vars
npm run db:local
npm run dev                      # http://localhost:8787
```

`.dev.vars` options for testing only: `WEATHER_FAKE=1` (made-up forecast) and `DEV_TOOLS=1`, which enables
`GET /api/dev/cron?at=2026-11-21T03:00:00Z` to run the scheduled job as if it were that time. Never set these in production.

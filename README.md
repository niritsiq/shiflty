# Shiftly

Shift scheduling for Cybereason. Workers submit weekly availability. Admins build and publish the schedule.

The app is [`index.html`](index.html) plus a small sync server, [`server.js`](server.js). With the server running, the team shares one roster and one schedule. Opening the HTML file on its own is a local preview (data stays in that browser).

The live app is [shiflty.onrender.com](https://shiflty.onrender.com). Render serves the root `index.html` through `server.js`.

[GitHub Pages](https://niritsiq.github.io/shiflty/) is a splash only, in [`docs/index.html`](docs/index.html). It tells visitors this URL is the old demo and sends them to Render. In the repo, set **Settings → Pages** to branch `main` and folder `/docs`. Do not point Pages at the repository root — that file is the app. Keep `docs/` in git; it is the Pages site.

## Sign-in

Sign-in is email, then a 6-digit code from **Google Authenticator** (TOTP, RFC 6238, SHA-1, 30-second period). There is no Google Workspace SSO in v1.

An email can sign in only when both are true:

1. It matches `firstname.lastname@cybereason.com` — the local part is lowercase letters with exactly one dot between two name parts (`lotan.hadad@cybereason.com`). The server lowercases input before checking. Addresses with extra dots, a `+tag`, another domain, or a missing last name are rejected.
2. It is on the team roster (the allowlist). Admins add and remove people in the app. Open join and “request access” are closed.

The seeded roster is the 14 Cybereason employees listed below. **Nir Itzik** (`nir.itzik@cybereason.com`) is the admin. On the first boot after this change, admin rights that belonged to `niritzik23@gmail.com` are moved to Nir, and that Gmail address is removed because it does not match the email rule. Other people already on the roster whose emails match the rule stay. People who do not match are removed and can no longer sign in. Sessions are cleared once so the next sign-in enrolls a real authenticator. Existing authenticator secrets are kept. Admins can still reset someone’s authenticator from the team screen.

### Google Authenticator setup

The sign-in screen says to open Google Authenticator, tap +, and choose **Enter a setup key**. The setup key is on the screen, with a copy button. The account name is the Cybereason email, and the key type is **Time based**.

A QR code is optional. Scan it only with the scanner inside Google Authenticator (the + button). The phone camera opens the Passwords app for these codes, and a code from that app will not match.

Until the first code is confirmed, coming back to sign-in shows the same key, so a refresh does not throw away what you just typed. **Generate a new setup key**, or **Set up Google Authenticator again**, replaces a key that was saved in the wrong app, including one that was already confirmed. That still does not sign you in — the new code has to match. Reset 2FA on the Team tab does the same for someone else.

Verification accepts the current step and two steps either side, about a minute of clock drift. The allowlist, closed join, and the `AUTH_MOCK` default are unchanged.

Seeded employees (all non-admin except Nir):

- lotan.hadad@cybereason.com (Lotan Hadad)
- avital.lioubchits@cybereason.com (Avital Lioubchits)
- gal.mamon@cybereason.com (Gal Mamon)
- matan.razon@cybereason.com (Matan Razon)
- alon.shpilberg@cybereason.com (Alon Shpilberg)
- bar.belisha@cybereason.com (Bar Belisha)
- dana.balas@cybereason.com (Dana Balas)
- dana.bardin@cybereason.com (Dana Bardin)
- ori.hai@cybereason.com (Ori Hai)
- nir.itzik@cybereason.com (Nir Itzik) — admin
- alex.rivlis@cybereason.com (Alex Rivlis)
- shoshana.avni@cybereason.com (Shoshana Avni)
- ben.shalev@cybereason.com (Ben Shalev)
- shahar.eldar@cybereason.com (Shahar Eldar)

### AUTH_MOCK

Real TOTP is the default. Set `AUTH_MOCK=1` (or `true`) to skip the authenticator step and issue a session as soon as the email is on the roster. That is for local demos only. Leave it unset in production.

The client can see the flag without signing in:

- `GET /api/config` → `{ "authMock": false, "totpRequired": true, "emailRule": "firstname.lastname@cybereason.com" }`
- `GET /api/health` → body `ok json` or `ok db` (Railway healthcheck), header `X-Auth-Mock: 0` or `1`

### Error codes

| HTTP | `error` | When |
| --- | --- | --- |
| 400 | `invalid_email` | Email is not `firstname.lastname@cybereason.com` |
| 403 | `not_on_team` | Email matches the rule but is not an active roster member |
| 400 | `no_enrollment` | Code submitted before authenticator setup |
| 401 | `bad_code` | Authenticator code does not match |
| 403 | `join_closed` | Old join / request-access routes |
| 401 | `auth_required` | Missing or expired session |
| 403 | `admin_required` | Admin-only action (authenticator reset, roster edits) |
| 400 | `last_admin` | Save would leave the team with no admin |
| 400 | `duplicate_email` | Two roster rows share an email |
| 400 | `invalid_state` | Schedule payload is missing employees, weeks, or settings |
| 400 | `bad_request` | Body was not valid JSON |

## State shape

Shared state (`state` inside `state.json`, or the `state` key in Postgres) includes:

- `employees` — the allowlist
- `weeks` — availability and published schedules
- `settings` — shifts and staffing
- `notifications` — reserved, always an array (empty in v1)
- `channels` — reserved, always an array (empty in v1)

Later notification work can append to those arrays without a new top-level store. Item shape is not defined yet.

## Run

```bash
npm install
npm start
```

Then open the server URL (port 3000 unless `PORT` is set).

Useful environment variables:

- `AUTH_MOCK` — `1` skips TOTP. Unset means real Google Authenticator.
- `PORT` — listen port.
- `DATABASE_URL` — Postgres. Without it, the server stores JSON files.
- `SHIFTLY_DATA_DIR` — where `state.json`, `auth.json`, and `reminders-sent.json` go. Defaults to `/data` when that directory exists, otherwise the app directory. Those files are gitignored; do not commit them.
- `SMTP_USER`, `SMTP_PASS` — availability reminder email. Optional `SMTP_HOST`, `SMTP_PORT`, `APP_URL`, `REMINDER_TZ`.

`node test/auth.js` checks the email rule, TOTP, the closed join routes, and the seeded roster.

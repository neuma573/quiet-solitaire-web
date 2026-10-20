# Shared guest XP leaderboard

This directory is an independent gameplay Worker and D1 database. It does not
import, configure, or reuse the repository-dispatch Worker, its GitHub token,
webhook secret, or root `wrangler.jsonc`.

## Production deployment — 2026-10-20

The independent `quiet-solitaire-leaderboard` Worker is deployed at
`https://solitaire-api.neuma573.com`, with the separate D1 database of the same
name bound as `DB`. Both migrations (`0001_guest_xp.sql` and
`0002_bounded_cleanup.sql`) are applied. The hostname was absent before adding
the Worker Custom Domain; no existing DNS record was replaced.

Production uses `ALLOWED_ORIGIN=https://neuma573.com`, an empty `API_PREFIX`,
and a generated `RATE_LIMIT_SALT` stored only as an encrypted Worker secret.
`LOCAL_DEVELOPMENT` is absent. No API token, OAuth grant, paid plan, dispatch
Worker change, or original game repository change was needed. No cleanup cron
is configured. Existing platform logging settings were left unchanged (Workers
Logs enabled); the example config's disabled observability is not a statement
about the dashboard deployment. This API code never logs cookies, tokens, or
request bodies.

The production HTTPS board returns `200` with the empty, `client-reported`
board. Exact-origin credentialed CORS and preflight, foreign-origin rejection,
private `/me` rejection without Origin or a session, and invalid-limit rejection
were checked through live GET/OPTIONS requests. No production guest, run, win,
or XP was created for those checks. Authenticated cookie/CSRF writes, win/retry,
deletion and cleanup are covered by isolated tests; production writes and a
real browser's post-release cookie persistence remain separate checks.

The shared frontend config points to this same-site HTTPS hostname. That
connection takes effect only after its frontend PR is approved, merged, and
deployed. The game connects a guest automatically once the new frontend is
deployed, without uploading old local totals. An empty `apiBase` still disables API calls. GitHub Pages' alternate
`github.io` origin is intentionally not allowed; use `https://neuma573.com`.

The board orders cumulative XP descending, then account creation time and UUID
for deterministic ties. Its public rows contain only rank, nickname, XP, and
whether the row belongs to the requesting guest. All compatible current game
modes contribute to this one board; no time/move rankings or historical local
XP imports are supported. Guests with zero XP are omitted until their first win.

## API contract

`API_PREFIX` is stripped before matching the following paths. Trailing slashes
are removed from both the prefix and frontend API base; `/` means the root.
Every response is
`Cache-Control: no-store`. JSON errors are `{ "error": "code" }`.

| Method and path | Request | Response |
| --- | --- | --- |
| `POST /v1/session` | `{}` | `201` new, `200` restored: `{user:{id,nickname,xp},csrfToken}`; secure session cookie |
| `GET /v1/me` | cookie | `{user:{id,nickname,xp},csrfToken}` |
| `PATCH /v1/me` | `{nickname}` | `{user:{id,nickname,xp}}` |
| `DELETE /v1/me` | no body | `204`; removes guest and expires cookie |
| `POST /v1/runs` | `{mode:{difficulty,draw,scoring}}` | `201`: `{run:{id,mode,startedAt,expiresAt}}` |
| `POST /v1/runs/:id/result` | `{score,elapsedMs,moves,won:true}` + `Idempotency-Key` UUID | `201` new / `200` identical retry: `{result:{id,xpAwarded,verification:"client-reported"},user:{id,nickname,xp},replayed}` |
| `GET /v1/leaderboard?limit=25` | optional cookie; limit 1–50 | `{metric:"cumulative-xp",verification:"client-reported",rankedAvailable:false,entries:[{rank,nickname,xp,isMe}]}` |

Browser requests use `credentials: 'include'`. All mutations require `Origin`
equal to `ALLOWED_ORIGIN`; all authenticated mutations additionally require the
session's `X-CSRF-Token`. `GET /v1/me` also requires that exact Origin because it
returns the CSRF token. Same-origin browsers may omit Origin on GET, so `/me`
also accepts browser-controlled `Sec-Fetch-Site: same-origin` only when the API
URL origin itself equals the configured frontend origin. CORS reflects only the one configured origin and allows
credentials. POST/PATCH request bodies must be JSON and at most 2,048 bytes,
including when a sender omits or lies about Content-Length. Unknown fields are
rejected: submitted user IDs, nicknames, XP totals, and replacement run modes
cannot authorize or change a result.

Modes are exactly `difficulty: casual|normal|challenge`, `draw: 1|3`, and
`scoring: standard|vegas`. The server stores these with `quiet-xp-v1` when
issuing a random run UUID. The browser must finish its automatic cookie-owned
connection before starting a new game attempt. Runs started before connection, abandoned games, losses,
disconnected starts, and old local totals are never uploaded later.

Nickname changes use NFKC normalization, trimming, and collapsing ASCII spaces.
Names must be 2–20 Unicode codepoints and contain letters/numbers, with letters,
combining marks, numbers, ASCII spaces, `_` and `-` allowed. Control and format
characters, markup, emoji, and bidi overrides are rejected. Duplicate names are
allowed; the immutable server UUID defines identity. UI must still render names
using text nodes, never HTML.

## XP calculation and its trust limit

The existing XP rule is implemented locally as arithmetic, with no upstream file
copied or changed:

- Standard base: `100 + floor(max(0, score) / 100)`.
- Vegas: normalize the winning score as `floor(score * 10000 / 208)`, then use
  the same base. A claimed Vegas win must have final score exactly 208.
- Difficulty units: casual 8, normal 16, challenge 32; draw three multiplies
  units by 7/4; Vegas multiplies by 3/2.
- Award: `floor(base * units / 8)`. Only `won: true` can contribute.

The current result schema requires integer active seconds represented as
`elapsedMs` divisible by 1,000, 1 second–24 hours, and 1–100,000 moves. Reported
active time cannot exceed server wall time since run creation plus a five-second
timer tolerance. Under current Standard rules a committed move adds at most 15
points and the completion bonus is `floor(700000 / elapsedSeconds)` only after
30 seconds. Claims above `15 * moves + bonus` are rejected. These bounds imply
the schema's final-score cap of 1,522,580 and award cap of 107,275. A future rules
change needs a new ruleset and a reviewed formula/migration before use.

**The server verifies session ownership, not that the game was played or won.**
A modified browser can fabricate plausible wins, wait for run duration, and
farm XP. Receipts, bounds, and quotas reduce easy abuse but do not prevent it.
Every contribution and API board is explicitly `client-reported`;
`rankedAvailable` is always false. This is a usable shared casual board, not
competition-grade anti-cheat. Authoritative competitive results would require a
server-generated deal plus an independently verified legal action replay (or
server-authoritative gameplay), which is deliberately outside this change.

Run ownership is bound to the cookie-authenticated guest. A unique contribution
per run and per `(guest, idempotency key)` plus a database trigger commit the XP
increment exactly once. An identical retry returns its original contribution,
even after ticket expiry; changing its key, run, or payload returns `409`.
Repeated HTTP requests cannot award duplicate XP. This does not prevent creating
separate forged runs or additional guest identities.

## Identity, privacy and quotas

Each new guest receives a cryptographically random UUID, a random Korean
nickname, a separate 256-bit bearer cookie, and a session-bound CSRF token. Only
the bearer SHA-256 hash is stored. The `__Host-quiet_guest` cookie is Secure,
HttpOnly, SameSite=Strict, Path=/, and has no Domain attribute. UUIDs/nicknames
are never accepted as authentication. `/session` restores and renews the same
identity for 180 days; there is no login or recovery key.

New guests receive an automatic name from 32 descriptive adjective forms,
32 animal nouns, and a zero-padded three-digit suffix (`000`–`999`):
**1,024,000 distinct combinations**, for example `포근한 고양이042`.
Every combination is 7–13 Unicode characters including the space and digits,
within the unchanged 2–20-character server/client validation. Curated adjective
forms avoid dynamic Korean inflection and animal-specific action phrases.
The small static lists use one existing random-values call, with no AI/API
request, dependency, additional database query, or uniqueness retry.

The name is generated only on the new-guest INSERT and then stored in D1.
Restoring a session or refreshing the page does not regenerate it. Existing
automatic or manually saved names, including `API 점검`, remain unchanged;
there is no backfill or migration. Duplicate display names are allowed and
keep separate internal UUIDs, bearer sessions, and XP. A name is never an
authentication key or a promise of global uniqueness. Deploying the gameplay Worker is a separate operator
action; merging a web-repository PR alone does not update that Worker.

The game frontend automatically calls `POST /v1/session` (empty JSON), then
`GET /v1/me` to verify the browser accepted its cookie. The server restores a
valid bearer before considering a new identity; ID/nickname alone cannot do
that. In-flight connection calls share one promise and repeated UI boots share
one mount. [Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)
serialize session creation/renewal and deletion across same-origin tabs, with
a ten-second deadline. A single non-secret localStorage deletion-generation
marker stops pre-deletion tabs, including bfcache restores that missed storage
events. It contains no guest ID, nickname, bearer, CSRF token, or recovery key.
Boot captures it before loading config and cancels on early pagehide; a late
config response cannot start a session from a suspended page. If locks, browser
storage or cookies are unavailable, or the network
fails, the game and read-only board remain usable; no retry loop creates more
guests. A failed cookie verification stays blocked for that page lifecycle,
including repeated board refreshes; changing cookie settings requires a page
reload. The board refresh control can retry transient connection failures. The standalone
ranking page remains read-only and does not itself create guests.

There is no separate participation button or in-game introductory/verification
notice. Public API `client-reported` metadata, the standalone page's trust
notice, exact-origin CORS, CSRF, HttpOnly/Secure/Strict cookies, and quotas are
unchanged. Connected new attempts can submit their mode and winning result
fields listed above; no old local totals, profile IDs, or client-computed XP
are uploaded. A pagehide suspends the current attempt; a bfcache restore
reconnects the cookie without resuming that run.

`나의 모든 기록 삭제` retains confirmation. It removes this guest's **server
leaderboard** identity, nickname, XP and contributions, not device game saves or
local statistics. The confirmation states that scope and irreversibility.
Deletion does not immediately recreate a guest or resume uploads in that page;
a subsequent page load creates a fresh identity. `새로고침` only refreshes the
board/retries a failed connection and never resets records. No production
records are migrated or deleted by these source changes.

Clearing browser data, using another device/profile/browser, or letting the
180-day cookie expire loses access to that guest and its XP. Another visit to
`POST /session` while the cookie remains valid renews it. No cross-device
recovery exists without a future login/linking feature. Stealing the bearer
cookie or compromising the allowed frontend origin can still compromise a
guest.

`DELETE /v1/me` deletes the guest, sessions, runs, contributions and guest quota
buckets in one transaction, clears the cookie, and removes the public board row.
Network quota buckets remain until their short retention expires so deletion
cannot reset abuse limits. There is no IP or user-agent in profile/result data.
Network quotas store a daily-rotated HMAC of Cloudflare's `CF-Connecting-IP`,
using a separate secret; raw IPs are neither persisted nor logged by this code.
Cloudflare/platform request logs and backups are separate operator retention
concerns and must be reviewed before release. Cookie/CSRF/request bodies must
never be added to logs. Observability is disabled in both supplied configs.

Atomic fixed-window quotas currently allow 10 new guests/IP/hour, 120
mutations/IP/hour (including existing-session renewal), 60 run starts/guest/hour, 60 result submissions/guest/hour,
five nickname edits/guest/hour, and 240 board reads/IP/minute. Identical result
retries do not consume write quota. Shared networks may share an IP quota;
changing network or clearing cookies does not become Sybil protection.
`429` responses include a conservative `Retry-After: 3600`.

Cleanup removes at most 25 expired quota buckets, 25 expired sessions and 25
expired runs without results per invocation (75 temporary rows total). It never
deletes guests, cumulative XP, or completed runs/results, including inactive or
unrecoverable guests. Explicit guest-requested deletion remains unchanged.
The production example deliberately has no cron trigger. A cadence must be
chosen only after staged usage measurements and separate activation approval.
[CLEANUP.md](CLEANUP.md) covers indexes, migration cost, measurements and limits.

## Local development and checks

Node 22.13+ with built-in `node:sqlite` can run the backend tests without a
Cloudflare account:

```powershell
node --test tests/leaderboard*.test.mjs
```

The local-only `leaderboard/wrangler.jsonc` uses database name `leaderboard`,
zero placeholder database ID, no routes, `workers_dev: false`, and an openly
named local test salt. It must never be used as a production config. Root npm
scripts select this file explicitly. With Wrangler dependencies already
installed, from the repository root:

```powershell
npx wrangler d1 migrations apply leaderboard --local --config leaderboard/wrangler.jsonc
npx wrangler dev --local --config leaderboard/wrangler.jsonc
```

The default allowed local frontend origin is `http://localhost:8787`. For a
separate local static server, change the local `ALLOWED_ORIGIN` to that exact
origin, and set the frontend's API base to the local Worker URL. Keep the
same hostname (`localhost` on both) for cookies. LOCAL_DEVELOPMENT permits only
localhost/127.0.0.1 HTTP origins and a shared test bucket when Cloudflare's IP
header is absent. Production requires HTTPS and Cloudflare's trusted IP header.

For actual workerd/D1 integration, use an isolated local database and start
Wrangler with `--test-scheduled`; in another terminal run:

```powershell
node tests/leaderboard-runtime.mjs
```

This script refuses non-loopback targets. It creates two disposable guests,
checks auth/CSRF, concurrent result retries, computed XP, shared ordering,
nickname identity, deletion and the scheduled handler, then deletes its guests.
Run it against fresh temporary `--persist-to` storage, not a personal local
database. [VERIFICATION.md](VERIFICATION.md) records the tested runtime versions,
commands, results and remaining deployment boundary.

## Setup reference for a new environment

These are the chosen production values; new environments need their own
resource availability and approval checks:

| Resource or setting | Production value |
| --- | --- |
| New gameplay Worker | `quiet-solitaire-leaderboard` |
| New D1 database | `quiet-solitaire-leaderboard`, binding `DB` |
| New custom domain / frontend `apiBase` | `https://solitaire-api.neuma573.com` |
| `ALLOWED_ORIGIN` | `https://neuma573.com` (origin only, no project path) |
| `API_PREFIX` | empty string for that dedicated API hostname |
| `LOCAL_DEVELOPMENT` | absent in production |
| Database ID and account/zone IDs | use the intended environment's IDs; not frontend settings |
| Cleanup | no cron configured; cadence/activation pending usage validation |
| Runtime secret | `RATE_LIMIT_SALT`: a fresh random value with at least 32 bytes of entropy |

The salt only HMACs daily network quota keys; it is not a GitHub credential,
user ID, session bearer, or score-signing key. The runtime needs no Cloudflare
API token: D1 is accessed through the `DB` binding. Never commit a generated
production salt or copy it into the frontend config.

For operator setup, scope access to the intended Cloudflare account and zone.
Current [Workers roles](https://developers.cloudflare.com/workers/authorization/workers/)
require Workers product-level **Admin** for initial creation; later deployment,
secret and schedule changes need **Editor**, preferably scoped only to this
Worker. Attaching or changing either a route or custom domain additionally
needs **Zone > Workers Routes > Write** for the affected zone. Custom Domains
currently have per-Worker-role limitations, so check the intended setup flow.
Database creation and remote migrations need **Account > D1 > Edit** (called
`D1 Write` in API endpoint permission lists). Legacy endpoint permissions such
as `Workers Scripts Write` remain supported but are broader than a per-Worker
Editor. Account/Zone read access is only needed for tooling that discovers IDs;
use explicit known IDs where possible. Manual DNS edits, if separately needed,
require only the selected zone's DNS write. These setup privileges are not
needed by the gameplay runtime; deploying an existing DB binding alone needs
no direct D1 permission. Do not reuse the dispatch token or request Global API
Key access. Remove setup-only privileges from later deployment-only tokens
where feasible.
See the official [Worker upload permissions](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/),
[D1 creation permissions](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/create/),
and [custom-domain permissions](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/).

Before publishing, obtain approval for the following concrete choices/actions:

1. Choose a **new** gameplay Worker, a separate D1 database, and cost/retention
   expectations. Copy `wrangler.example.jsonc` to a separately named production
   config and replace its deliberately invalid origin/database placeholders.
2. Choose an HTTPS API address on the same origin or same site as the web app,
   for example a separately approved same-origin `/api/leaderboard/*` route or
   sibling subdomain of the site's custom domain. With a sibling hostname set
   `API_PREFIX` appropriately (usually empty). GitHub Pages → `workers.dev` is
   cross-site: Strict cookies will not work, and third-party cookies would be
   unreliable. Do not weaken cookies as a workaround.
3. Create the new database, apply this directory's migrations to that database,
   bind it as `DB`, and set a fresh high-entropy `RATE_LIMIT_SALT` as a Worker
   secret. Do not reuse dispatch secrets or commit production credentials.
4. Deploy only the new gameplay Worker with its separate production config and
   chosen route/domain. Leave cleanup scheduling disabled until its migration,
   retention scope, and staged usage have been reviewed. No dispatch Worker changes are
   needed. Configure the web-owned frontend API base only after the new API is
   ready; keep the frontend API base empty until that environment is ready.
5. Verify HTTPS cookie persistence, exact-origin CORS, private `/me`, nickname
   edits, one-time XP credit/retry, two independent browsers sharing the same
   board, deletion, cleanup, and no token/body logging in staging. Review the
   visible client-reported notice and privacy/retention wording before release.

Cloudflare's official [D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)
and [database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
describe binding and transaction semantics. Schema writes use bound parameters;
multi-statement guest creation/deletion/cleanup uses transactional `DB.batch`.
The contribution trigger and unique constraints live in the same SQLite
transaction as the insert, avoiding a client-side read/modify/write XP total.



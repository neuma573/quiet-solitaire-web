# Local runtime verification

Verified on 2026-10-19. No push, deployment, remote database, account creation,
Cloudflare login, credentials or DNS changes were performed.

## Runtime and tooling

- Node: `v24.19.0`.
- Wrangler: `4.149.0` (repository lockfile version).
- Miniflare: `5.20261006.1-alpha`; workerd: `1.20261006.1` (locked dependencies).
- Real Chrome HTTPS cookie test: Playwright with installed Google Chrome;
  all browser `.test` URLs intercepted in process, without network requests.

The workspace had no npm executable or installed dependencies. The bundled pnpm
was used in a dedicated temporary tooling directory containing copies of
`package.json` and `package-lock.json`. The offline attempt had no cached
metadata. Public npm metadata/package downloads were approved for tooling only;
36 packages were installed with package scripts disabled. The project package
and lockfiles were not changed. pnpm's store was kept inside the temporary
project to avoid a Windows project-registration symlink restriction.

The dependency preparation commands were:

```powershell
node <bundled-pnpm>/bin/pnpm.cjs --dir <TEMP_TOOLING> import --config.offline=true --config.enable-global-virtual-store=false --config.store-dir=<TEMP_TOOLING>/.store
# Offline result: ERR_PNPM_NO_OFFLINE_META (playwright metadata absent).
node <bundled-pnpm>/bin/pnpm.cjs --dir <TEMP_TOOLING> import --config.enable-global-virtual-store=false --config.store-dir=<TEMP_TOOLING>/.store
node <bundled-pnpm>/bin/pnpm.cjs --dir <TEMP_TOOLING> install --frozen-lockfile --ignore-scripts --node-linker=hoisted --config.enable-global-virtual-store=false --config.store-dir=<TEMP_TOOLING>/.store
```

## Actual local workerd and D1

Every Wrangler command explicitly selected `leaderboard/wrangler.jsonc`, which
has only the local placeholder database. `WRANGLER_SEND_METRICS=false`, `CI=true`,
`XDG_CONFIG_HOME=<TEMP_TOOLING>/xdg` and `WRANGLER_LOG_PATH=<TEMP_TOOLING>/...log`
kept configuration/logs separate from existing accounts and the repository.
The sandbox blocked workerd's loopback transport (`fetch failed`); approved
local-only execution outside that sandbox succeeded. No `--remote` flag,
deployment command, login command or remote resource mutation was used.

From the repository root, the exact command structure was:

```powershell
node <TEMP_TOOLING>/node_modules/wrangler/bin/wrangler.js --version
node <TEMP_TOOLING>/node_modules/wrangler/bin/wrangler.js d1 migrations apply leaderboard --local --config leaderboard/wrangler.jsonc --persist-to <TEMP_TOOLING>/d1-verified-state
node <TEMP_TOOLING>/node_modules/wrangler/bin/wrangler.js dev --local --ip 127.0.0.1 --port 8787 --test-scheduled --config leaderboard/wrangler.jsonc --persist-to <TEMP_TOOLING>/d1-verified-state
# A separate terminal while the preceding local server was running:
node tests/leaderboard-runtime.mjs
```

Results:

- Migration `0001_guest_xp.sql`: 14 commands executed successfully, applied.
- Worker started on `http://127.0.0.1:8787`; DB binding reported `local`.
- Session creation/restoration: `201`/`200`; wrong Origin and missing CSRF: `403`.
- Two simultaneous identical result requests: one `201`, one `200`; total XP
  stayed 208. Changed payload: `409`; arbitrary submitted XP field: `400`.
- Nickname edit preserved guest UUID and 208 XP. A second guest contributed
  300 XP; the shared board returned 300 before 208.
- Guest deletion: `204`; its subsequent `/me`: `401`. Other guest remained.
- `/__scheduled?cron=23+4+*+*+*`: `200`, actual scheduled cleanup handler ran.
- Test finally removed both disposable guests. A subsequent local-only D1
  query returned zero rows in all four data tables:

```sql
SELECT 'guests' AS table_name, COUNT(*) AS rows FROM guests
UNION ALL SELECT 'sessions', COUNT(*) FROM sessions
UNION ALL SELECT 'runs', COUNT(*) FROM runs
UNION ALL SELECT 'results', COUNT(*) FROM results;
```

The local Worker process was stopped after verification.

## Runtime-specific defect caught and fixed

The first workerd pass exposed a guest-deletion error that stock `node:sqlite`
tests did not reproduce: the hashed quota prefix made `LIKE 'user:<hash>:%'`
longer than D1's [50-byte LIKE/GLOB pattern limit](https://developers.cloudflare.com/d1/platform/limits/).
Deletion now uses an indexed, bound range from `user:<hash>:` (inclusive) to
`user:<hash>;` (exclusive). Every user quota key shares that fixed hash/colon
prefix; the range removes only that guest's buckets, without wildcard matching.
The corrected repository source passed the fresh-database runtime test above.
Temporary debugging occurred in a temporary source copy; no debug logging was
added to the API.

## Other checks and remaining boundary

`node --test tests/*.test.mjs`: **36 passed** after the runtime correction.
The optional `tests/leaderboard-api-browser.mjs` also verified real HTTPS
Secure/HttpOnly/SameSite=Strict cookies with the real handler, real SQLite and UI
client: reload persistence, two isolated browser contexts, shared XP ordering,
nickname identity preservation and deletion. Its sibling test API uses real
browser CORS and credential behavior; URLs are fulfilled locally in process.

Actual Cloudflare-hosted routing, custom-domain TLS/certificates, account
permissions, production secret installation, production D1 placement/limits and
public browser connectivity remain untested because no external setup was
authorized or performed. Gameplay claims remain client reported regardless of
these infrastructure checks; plausible forged wins remain possible.

## Godot Web verification and local environment diagnosis

Pinned official Godot 4.7.2 and its single-thread Web release template were
downloaded into task-local tooling and verified against the repository's
checksums. The original checkout remained clean at
`d856f79c8aa50ac95ddb6f4a8c0a4295570c6377`. The existing dispatch Worker and
deployment workflow were unchanged.

**Latest result: the canonical `scripts/build.py` run passed**, including the
original runner self-tests, all eight original suites (**227 cases, 111,320
checks, zero failures**), source startup, web-adapter import/startup, Web
release export, and PCK audit. No original source, assertion, case selection,
timeout, FPS or simulation clock was changed. The successful export's pipeline
metadata is `local-native-verification`.

Initial failures were **local**, not a GitHub failure. The original Windows
runner self-test could not create a symlink. Initial WSL runs then reached
`menus.test_victory_result_lifecycle` but failed this assertion:

```text
reduced result continues fading instead of appearing instantly
Invalid call. Nonexistent function 'custom_step' in base 'Nil'.
at test_victory_result_lifecycle (res://test/suites/menus.gd:51)
```

This occurred before `apply_overlay`. The exact same source SHA and Godot
version had already passed [GitHub run 39178261777](https://github.com/neuma573/quiet-solitaire-web/actions/runs/39178261777).
The successful CI used Azure Ubuntu 24.04.5, kernel 6.17.0-1022-azure and native
runner-temporary tool/data/log paths. Local WSL used Ubuntu 24.04.1, kernel
6.18.33.2-microsoft-standard-WSL2. Both used the original `--headless` runner
and the same font isolation. Exact CI locale/display variables were not logged.
Initial local WSL had `LANG=C.UTF-8`, `DISPLAY=:0`, `WAYLAND_DISPLAY=wayland-0`,
and mounted-Windows executable/user-data/log paths, even in the attempt that
moved only the temporary project to native Linux `/tmp`.

The test lets a 0.18-second fade advance over two engine frames **before**
pausing it, then manually adds 0.06 + 0.06 seconds while asserting it is still
in progress. Automatic pre-pause progress of approximately 0.06 seconds can
therefore finish the fade early and clear the tween before the next call.
Private, assertion-preserving instrumentation confirmed nonzero automatic
progress (22.77/25.08 ms in a separate Windows probe). The initial WSL logs did
not capture exact tween deltas. This establishes a timing-sensitive test;
neither kernel version nor a particular filesystem operation alone is proven
to be the cause.

One bounded canonical run placed **all** executable, user-data, cache, temporary
project, diagnostics and export paths on native Linux storage, with display
variables unset, `CI=true`, `LANG=C.UTF-8`, and unchanged font isolation. It
passed every original test and the entire build. This removes the local
verification blocker and supports an environment/timing explanation rather
than a new source regression. Fixed-FPS forcing was deliberately not used.
No CI workflow change is needed: its existing paths are already native Linux.

For WSL verification, keep the complete test environment native, not only the
project. With the already checksum-verified matching tools, a reproducible
command structure is:

```sh
task_root="$(mktemp -d /tmp/quiet-web-check.XXXXXX)"
mkdir -p "$task_root/tmp" "$task_root/data" "$task_root/config" "$task_root/cache" "$task_root/tools"
cp /path/to/pinned-linux-godot "$task_root/tools/godot"
chmod +x "$task_root/tools/godot"
cp /path/to/pinned-web_nothreads_release.zip "$task_root/tools/web_nothreads_release.zip"
env -u DISPLAY -u WAYLAND_DISPLAY CI=true LANG=C.UTF-8 \
  TMPDIR="$task_root/tmp" XDG_DATA_HOME="$task_root/data" \
  XDG_CONFIG_HOME="$task_root/config" XDG_CACHE_HOME="$task_root/cache" \
  python3 scripts/build.py --source /path/to/read-only-checkout \
  --output "$task_root/site" --godot "$task_root/tools/godot" \
  --template "$task_root/tools/web_nothreads_release.zip"
```

Earlier independent browser diagnosis used an explicitly non-publishable
`diagnostic-only` export while the local gate was failing. The final checks
below were repeated on the **successful canonical export**. All private logs
and instrumented diagnostic copies stayed outside the repository; no bypass
option was added to the build script.

| Check | Actual outcome |
| --- | --- |
| Canonical source tests and Godot Web release export | Passed with all 227 cases and current compiled adapter |
| Existing PCK audit | Passed: 123 entries, compiled bridge present, zero raw `.gd`, exactly two runtime deal JSON files |
| Existing browser smoke, density 1 | Passed: fixed viewport, resize, menu/game path, draw and undo; no runtime/asset errors |
| Existing browser smoke, density 2 | Passed with the same assertions and no runtime/asset errors |
| Compiled native My Page integration | Passed: native button opens HTML; rename updates native label; score/draw filters and page recreation preserve it; guest deletion restores original label |
| Web-repository tests | 27 Python and 36 Node tests passed after all corrections |

The existing smoke script was executed without behavioral changes (an identical
copy was placed next to temporary locked Playwright dependencies for module
resolution), using only a temporary loopback server:

```powershell
node scripts/smoke.mjs --directory <CANONICAL_EXPORT> --density 1
node scripts/smoke.mjs --directory <CANONICAL_EXPORT> --density 2
node tests/leaderboard-export-browser.mjs --directory <CANONICAL_EXPORT> --screenshots <TEMP_SCREENSHOTS>
```

The native-integration test serves the actual exported files through HTTPS
`.test` request interception and the real API handler/SQLite. Its narrowly
documented fixture limitation is that AudioWorklet-internal module requests
bypass Playwright interception: exactly two known module-network errors are
excluded from this fixture, and every other runtime error still fails it.
Both ordinary HTTP smoke runs above loaded the real audio modules without
those errors. This test does not pretend a completed game was played; fresh
attempt/completion and duplicate-win observer behavior are covered by the real
Godot lifecycle fixture and server idempotency tests.

The second pass fixed two integration defects: native statistics refreshes
overwriting the web nickname, and D1's quota-deletion pattern limit described
above. It also pinned the actual XP formula/accounting source hashes. No new
features or original-source edits were introduced.

The local verification gate is now satisfied. The original test's timing
sensitivity is documented; this work does not alter it or weaken release
checks. External resource creation, secret installation, custom-domain
attachment, publication and deployment remain unapproved and unperformed.

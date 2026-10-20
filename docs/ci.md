# Core CI and manual regression

Normal `ci/**` pushes keep the original **entire headless source suite**, startup
check, guarded release export, SHA/file-hash compatibility checks, font hashes,
public asset allowlist and PCK secret/source audit. The compiled layout fixture
also stays: it verifies long columns, readable headers, drag and Undo across
light/dark and English/Japanese cases. This cheap headless coverage is separate
from the costly browser rendering matrix.

The runtime browser gate uses two fresh Chromium pages: a 390×760 touch phone at
2× density and a 1440×1000 mouse desktop at 1×. Each checks disabled API config,
HTML dialog focus return, native difficulty selection, outside dismissal, Back,
page recreation, real stock input and exact rendered Undo. The phone samples
320×568, 390×664 and 430×932 reflow, then verifies the restored board. Both reject
console/asset errors and all external requests. Only local `--directory` exports
are accepted; there is no production URL option. No unconditional sleeps are
used: static rendered regions must change and settle, native popup geometry must
appear/disappear, and DOM/canvas conditions must hold within existing generous
load deadlines. A deadline fails a stalled action; it never retries input.

`Check deployment configuration` runs once per PR update and once on main push
(no second `ci/**` push trigger). It retains all Node/Python tests, including
rules/XP, auth, CSRF/CORS, deletion isolation and publication gates, plus the cheap
intercepted browser UI/API and standalone page tests. Runtime validation repeats
Python with Godot available to exercise the compiled bridge. npm's download cache
is keyed by setup-node's platform/lockfile support; `npm ci --ignore-scripts` still
installs the pinned dependencies. No build, private source or browser cache is
introduced.

Validation uses workflow/ref concurrency with cancellation of superseded
validation runs. Deploy keeps its existing global publication concurrency with
`cancel-in-progress: false`, SHA freshness gate and audited atomic Pages upload.
No deploy is initiated by this CI change's branch or PR.

## Explicit full regression

In Actions, select **Validate guarded Web runtime → Run workflow → regression:
full** on the desired branch/ref (available after this workflow is on main).
The default is `core`. Full additionally runs both original density smokes,
compiled My Page/guest API integration, all eight native popup journeys, all 44
light/dark viewport combinations and the follow-up macOS WebKit matrix against
the exact audited Linux artifact. The original full scripts remain unchanged.
Use full for input, fonts, theme, viewport, browser or overlay changes and before
a release that needs those broader assurances.

Normal pushes no longer cover all native popup rows across eight fresh contexts,
fractional density, dark browser appearance, 44 viewport/theme rendering samples,
the compiled guest API end-to-end scenario, or WebKit. Node/API/bridge/headless
checks and the two actual compiled journeys still cover their core behavior;
these are explicit reductions in rendering coverage, not a claim of equivalence.

Successful core runs store no screenshots or full runtime bundle. Core failure
captures are retained for one day; the small public timing JSONL is retained for
one day. Full uploads only the audited public runtime and browser evidence needed
by WebKit, also for one day. Private source and diagnostics are never uploaded.

## Measurement

`python3 scripts/measure.py <stage> -- <command...>` preserves nonzero exit
status, prints `CI_TIMING` JSON and appends public stage durations to the Actions
summary. Runtime validation records toolchain, Python/compiled bridge,
source headless suite/export, compiled layout and core browser separately.
Manual full runs also label each costly browser stage and WebKit. The records
contain stage name, elapsed seconds and exit code; no private log content.

Baseline: [run 39385693390](https://github.com/neuma573/quiet-solitaire-web/actions/runs/39385693390)
on PR18 `fd56e62669d66536d09de2c09fef923b19a9abf3`, Ubuntu 24.04:

| Existing runtime stage | Seconds |
| --- | ---: |
| Toolchain | 5 |
| Python/compiled bridge | 1 |
| Entire source headless suite and guarded export | 164 |
| Compiled responsive layout | 7 |
| Node setup and browser dependency installation | 33 |
| Two density browser smokes | 88 |
| Exported leaderboard page | 3 |
| Compiled My Page/API | 33 |
| Eight popup journeys and 44 viewport renders | 554 |
| Runtime job including setup/upload/cleanup | 902 |

The baseline runtime artifact was 38,192,297 bytes compressed; its 116 PNGs and
subsequent WebKit artifact (9,496,041 bytes) are absent from successful core runs.
The baseline popup script has approximately 145 seconds of unconditional waits
and over 360 capture operations. Full keeps that historical diagnostic matrix.

A local macOS Chrome check against that **same audited Linux export** passed both
new journeys: mobile 52.537s / 37 captures, desktop 36.736s / 38 captures;
110.523s process total including browser startup, zero saved PNGs. This is a local
measurement, not an Ubuntu runner comparison or a total CI time promise. Actions
stage records and the PR validation notes provide the same-runner after results.

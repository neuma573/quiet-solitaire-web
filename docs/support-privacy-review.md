# Support and iOS privacy release record

The operator authorized publication of the support and iOS privacy pages on
2026-11-06. The policy's effective and last-updated date is 2026-11-06. This date
is a fixed publication date, not a value recalculated on every website build.
If the first publication does not take place on that day, change it before
release.

## Routes and scope

- Support: `https://neuma573.com/quiet-solitaire-web/support/`
- iOS privacy: `https://neuma573.com/quiet-solitaire-web/privacy/`

Both pages have Korean and English sections and work without JavaScript.
They load no game, leaderboard API, remote fonts, analytics or tracking scripts.
Normal website-host request processing is outside that statement. The privacy
policy applies to the iOS app, not to the experimental web guest leaderboard.

The pages and `information.css` are explicit `PUBLIC_WEB_ASSETS` entries in
`scripts/build.py`. Backend files and this review document remain excluded from
website build output. The existing main deployment workflow is unchanged.

## Approved operator decisions and ongoing responsibilities

- Operator and privacy contact: **나호진**.
- Support address: **neuma573@gmail.com**.
- Support correspondence and attachments: retain **one year after the inquiry
  is resolved, then delete**.

The one-year rule is an operator commitment, not a deletion feature of this
website. Record resolution dates, track one-year deadlines, and carry out and
verify deletion of correspondence and attachments. Review Gmail Trash and any
independent exports or backups; archiving is not deletion. Provider-managed
recovery or backup copies follow the provider's processes. This change does not
create Gmail rules, labels, deletion jobs or mailbox actions, and makes no
promise of an automated deletion system or a response deadline.

When app features or operational data practices change, update both language
versions and the revision date before publishing an inaccurate statement.
App Store Connect privacy answers, actual Apple diagnostic/crash reporting
received by the operator, and release-specific requirements must be reviewed
in their own context. Source declarations alone do not establish those settings.
No unconfirmed company, address, age restriction, legal-compliance guarantee or
provider retention period has been invented.

## Data-flow facts checked

The iOS source was rechecked on 2026-11-06. Game Center provides authentication,
display name, game-scoped player ID, profile photo and the system dashboard.
App-held profile data is memory-only. The implementation does not submit
scores, XP or achievements, run a Game Center leaderboard, or sync local
statistics through Game Center. Local settings, statistics, XP, completed-deal
history and selection progress are persisted on the device. An unfinished
board and Undo are not restored after an app restart.

The web guest leaderboard is separate. It stores guest identities, nicknames,
XP, sessions, attempts and results, and uses cookies and network rate limits.
Clearing cookies does not delete server records. Its delete control removes
the guest's server data, not device statistics. The cookie's 180-day validity is
not a retention period for all server data. The backend has no automatic
guest/XP/result expiry. Platform logs and backups are separate operator matters.

Apple references verified on 2026-11-05:

- <https://www.apple.com/legal/privacy/data/en/game-center/>
- <https://www.apple.com/legal/privacy/>

Apple describes its own Game Center processing. Its generic description of
scores and achievements does not mean this app submits those data. The public
policy links Apple information instead of inventing Apple retention promises.

The app's in-app privacy link, App Store support/privacy URL fields, app builds
and store submission are outside this web-only PR. Do not treat publication of
these two pages as completion of those separate steps.

## Verification

From this repository root:

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
npm test
node tests/information-pages-browser.mjs
```

The browser test uses copied allowlisted assets at the Pages subpath and serves
all requests locally. It checks desktop/mobile sizes, JavaScript disabled,
keyboard navigation, contact URLs, relative links, 200% body text, 44×44px
navigation/contact targets and absence of cookies/storage writes. Screenshots
are ignored under `artifacts/information-pages/`. `PLAYWRIGHT_MODULE` and
`CHROME_BIN` can select existing local installations.

- Python unit tests: 39 passed on the final policy text.
- Node tests: 75 passed on the final policy text.
- `git diff --check` and browser-test syntax: passed.
- Final Mac browser review on 2026-11-06: the committed browser test at
  `a38c4667aacc5caea911b9d2ba69b7b29be4126a` passed unchanged, exit code 0.
  All 16 viewport/JavaScript combinations, 200% body text, 44×44px touch
  targets, keyboard navigation and relative links passed. All 84 requests
  stayed local; there were no external requests or cookies/storage writes.
- Desktop, mobile and 320px screenshots were opened for visual inspection.
  No clipping or overlap remained; the 320px Korean link measured 44×44px.
  Both languages, publication date and absence of draft/noindex text were
  checked. No temporary test patch was needed.
- Full Godot export is performed by the existing deployment workflow, not by
  the static-page tests. Real-device/App Store behavior is a separate check.

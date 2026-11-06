# Support and iOS privacy pages: publication review

Status: **prepared for review; not approved for publication**.
Both pages visibly say they are drafts and use `noindex`. These are review
markers, not access controls. Do not deploy this draft or use it as the final
App Store privacy policy.

## Prepared routes

After a separately approved main merge and normal Pages deployment:

- Support: `https://neuma573.com/quiet-solitaire-web/support/`
- iOS privacy: `https://neuma573.com/quiet-solitaire-web/privacy/`

These are intended paths, not a statement that either page is live. Both pages
have Korean and English sections, work without JavaScript, and use the approved
public contact `neuma573@gmail.com`. They load no game, leaderboard API, remote
fonts, analytics or tracking scripts. Normal website-host request processing is
outside that statement.

The pages and `information.css` are explicit `PUBLIC_WEB_ASSETS` entries in
`scripts/build.py`. Backend files and this review document remain excluded.
The existing main deployment workflow is unchanged: **merging to main can
publish the pages**, so finish the review first. No app source change is part of
this work.

## Confirmed operator decisions

- Operator and privacy contact: **나호진**. Keep the approved name in both
  language versions; do not invent a company, postal address or romanization.
- Support address: **neuma573@gmail.com**.
- Support correspondence and attachments: retain **one year after the inquiry
  is resolved, then delete**. This is a commitment the operator must actually
  implement, not an email-deletion feature of this website.

## Confirm before publication

- Ensure any additional operator or jurisdiction disclosures required for the
  actual release are correct. No unconfirmed company or address is inserted.
- Confirm the distributed iOS build matches the features described here, and
  reconcile App Store Connect privacy answers and enabled Apple services.
- Put the approved one-year support-mail rule into an actual operational
  process. Record when an inquiry is resolved, track its one-year deadline,
  delete the correspondence and attachments when due, and confirm the result.
  Review Gmail Trash, recovery copies and any separate exports/backups; moving
  a message to an archive is not deletion. No Gmail filters, labels, deletion
  jobs or mailbox actions have been created by this change. No promise of an
  automatic deletion system or response deadline is made.
- Confirm the support mailbox's provider, recovery/backup behavior and any
  service-provider or international-transfer disclosures applicable to the
  actual release. The approved address is a Gmail address, but its account
  settings and any independent copies have not been inspected.
- Confirm whether Apple diagnostic/crash reports are received by the developer
  and whether they need to be described. A source SDK check cannot establish
  the developer's App Store/Apple reporting settings.
- Confirm intended audience, age-related disclosures, applicable jurisdictions
  and other legal requirements with appropriate review. This draft does not
  claim to be a legal-compliance certification.
- Confirm practical app-data deletion and backup guidance. Do not promise that
  deleting the app erases Apple-held records or existing device backups.
- Set the effective date to the **actual first publication date**, not the
  draft preparation date. The current page explicitly marks it as pending;
  `2026-11-05` is only the draft revision date. If a release is delayed, update
  the date before publishing. Do not inject the build date automatically on
  every later build, because that would silently change the effective date.
  Reconcile both language versions and remove the draft notices, operational
  review notes, draft title/link wording and `noindex` only for the approved
  publication.
- Review separately how the website/hosting provider handles requests and logs.
  The iOS policy is deliberately not a web-game/leaderboard privacy policy.

## Platform boundaries checked

The iOS implementation currently uses Game Center for authentication, profile
name/photo and the system dashboard. It does not submit scores, XP or
achievements, run a Game Center leaderboard, or sync local statistics through
Game Center. App-held profile data is memory-only. Local settings, statistics,
XP, completed-deal history and selection progress are persisted on the device.
An unfinished board and Undo are not restored after an app restart. No in-app
data-reset control or privacy-policy link was found in the reviewed app.

The web guest leaderboard is separate. Its existing implementation stores
server guest identities, nicknames, XP, sessions, attempts and results, and
uses cookies and network rate limits. Clearing cookies is not server deletion;
its existing delete control removes server guest data, not device statistics.
The cookie's 180-day validity is not a retention period for all server data.
The backend has no automatic guest/XP/result expiry. Platform logs/backups are operator decisions, not facts inferred from code.
The support-mail one-year rule is now an explicit operator decision and still
requires operational implementation.

Official Apple references verified on 2026-11-05:

- <https://www.apple.com/legal/privacy/data/en/game-center/>
- <https://www.apple.com/legal/privacy/>

Apple describes its own Game Center processing. Its generic description of
scores and achievements does not establish that this app submits those data.

## Remaining integration

- The app's in-app privacy-policy link is not implemented by this web-only
  change. Add it in a separately authorized app task after the final page is
  approved and live.
- Set the final support and privacy URLs in App Store Connect only after the
  live routes and policy have been checked. This work does not submit an app,
  update App Store metadata, merge, or deploy.

## Local checks

From this repository root:

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
npm test
node tests/information-pages-browser.mjs
```

The browser test uses the exact allowlisted output at the Pages subpath, serves
all requests locally, and tests desktop/mobile sizes, JavaScript disabled,
keyboard navigation, contact URLs, cross-page links, 200% body text, and absence
of cookies/storage writes. It does not send email, contact production APIs or
verify App Store/device behavior. Screenshots default to ignored
`artifacts/information-pages/`. `PLAYWRIGHT_MODULE` and `CHROME_BIN` may select
existing local Playwright/Chromium installations.

### Results for this prepared change

- Python unit tests: 39 passed on the final local code.
- Node tests: 75 passed on the final local code.
- `git diff --check` and browser-test JavaScript syntax check: passed.
- Chromium could not start in the initial cloud environment because the
  required local socket operation is unavailable there.
- On the connected Mac, the `ce9e38a` input plus the `7271b6c` support notice
  passed 16 viewport/JavaScript combinations, 200% body-text enlargement,
  keyboard navigation and relative-link checks using a minimally corrected
  test copy. All page requests were local fixtures; cookies and local/session
  storage remained empty. Ten desktop/mobile/320px enlarged screenshots were
  opened and visually checked, with no horizontal clipping or overlap found.
- The original `page.addStyleTag` test call stalled with JavaScript disabled.
  The tested synchronous DOM style insertion has now been incorporated in
  `tests/information-pages-browser.mjs`.
- The Mac check found the Korean language link was only about 36px wide.
  The final local change (`bb20136`) adds a 44px minimum width and tests both
  width and height. Its final browser recheck was **not executed**: the Mac reported
  `exec-server transport disconnected` before process creation, and recovery
  timed out. The final CSS/test changes were not applied to the Mac copy. Do
  not describe this final sizing change as browser-verified. Once reconnected,
  apply those changes in the same temporary verification task and rerun it.
- Full Godot export and real-device/App Store checks were not run for these
  static page changes. The public asset-copy step was tested directly.

# Source compatibility

The source SHA is recorded in deployment.json for traceability, not approval.
Whole-file source hashes and the former hook/XP and prepared-file manifests are
not Web build gates.

Caption corrections still require each exact edit anchor once, no existing
replacement, and an exact round-trip check. All target paths are checked before
any write. These conditions are needed to apply the existing Web-only patch;
unrelated source changes do not block it.

The leaderboard autoload stays in the disposable Web project, including its
responsive sizing, font, popup/touch and ranking adaptations. Import and release
export check that the project can build, without repeating source or browser
regression tests.

Toolchain/font integrity, path/symlink safety, the public asset allowlist, and
PCK/private-source/secret audits remain. The original checkout and API Workers are
not modified by these build changes.

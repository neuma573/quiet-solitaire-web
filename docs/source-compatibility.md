# Source compatibility gates

The source commit SHA is recorded in deployment.json for traceability. It is not a per-commit approval list. The source_sha fields in compatibility manifests retain historical review provenance.

Caption corrections require each exact old anchor once, no pre-existing replacement, and an exact round-trip check after replacement. All target files are validated before any write. Unrelated source text and historical whole-file caption hashes do not block builds.

The leaderboard retains the seven hook/XP file contracts and the prepared main.gd contract. visuals.gd is no longer a whole-file leaderboard gate: imports, export and representative Web smoke validate renderer changes. Game logic or XP changes can still require integration review; this small change does not remove those protections.

Existing font checksums, path/symlink checks, no-original-checkout mutation, PCK/source/secret audit, public asset allowlist, API authentication/CSRF/CORS and stored-record behavior remain unchanged. No new browser matrix is added.

A game-only fallback is deliberately excluded from this patch. The current leaderboard autoload also supplies responsive board sizing and native popup/touch adaptations. Removing it would also remove those game adaptations and change core smoke assumptions; separating these responsibilities needs its own small follow-up, rather than publishing a partially patched project.

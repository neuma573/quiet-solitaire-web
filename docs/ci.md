# Build-only Web CI

`Validate Web build` runs once on each `ci/**` push and can be started manually.
It reads current private source main with the existing read-only deploy key,
installs the pinned Godot toolchain, prepares the temporary Web project, and
imports and exports the release. `source.py --validate` ensures validation builds
even when that source revision is already deployed.

The Web build does not rerun the private source tests, Python/Node suites,
standalone startup checks, compiled layout tests, or Chromium/WebKit regressions.
The duplicate PR configuration workflow and manual full-regression option are
removed. Existing local diagnostic utilities are not CI requirements.

Whole-file source hash approvals are removed. The build retains the edit anchors
needed to apply caption corrections, toolchain/font integrity checks, safe paths,
the public asset allowlist, required runtime files, and PCK/private-source/secret
audits. Private source and diagnostic logs are not uploaded.

Deploy runs on web main or its existing source/manual dispatch triggers and uses
the same build. Source freshness, publication deduplication, permissions and
concurrency remain unchanged. Validation branches do not publish. A successful
Web build confirms import/export and artifact checks, not gameplay or browser
behavior; core game tests remain the source repository's responsibility.

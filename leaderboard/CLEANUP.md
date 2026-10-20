# Bounded temporary-data cleanup

`cleanup(env, now)` deletes **at most 25 rows from each of three tables** in one
transactional `DB.batch` call: expired `rate_limits`, expired `sessions`, and
expired `runs` without a result. The fixed ceiling is 75 temporary rows per
invocation. There is no drain loop and callers cannot raise the batch size.
Rows with expiry equal to the cutoff remain until a later invocation.

Guests, their cumulative XP, completed runs and results are preserved, regardless
of age or session recoverability. The former one-year inactive-guest purge is
removed. The explicit authenticated `DELETE /v1/me` contract is unchanged.
Retention cleanup does not reset network quotas before their expiry.

## Candidate selection and indexes

The quota/session candidate subqueries select bounded rowids in expiry order
using the existing `rate_limits_expiry` and `sessions_expiry` covering indexes.
They do not scan profiles or history. `0002_bounded_cleanup.sql` adds a
`cleanup_pending` marker to runs, backfills completed history, and creates
`runs_cleanup_pending_expiry` on `(expires_at, id)` for pending runs only.
An `AFTER INSERT` result trigger marks its run complete in the same transaction
as the contribution and existing XP-credit trigger. Identical retries cannot
fire either trigger twice. If an XP update fails, the marker change rolls back
with the contribution.

The run candidate subquery applies its 25-row limit **before** checking the
results table. A separate indexed `NOT EXISTS` guard on the outer delete also
protects completed history if a marker is stale. Stale markers can delay cleanup
progress and require operator repair; they cannot cause cleanup to remove the
corresponding completed result. No schema guard or authentication check is
relaxed. Local query plans use the pending covering index and indexed result
lookups, with no full history scan or temporary order-by tree.

The marker update and new index add write/storage work when a result completes.
The 75-row deletion ceiling is **not** a ceiling on billed D1 rows read/written,
index maintenance, SQL duration or Worker CPU. These must be measured separately.

## One-time migration versus recurring work

Migration 0002 backfills all existing completed runs and builds its index. This
one-time work scales with existing history and is not batch-limited. Do not
confuse it with the bounded cleanup queries. Stage the migration against a
representative copy, assess its own SQL/row costs and recovery procedure, and
apply it before deploying the new cleanup handler. The existing cloud database
has not received migration 0002 as part of this change.

## Measurements and reproducible checks

On this Mac, Node `v25.9.0` with in-memory `node:sqlite`:

```sh
node --test tests/*.test.mjs
node tests/leaderboard-cleanup-benchmark.mjs
```

All **60 Node tests** passed on 2026-10-20. New coverage includes preservation
of a 900-day-old guest with no session/XP, expiry boundaries, per-table and total
caps, 50,000 completed games plus 1,000 pending expired rows per temporary
table, 40 successive bounded cleanup invocations, stale-marker defense,
migration backfill, trigger/XP integrity, batch rollback and the scheduled
adapter. Existing origin/CSRF, quota, result replay, deletion and UI tests pass.
The decoder regression also covers Unicode, a UTF-8 BOM and malformed UTF-8.

The benchmark seeds 1,000 expired and 1,000 unexpired pending rows per temporary
table, then measures 20 cleanup invocations after a legacy-schema migration.
Every invocation deleted exactly 75 temporary rows; completed history remained.
These are illustrative local timings, not Cloudflare performance or quota
predictions. Seeding is excluded; local process CPU includes the SQLite adapter,
query-plan inspection, JavaScript and possible GC.

| Completed history | Cleanup median wall ms | Cleanup median local CPU ms | One-time migration wall ms |
| ---: | ---: | ---: | ---: |
| 1,000 | 0.217 | 0.218 | 2.237 |
| 10,000 | 0.205 | 0.205 | 10.229 |
| 50,000 | 0.213 | 0.214 | 50.354 |
| 100,000 | 0.206 | 0.207 | 103.002 |

`cleanup()` returns only aggregate deletion counts and, when D1 supplies them,
summed `meta.rows_read`, `meta.rows_written` and `meta.duration` as
`usage.rowsRead`, `rowsWritten` and `databaseDurationMs`. Unavailable values are
`null`, not zero. It emits no logs and exposes no new HTTP endpoint. D1 SQL
duration is not Worker CPU; see the official
[D1 return-object definitions](https://developers.cloudflare.com/d1/worker-api/return-object/).

Real Cloudflare `rows_read`, `rows_written`, Worker CPU and actual workerd/D1
compatibility of this new migration/cleanup have **not** been measured in this
execution. Local SQLite cannot supply those billing counters or emulate hosted
limits. In authorized staging, record per-query D1 metadata for migration,
completion writes, empty cleanup and full batches at representative data sizes;
measure Worker CPU separately using Workers metrics. Check both totals and
backlog growth before choosing a cadence. A daily 25-row-per-table budget can
fall behind ordinary minute-bucket traffic; scheduling is intentionally unset.

No new cron, production cleanup execution, production migration, log-setting
change, API activation or deployment is performed by this PR. Cloudflare still
has the previously created Worker/DB setup and its Hello World deployment.

# Retirement data audit — 2026-09-25

## Decision and scope

**Judgment:** The service's D1 database, R2 bucket, four Queues, and Analytics Engine dataset still exist. D1 structural checks and a complete D1-to-R2 *metadata* reconciliation passed. The R2 bucket has no public domain. This establishes preservation and a bounded degree of integrity, **not** an independently restorable long-term archive or proof that every stored byte is sound. Crucially, **no monitor target was configured**: the project collected its own runtime metrics and release history, but neither monitored an external service nor established an actual self-monitoring loop. No resource, row, object, secret, or credential was changed by this audit.

The audit covered the retired `moesegfault-status` deployment and its local repository as of approximately **2026-09-25 10:35–10:54 UTC**. It used Cloudflare's authenticated D1, R2, Queues, Worker, and Analytics Engine APIs; GitHub repository/secret metadata; and local filesystem ACL metadata. It did not export database records or object bodies, reveal credentials, exercise a restore, audit all account-wide access grants, or download and hash R2 content. The repository remains archived after this documentation-only update.

## Asset inventory

| Asset | Observed state | Important boundary |
| --- | --- | --- |
| D1 `moesegfault-status` | Present; 1,097,728 bytes; `version=production`; 9/9 numbered migrations; 47 application/ledger tables excluding Cloudflare's protected `_cf_KV`, containing 619 aggregate rows. | Database exists and is queryable, but no independent SQL export was verified. |
| R2 `moesegfault-observability` | Present; 96 objects, 268,341,379 bytes (255.91 MiB): 92 artifacts and 4 top-level manifests. | Private `r2.dev` domain disabled; zero R2 custom domains. No object body was fetched. |
| Four `moesegfault-status-*` Queues | All present, each with backlog 0 at inspection. The former diagnostics Worker consumer is absent. | Queue existence is not a message archive; queued messages expire under the configured plan/retention period. |
| Analytics Engine `moesegfault_status` | Dataset queryable; 37,681 physical rows and sampling-weighted count 76,990; first event 2026-09-12 15:08:42 UTC, last observed 2026-09-25 10:37:44 UTC. | Sampling-weighted count is an estimate of represented data points, not an exact source-event ledger. Provider retention is three months. |
| GitHub `kleedaisuki/moesegfault-status` | Public, archived. Four repository Secret names still exist: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CURSOR_SIGNING_KEY`, `MACHINE_JWT_PRIVATE_KEY`. | Archive makes source read-only; it does not establish token revocation or an off-platform data backup. Values were not read. |
| Local status credentials | `.local/credentials/` and `.dev.vars` are Git-ignored; checked administrator and status-secret files inherit ACLs granting only the owner and SYSTEM full control. | Local secrets remain on this machine. File contents and credential validity were not inspected. |

## Integrity and cross-system consistency

1. **D1:** `PRAGMA quick_check` returned `ok`; `PRAGMA foreign_key_check` returned zero violations. The live `d1_migrations` ledger contains exactly `0001_initial.sql` through `0009_single_administrator.sql`, matching the repository's migration filenames. The more exhaustive `PRAGMA integrity_check` returned `SQLITE_AUTH` and was **not** completed; do not report it as passed.
2. **R2 references:** D1 has 92 artifact rows with 92 distinct object keys and four deployment manifest references. A fully paginated R2 object listing found exactly those 96 distinct keys: **0 missing artifacts, 0 missing manifests, 0 unreferenced objects**. All 92 artifact sizes matched the D1 declarations; all 92 R2 `artifact-digest` metadata values matched D1 declarations. The four top-level manifests do not expose that metadata field. This checks names, sizes, and declared digests, **not independently computed SHA-256 of object bodies**.
3. **D1 upload provenance:** All 92 upload sessions have a matching committed artifact, and no artifact references a missing upload session. All 92 sessions are now expired, as expected for historical uploads.
4. **Privacy spot checks:** Email-like `@`, `Bearer `, and `PRIVATE KEY` markers occurred in zero of 198 `audit_log.details_json`, six `outbox.payload_json`, and 95 `idempotency_keys.response_json` rows. Zero audit actor subjects contained `@`. These narrow pattern tests are **not** a comprehensive personal-data or secret scan; R2 object bodies and other D1 text columns were not searched.

### Nonempty D1 tables

| Table or group | Rows | Interpretation |
| --- | ---: | --- |
| `audit_log` | 198 | Historical control-plane actions; last 2026-09-12 15:26:24 UTC. |
| `idempotency_keys` | 95 | All 95 expired; all hold a response JSON value, totaling 37,143 characters by SQLite `LENGTH`. |
| `artifact_upload_sessions`, `deployment_artifact_requirements`, `deployment_artifacts` | 92 each | Release provenance and object references, not monitor observations. |
| `deployment_status_history` | 15 | 4 registered, 4 pending artifacts, 4 ready, 3 active transitions. |
| `d1_migrations` | 9 | Complete numbered migration ledger. |
| `outbox` | 6 | All pending: 3 `catalog.changed` and 3 `deployment.activated`. |
| `deployments`, `deployment_regions` | 4 each | Four historical production deployment registrations, including two status versions. |
| `services`, `status_targets`, `service_environment_deployments` | 3 each | Three internal service identities and three historical production pointers. |
| `administrator_sessions`, `administrator_login_budget`, `evaluation_generation` | 1 each | The one administrator session **expired** on 2026-09-19 22:23:35 UTC; its presence is not an active login. |

The other 31 application tables are empty, including monitors, current statuses, status transitions, diagnostics, issues, incidents, telemetry backends/references, and retention-policy tables. This is consistent with the handoff note that no external monitors were configured. It also means the data is primarily release/audit history, not a record of monitored service health. The 619-row total includes migration and administrative control rows, not 619 business observations.

### R2 composition

| D1 artifact kind | Objects | Declared bytes |
| --- | ---: | ---: |
| `debug_symbols` | 6 | 251,299,623 |
| `binary` | 6 | 13,901,865 |
| `other` | 70 | 1,676,311 |
| `source_map` | 9 | 1,429,079 |
| `manifest` | 1 | 11,849 |
| **D1-referenced artifact total** | **92** | **268,318,727** |

The four separate top-level manifests add 22,652 bytes. Debug symbols account for **93.65%** of all stored R2 bytes. All listed R2 objects were last modified on 2026-09-12; this is a static release archive, not evidence of ongoing object uploads.

### Ownership boundary within the status project

The bucket is exclusive to the retired status *project* in this snapshot, but not to the single `moesegfault-status` Worker. The 92 D1-referenced artifacts join to the four deployment rows as follows; the four additional top-level manifests correspond to those same deployments and are not included in the per-service byte sums:

| Internal service identity | Artifact objects | Artifact bytes | Deployments |
| --- | ---: | ---: | ---: |
| `status` | 20 | 187,872,463 | 2 (`0.1.1`, `0.1.2`) |
| `ops-gateway` | 68 | 40,976,635 | 1 (`0.1.0`) |
| `probe-executor` | 4 | 39,469,629 | 1 (`0.1.0`) |

All 37,681 physical Analytics Engine rows use index `status:production`, matching the status Worker's metric binding. This does not mean the D1 audit and R2 release records are status-Worker-only: their deployment provenance also covers the operations gateway and private probe. No R2 object was unreferenced by these four project deployments; this check found no objects attributable to the separate identity, login, account, or style Workers sharing the Cloudflare account.

## Retention, exposure, and recovery

- **D1 recovery:** A current Time Travel bookmark and historical bookmarks at 2026-09-12 15:30 UTC and 2026-09-20 00:00 UTC were retrievable. The database uses the production storage backend. This proves those points are currently selectable, not that a restore was tested or that the September 12 point remains available indefinitely. Cloudflare documents [7 days on Workers Free or up to 30 days on Workers Paid](https://developers.cloudflare.com/d1/reference/time-travel/). The account plan and exact future cutoff were not independently checked.
- **R2 retention:** The only lifecycle rule is the default seven-day abort for incomplete multipart uploads; no object-expiration rule appeared. The bucket has **no bucket-lock rules**. Its managed public domain is disabled and no custom domain exists. Thus access from the public web is closed through these R2 domain mechanisms, but an authorized principal can still modify or delete objects; no independent/immutable copy was verified. See [R2 lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) and [bucket locks](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/locks/methods/get/).
- **Queues:** Backlog was zero in all four queues. No queued payload was available to audit. Cloudflare's [retention limit](https://developers.cloudflare.com/queues/platform/limits/) is finite (24 hours on Free; configurable up to 14 days on Paid), so the queues must not be counted as long-term storage. The six pending outbox events are in D1, not in Queue backlog.
- **Analytics Engine:** Four Cron-related metric names (`probe.stale`, `probe.missing`, `probe.due`, `outbox.backlog`) account for about **95.4%** of sampling-weighted records; no `probe.observation` metric appeared. The dataset is not proof of target health. Cloudflare documents [three-month retention](https://developers.cloudflare.com/analytics/analytics-engine/limits/). Historical telemetry will age out unless separately preserved.
- **Post-delete events:** Ten physical Analytics Engine rows with `status:production` index appeared after an approximate 10:30 UTC retirement cutoff, last at 10:37:44 UTC. They were Cron-related, and repeat queries through **10:54:19 UTC** found no newer row. The Worker scripts and schedule endpoints were absent in the decommission verification. Cloudflare states [Cron trigger changes can take up to 15 minutes to propagate](https://developers.cloudflare.com/workers/configuration/cron-triggers/); propagation/in-flight work is a plausible explanation, **not a proven cause**. Continue checking if assurance of a fully quiet control plane is required.

## Findings and decisions

| Priority | Finding and evidence | Consequence / decision |
| --- | --- | --- |
| High if long-term provenance matters | No independent D1 export, independently hashed R2 copy, or restore exercise was verified. D1 Time Travel and Analytics Engine retention expire. | Decide the required retention horizon **before** the recoverable window closes; make an encrypted, access-controlled copy outside this Cloudflare account and test restoration to an isolated environment. Do not export sensitive data into GitHub or the repository. |
| Medium | R2 contains 255.91 MiB with no lock rule; 93.65% is debug symbols. | Decide whether to retain every release artifact or apply a reviewed retention policy. If preservation is required, use a separate backup and consider a narrowly scoped bucket lock; a lock can also impede legitimate cleanup. |
| Medium | GitHub still lists a Cloudflare deployment token and machine signing secrets; status credentials remain locally. Token scope/validity and cross-service reuse were not established. | Inventory dependencies first, then revoke or rotate dedicated credentials. Do not blindly revoke a shared Cloudflare token or publish secret values while auditing. |
| Medium | Six outbox events remain pending; 95 idempotency records, 92 upload sessions, and one administrator session are expired. All scheduled application cleanup stopped with the Worker. | Decide whether these are preserved evidence or expired data to purge. Document a controlled disposition before mutating D1. The expired administrator row is not an active session. |
| Low, monitor | Cron metrics appeared briefly after the delete, with no later records in the observed window. | Recheck after the platform propagation interval if strict zero-execution evidence is needed. Do not infer an active public service solely from delayed Cron telemetry. |

## Reproduction and limitations

All queries were read-only and returned aggregate values or metadata. Representative D1 SQL: `PRAGMA quick_check`, `PRAGMA foreign_key_check`, `SELECT name FROM d1_migrations ORDER BY id`, per-table `COUNT(*)`, grouped `outbox` state/event type, and `SELECT object_key, size_bytes, artifact_digest FROM deployment_artifacts` for in-memory key reconciliation. The protected Cloudflare `_cf_KV` internal table was excluded from business row counts after an authorization error. SQLite's compound-SELECT term limit required batching count queries. An initial session-expiry comparison accidentally used seconds against millisecond timestamps; it was corrected to `expires_at <= CAST(strftime('%s','now') AS INTEGER)*1000`, yielding **1/1 expired**. No sensitive row or private R2 key is included in this report.

R2 listing used `GET /accounts/{account_id}/r2/buckets/{bucket_name}/objects` with **all five cursor pages**, not the first page alone. Analytics Engine queries used `SUM(_sample_interval)` as recommended by [Cloudflare's sampling guidance](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/), alongside physical `COUNT()`. API observations are a time-bounded snapshot: later deletion, credential change, or provider retention can change the state. The R2 metadata match cannot establish content-byte integrity; a full SHA-256 audit requires reading 255.91 MiB of object bodies and was deliberately not performed without an explicit export plan.

Key read-only queries, with the account/database identifiers taken from the repository's reviewed Wrangler configuration:

```sql
PRAGMA quick_check;
PRAGMA foreign_key_check;
SELECT id, name FROM d1_migrations ORDER BY id;
SELECT name FROM sqlite_master
WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
ORDER BY name;
-- Execute SELECT COUNT(*) separately for each returned application table.
SELECT state, event_type, COUNT(*) AS n FROM outbox GROUP BY state, event_type;
SELECT COUNT(*) AS n, COUNT(DISTINCT object_key) AS unique_keys,
       SUM(size_bytes) AS declared_bytes FROM deployment_artifacts;
SELECT COUNT(*) AS expired FROM administrator_sessions
WHERE expires_at <= CAST(strftime('%s','now') AS INTEGER) * 1000;
SELECT COUNT(*) AS expired FROM idempotency_keys
WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now');
```

Analytics Engine queries used its SQL API, not SQLite:

```sql
SELECT COUNT() AS physical_rows,
       SUM(_sample_interval) AS weighted_events,
       MIN(timestamp) AS first_at, MAX(timestamp) AS last_at
FROM moesegfault_status FORMAT JSON;
SELECT index1, COUNT() AS physical_rows, MAX(timestamp) AS last_at
FROM moesegfault_status
WHERE timestamp >= toDateTime('2026-09-25 10:30:00')
GROUP BY index1 FORMAT JSON;
```

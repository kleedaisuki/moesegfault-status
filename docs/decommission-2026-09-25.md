# Service decommission: 2026-09-25

## Scope and outcome

The `moesegfault-status` service was retired from Cloudflare. This record distinguishes the deleted runtime from retained storage; the historical deployment notes elsewhere in this repository are not evidence of a running service.

| Resource | Action | Verification |
| --- | --- | --- |
| `ops.moesegfault.dev` → `moesegfault-ops-gateway` | Detached the exact Worker Custom Domain. | No matching domain in the account's Worker Domains API; public DNS-over-HTTPS returned NXDOMAIN. |
| `status.moesegfault.dev` → `moesegfault-status` | Detached the exact Worker Custom Domain. | No matching domain in the account's Worker Domains API; public DNS-over-HTTPS returned NXDOMAIN after propagation. |
| `moesegfault-ops-gateway` | Deleted the Worker script. | Absent from the account's Worker Scripts API. |
| `moesegfault-status` | Deleted its `moesegfault-status-diagnostics` Queue consumer, then deleted the Worker script. | Consumer and script absent from their respective APIs. |
| `moesegfault-probe-asia` | Deleted the private Worker script. | Absent from the account's Worker Scripts API. |

Cloudflare's direct DNS-record API returned HTTP 403 for the local OAuth credential. The two records were managed by Worker Custom Domains, so the domains were detached through the authorized Worker Domains API instead of attempting a broader zone modification. The public DNS-over-HTTPS checks for both exact hostnames returned NXDOMAIN. No other `moesegfault.dev` Worker domains were touched.

The four `moesegfault-status-*` Queues remained present after Worker removal. This operation did **not** request deletion of the D1 database, private R2 bucket, Queue contents, Analytics Engine data, account-level `workers.dev` subdomain, or TLS certificates. Retained resources may require a separate data-retention and billing decision. Cloudflare notes that deleting a Worker Custom Domain does not automatically delete its associated Advanced Certificate.

The last successful production acceptance on 2026-09-12 remains historical only. The exact decommission verification used Cloudflare's Worker Domains, Worker Scripts, and Queues APIs plus public DNS-over-HTTPS; no application release or code upload occurred during retirement.

## References

- [Cloudflare Worker Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Cloudflare Worker Domains API](https://developers.cloudflare.com/api/resources/workers/subresources/domains/)
- [Cloudflare Worker Scripts API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/)
- [Cloudflare Queue Consumers API](https://developers.cloudflare.com/api/resources/queues/subresources/consumers/methods/delete/)

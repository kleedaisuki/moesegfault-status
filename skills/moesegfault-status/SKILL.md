---
name: moesegfault-status
description: "Use or integrate with moeSegFault Status: read and interpret public status, add diagnostic reporting or monitoring, and adopt deployment provenance. Apply to caller-side agent work and owner handoffs, not generic observability, git status, HTTP status codes, or unrelated Cloudflare administration."
---

# moeSegFault Status

Treat Status as a set of capability boundaries, not as one generic API.

## Route the request

| Intent                                                                | Boundary                                                                     | Read next                                                                                                                     |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Read current platform, service, incident, or maintenance state        | Anonymous public HTTP projection                                             | [references/use-status.md](references/use-status.md)                                                                          |
| Add diagnostic fault/recovery reporting to an application             | Authenticated machine writer                                                 | [references/integrate-status.md](references/integrate-status.md#diagnostic-reporting)                                         |
| Put a real service or capability under monitoring                     | Caller implementation plus owner-managed catalog and monitor configuration   | [references/integrate-status.md](references/integrate-status.md#monitoring-onboarding)                                        |
| Register deployment provenance or publish artifacts through Status    | Authenticated release client                                                 | [references/integrate-status.md](references/integrate-status.md#release-provenance)                                           |
| Change Status itself, operate queues, or perform owner administration | Repository maintenance or owner workflow, not an ordinary caller integration | Read [project handoff](../../docs/project-handoff.md) and only the relevant section of [operations](../../docs/operations.md) |

Do not silently broaden a read request into onboarding, or a caller integration into Status administration.

## Work from the caller's task

1. State which capability is needed and what observable fact will count as success.
2. Select the smallest boundary or boundaries needed. Load only their references and then the exact contracts needed for implementation.
3. Make caller-side changes in the application's native architecture. Prefer the maintained Rust diagnostic SDK when it fits; do not introduce a forwarding service merely to mirror Status internals.
4. Hand owner-only inputs to the owner rather than automating a private administrative path.
5. Validate the boundary end to end and report the last fact actually observed. Preserve distinctions among accepted, processed, ready, carrying traffic, and activated.

For exact HTTP bodies and responses, inspect [OpenAPI](../../packages/contracts/openapi.json). For administrative command shapes, inspect [the TypeScript contracts](../../packages/contracts/src/admin.ts); the Rust server remains authoritative. Do not copy large schemas into caller code or this skill.

## Invariants that change decisions

- Public caller access consists of the documented `GET /v1/...` projections and machine-write routes. Administrative RPC is private gateway-to-Status traffic; owner login and session cookies are not machine credentials.
- An empty list, `unknown`, stale evidence, or an unconfigured monitor is not evidence of health.
- Diagnostic HTTP `202` proves queue admission only. Deployment `ready`, Cloudflare traffic cut-over, and authoritative owner activation are separate facts.
- Machine identity is short-lived and bound to the real service, environment, deployment, and least privilege. No public token endpoint currently exists; do not copy this repository's signing key to another project or turn a 15-minute token into a stored password.
- Preserve correlation and idempotency identities across retries. Retry transient failures within a budget; repair permanent request, ownership, or authorization errors instead of randomizing identifiers.
- Configuration, a deployed probe, or a green workflow is not runtime evidence. For current-state claims, prefer a live response or a recent receipt tied to the relevant deployment.
- Never put authorization headers, cookies, private keys, complete diagnostic bodies, or secret values in examples, logs, handoff documents, or generated artifacts.

## Source hierarchy

Use [the caller integration guide](../../docs/integration-guide.md) for supported boundaries. Use OpenAPI or maintained SDK/release implementations for wire behavior. If documentation or generated contracts disagree with current runtime implementation, verify the implementation with a reproducible test and describe the drift rather than promising the documented behavior. Treat design documents and historical deployment notes as intent or dated evidence, not proof of current runtime state. In particular, do not revive older Cloudflare Access assumptions or promise `ETag`/conditional-request support without current verification.

# Integrating a Service with Status

Use this reference to add one or more Status capabilities to a real application. “Integrate” does not imply that monitoring, diagnostics, and release provenance must all be adopted.

## Define the integration slice

Choose only the capabilities that serve the application:

| Capability           | Caller supplies                                                                                 | Status supplies                                                                       | Completion evidence                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Monitoring           | A real service/capability identity and an observable HTTP, TCP, DNS, RPC, or synthetic boundary | Owner-managed catalog, policy, scheduling, evidence evaluation, and public projection | Enabled monitor produces fresh evidence; expiry becomes `unknown`; the public projection matches the intended catalog |
| Diagnostic reporting | Manifest-bound fault/recovery events and a controlled short-lived machine identity              | Validated queue ingestion, deduplication, evaluation, and issue processing            | Matching `202` receipt proves queue admission; downstream state is checked separately when required                   |
| Release provenance   | Immutable deployment manifest and exact built artifacts                                         | Restricted upload, integrity commit, and readiness computation                        | Verified commit and recomputed `ready`; platform rollout and owner activation remain separate checks                  |

Before editing code, write a non-secret integration brief containing:

- service name, environment, and responsible owner;
- selected capability or capabilities and why each is needed;
- observable target or event source, expected volume, and tolerated loss/delay;
- correlation propagation and the application-owned evidence used for acceptance.

For diagnostic or release machine writes, also include the real deployment UUIDv7, required scopes, producer identity, and controlled issuance/refresh mechanism. A monitoring-only integration does not require machine-write credentials.

Stop at a documented owner handoff if no safe token issuance or owner action is available. Do not manufacture credentials, catalog records, targets, or healthy evidence to make the integration appear complete.

## Shared identity and retry rules

Machine JWTs are bound to issuer, audience, subject, token identity, service, environment, deployment, scope, and a maximum 900-second lifetime. They are not owner sessions or Cloudflare deployment tokens. This repository's release signing key is not a shared integration secret, and no public token endpoint is deployed.

Resolve issuance and refresh before production integration. Obtain fresh credentials for retries without changing the event, command, or idempotency identity. Keep retry budgets finite. Fix permanent schema, size, media-type, ownership, and persistent authorization failures instead of retrying blindly.

Read exact claims, request schemas, and receipt schemas from [OpenAPI](../../../packages/contracts/openapi.json) only when implementing the wire boundary.

## Monitoring onboarding

Choose the least elaborate truthful probe:

- Use HTTP, TCP, or DNS when an existing bounded endpoint represents the capability.
- Use the private probe RPC protocol only when transport-level reachability is insufficient and the business Worker can expose a small, typed, deadline-aware health operation.
- Use synthetic operations only with isolated `probe:*` subjects and verified synchronous cleanup. Cancellation is not proof of remote rollback.

The application-facing implementation should expose capability health, not Status internals. Keep the operation bounded and side-effect free where possible; do not report “healthy” merely because the process responds.

Owner-only catalog work follows domain order: register dependency targets before dependents, create immutable policy revisions, bind monitors to exact revisions, then assign diagnostic and retention policies as needed. Start a new monitor disabled, verify its allowlisted target and expected failure modes, then enable it using the current revision. Owner operations go through the same-origin Ops session; private AdminRpc is not a caller API.

Validate success, policy behavior, and freshness separately:

1. Obtain fresh success evidence from the real target.
2. When failure classification is in scope, make the test target fail while probes continue and confirm the policy-defined impact.
3. Stop or disable the test monitor so no new evidence is produced, wait for existing evidence to expire, and confirm the projection becomes `unknown` rather than remaining falsely healthy.
4. Restore the target and monitor, then confirm recovery requires new positive evidence.

For owner procedure and regional/RPC binding details, read only the relevant sections of [operations](../../../docs/operations.md). For shared probe message types, inspect [probe contracts](../../../packages/contracts/src/probe-rpc.ts).

## Diagnostic reporting

For Rust applications, prefer [`diagnostic-client`](../../../crates/diagnostic-client/README.md). Confirm how this workspace crate will be distributed to the caller before changing dependencies; it is not currently a published crates.io package. Construct its builder from the real build manifest and use the platform transport. The SDK binds resource identity, redacts evidence, caps payloads and queue depth, preserves bytes across retry, and enforces the exact ingestion endpoint.

Decide durability explicitly:

- Use the SDK's bounded in-memory queue only when best-effort delivery is acceptable. Flush it within the runtime's lifecycle.
- Use an application-owned durable outbox when process termination, isolate eviction, or cancellation must not lose an event. The SDK queue is not durable storage.

For Workers, create a client per request and attach background flush to that request's execution context; do not cache Workers I/O globally. Native runtimes implement the transport and await flush before the relevant lifecycle ends.

Fault and recovery are explicit events. A recovery must reference the matching current fault; silence does not mean recovery. Preserve one event ID and identical body across retries. The `x-moesegfault-correlation-id` header must equal the body correlation ID and be UUIDv7; the maintained SDK handles this.

Only a `202` response with `accepted=true` and the matching event ID proves ingestion. It does not prove D1 consumption, evaluation, incident creation, or notification delivery. If the user's acceptance criterion includes those stages, verify them independently.

For a non-Rust caller, implement the same contract from OpenAPI and the maintained Rust client semantics; do not resurrect the removed TypeScript client path or handcraft partially validated events.

## Release provenance

For this repository, application publication—including bootstrap—runs through GitHub Actions. Do not replace the release gate with a local bare `wrangler deploy`. An external project should adopt this protocol only when explicitly required and after its own controlled machine-token issuance is designed.

Use the maintained Rust releaser rather than recreating orchestration. The high-level state machine is:

1. Register the immutable deployment manifest.
2. Create a restricted artifact upload session using a stable idempotency key.
3. Upload exact bytes to the returned same-origin path without redirects or overwrite.
4. Commit the artifact so the server verifies stored bytes and digest.
5. Re-submit the same manifest to recompute `ready`.
6. Publish the exact platform version and verify smoke behavior.
7. Have the owner explicitly activate the authoritative deployment pointer after rollout evidence is satisfactory.

An upload `412` says that an object already exists; it does not prove integrity. Continue to verified commit rather than overwriting or declaring success. A `ready` deployment is eligible for rollout, not proof that it carries traffic or is the active application pointer.

Read [the release runbook](../../../scripts/release/rust-release-README.md) and [the Rust releaser](../../../crates/status-release/src/lib.rs) only for release work. Do not copy illustrative partial JSON; generate the real manifest and inventory from actual build outputs.

## Acceptance summary

Report each selected capability independently:

- **Observed:** concrete response, receipt, current projection, or runtime behavior.
- **Inferred:** what the observation supports but does not directly prove.
- **Pending:** owner action, token issuance, downstream processing, rollout, or activation still required.

An integration is complete only for the capabilities whose stated completion evidence was observed. Partial success is a valid result and must not be promoted to a stronger lifecycle state.

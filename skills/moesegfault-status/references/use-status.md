# Using Status

Use this reference for status consumers. It covers public projections and their interpretation, not service onboarding or owner administration.

## Choose the smallest projection

Base URL: `https://status.moesegfault.dev`.

| Need                        | Request                                                  |
| --------------------------- | -------------------------------------------------------- |
| Overall platform projection | `GET /v1/status`                                         |
| Public services             | `GET /v1/services`                                       |
| One public service          | `GET /v1/services/{service_name}`                        |
| Incident list or timeline   | `GET /v1/incidents` or `GET /v1/incidents/{incident_id}` |
| Maintenance windows         | `GET /v1/maintenance-windows`                            |

These routes are anonymous projections. They do not expose the internal catalog, monitor configuration, deployment readiness, or owner operations.

For a current-state question, issue a live request when network access is authorized. Capture the HTTP status, response time, `x-moesegfault-correlation-id`, and relevant freshness fields. A repository document or previous response answers a historical question only.

## Read results conservatively

- Report the returned status and freshness rather than translating missing evidence to `operational`.
- Treat an empty service or incident collection as “no public records returned,” not “everything is healthy.”
- Treat `unknown` as unavailable or insufficient current evidence. Do not collapse it into either healthy or confirmed outage.
- Distinguish scheduled maintenance from an incident and direct impact from dependency risk when the response exposes both.
- Do not rely on `ETag` or conditional `If-None-Match` behavior; it is not consistently implemented by the current runtime.

Lists use opaque cursor pagination. If `page.next_cursor` is non-null, URL-encode it in the next request and retain the original filters. Do not decode, edit, or persist cursors as durable application state. `limit` is 1–100 and defaults to 50.

Browser callers outside `https://ops.moesegfault.dev` are not currently allowed by CORS. Use an authorized server-side caller or request an explicit product change; do not weaken the browser security model in caller code. Server-to-server HTTP is not subject to browser CORS.

## Handle failures without inventing state

Inspect the HTTP status and media type before parsing. Application failures usually use `application/problem+json`, but platform or proxy errors may not.

| Result                           | Caller action                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `400`, `413`, `415`, `422`       | Correct the request; do not retry unchanged.                                                               |
| `401`, `403`                     | Reconcile identity, expiry, scope, and ownership. Public GETs should not require credentials.              |
| `404`                            | Check the documented route and public visibility. Do not infer that an internal resource is absent.        |
| `409`                            | Reconcile the requested operation with current state; do not hide the conflict with a new random identity. |
| `429`, `5xx`, or network failure | Use bounded backoff, respect a valid `Retry-After`, and retain request identity.                           |

Record only safe support data: time, method/path, HTTP status, problem type, and correlation ID. Never record credentials, cookies, or complete diagnostic payloads.

## Completion evidence

A read task is complete when the requested public projection was retrieved and interpreted with freshness and uncertainty preserved. If the request failed, report the failure and correlation ID; do not return a cached or fabricated healthy result as a substitute.

When exact filters or response fields matter, read [the OpenAPI contract](../../../packages/contracts/openapi.json) rather than guessing.

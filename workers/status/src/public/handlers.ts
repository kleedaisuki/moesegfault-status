import {
  DependencyRiskSchema,
  IncidentPathParamsSchema,
  ListIncidentsQuerySchema,
  ListMaintenanceWindowsQuerySchema,
  ListServicesQuerySchema,
  PlatformStatusResponseSchema,
  PublicIncidentListResponseSchema,
  PublicIncidentResponseSchema,
  PublicMaintenanceWindowListResponseSchema,
  PublicServiceListResponseSchema,
  PublicServiceStatusResponseSchema,
  ServicePathParamsSchema,
  type DependencyRisk,
  type IncidentState,
  type PublicComponentStatus,
  type PublicIncidentSummary,
  type PublicIncidentUpdate,
  type PublicMaintenanceWindow,
} from "@moesegfault/contracts";
import { InvalidCursorError, signCursor, verifyCursor } from "./cursor.js";
import {
  aggregateStatus,
  allRows,
  earliest,
  effectiveImpact,
  firstRow,
  freshStatus,
  nullableText,
  type PublicStatus,
} from "./data.js";
import {
  InvalidRequestError,
  assertQueryKeys,
  jsonResponse,
  parseLimit,
  problemResponse,
  publicSelfLink,
} from "./http.js";
import { recordPublicFreshness } from "../platform/instrumentation.js";
import type { PublicApiContext } from "./types.js";

const SERVICE_SORT = "service_name:asc";
const INCIDENT_SORT = "started_at:desc,incident_id:desc";
const MAINTENANCE_SORT = "starts_at:asc,maintenance_id:asc";

interface StatusRow {
  readonly target_id: string;
  readonly display_name: string;
  readonly direct_status: string | null;
  readonly effective_impact: string | null;
  readonly evaluated_at: string | null;
  readonly fresh_until: string | null;
  readonly fallback_at: string;
}

interface ServiceRow extends StatusRow {
  readonly service_name: string;
  readonly description: string;
}

interface IncidentRow {
  readonly incident_id: string;
  readonly title: string;
  readonly state: IncidentState;
  readonly impact: "degraded" | "partial_outage" | "major_outage";
  readonly started_at: string;
  readonly detected_at: string;
  readonly resolved_at: string | null;
  readonly revision: number;
  readonly public_message: string;
  readonly updated_at: string;
  readonly cause?: string | null;
}

interface MaintenanceRow {
  readonly maintenance_id: string;
  readonly title: string;
  readonly description: string;
  readonly expected_impact: "degraded" | "partial_outage" | "major_outage";
  readonly starts_at: string;
  readonly ends_at: string;
  readonly state: "scheduled" | "active" | "completed" | "cancelled";
}

/** GET /v1/status。 / GET /v1/status. */
export async function getPlatformStatus(
  request: Request,
  context: PublicApiContext,
  correlationId: string,
): Promise<Response> {
  rejectAllQueryParameters(request);
  const now = currentTime(context);
  const snapshot = await loadStatusSnapshot(context, now);
  const rows = snapshot.components;
  const incidentCount = await firstRow<{ readonly count: number }>(
    context.DB,
    "SELECT COUNT(*) AS count FROM incident_current WHERE state <> 'resolved'",
  );
  recordPublicFreshness(context.telemetry, rows, now, "platform");
  const components = rows.map((row) => componentFromRow(row, now));
  const timestamps = rows.map((row) => row.evaluated_at ?? row.fallback_at);
  const freshness = rows.map((row) => row.fresh_until ?? row.fallback_at);
  const nowIso = now.toISOString();
  const body = {
    data: {
      status: aggregateStatus(components.map((component) => component.status)),
      evaluated_at: earliest(timestamps, nowIso),
      fresh_until: earliest(freshness, nowIso),
      active_incident_count: Number(incidentCount?.count ?? 0),
      components,
    },
    links: { self: publicSelfLink(request, context.publicOrigin) },
  };
  return jsonResponse(PlatformStatusResponseSchema, body, correlationId);
}

/** GET /v1/services。 / GET /v1/services. */
export async function listServices(
  request: Request,
  context: PublicApiContext,
  correlationId: string,
): Promise<Response> {
  const url = new URL(request.url);
  assertQueryKeys(url.searchParams, new Set(["cursor", "limit"]));
  const now = currentTime(context);
  const limit = parseLimit(singleQuery(url.searchParams, "limit"));
  const parsed = ListServicesQuerySchema.safeParse({
    cursor: singleQuery(url.searchParams, "cursor") ?? undefined,
    limit,
  });
  if (!parsed.success)
    throw new InvalidRequestError("cursor or limit is invalid");
  const query = parsed.data;
  const binding = {
    route: "/v1/services",
    query: "",
    sort: SERVICE_SORT,
  } as const;
  const key = query.cursor
    ? await verifyCursor<{ readonly service_name: string }>(
        query.cursor,
        binding,
        context.cursorSecret,
        now,
      )
    : undefined;
  if (key && typeof key.service_name !== "string")
    throw new InvalidCursorError();
  const snapshot = await loadStatusSnapshot(context, now);
  const rows = snapshot.services
    .filter((row) => !key || row.service_name > key.service_name)
    .slice(0, limit + 1);
  const hasNext = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  recordPublicFreshness(context.telemetry, pageRows, now, "services");
  const components = snapshot.componentsByService;
  const data = pageRows.map((row) => ({
    service_name: row.service_name,
    display_name: row.display_name,
    description: nullableText(row.description),
    status: freshStatus(row.effective_impact, row.fresh_until, now),
    evaluated_at: row.evaluated_at ?? row.fallback_at,
    fresh_until: row.fresh_until ?? row.fallback_at,
    components: components.get(row.service_name) ?? [],
  }));
  const last = pageRows.at(-1);
  const nextCursor =
    hasNext && last
      ? await signCursor(
          { ...binding, key: { service_name: last.service_name } },
          context.cursorSecret,
          now,
        )
      : null;
  return jsonResponse(
    PublicServiceListResponseSchema,
    {
      data,
      page: { next_cursor: nextCursor },
      links: { self: publicSelfLink(request, context.publicOrigin) },
    },
    correlationId,
  );
}

/** GET /v1/services/{service_name}。 / GET /v1/services/{service_name}. */
export async function getServiceStatus(
  request: Request,
  context: PublicApiContext,
  correlationId: string,
  rawServiceName: string,
): Promise<Response> {
  rejectAllQueryParameters(request);
  const parsed = ServicePathParamsSchema.safeParse({
    service_name: rawServiceName,
  });
  if (!parsed.success) throw new InvalidRequestError("service_name is invalid");
  const serviceName = parsed.data.service_name;
  const now = currentTime(context);
  const snapshot = await loadStatusSnapshot(context, now);
  const row = snapshot.services.find(
    (service) => service.service_name === serviceName,
  );
  if (!row)
    return problemResponse(
      404,
      "not-found",
      "Service not found",
      "The public service does not exist.",
      request,
      correlationId,
    );

  const componentMap = snapshot.componentsByService;
  const dependencyRisk = snapshot.risks.get(serviceName)!;
  const activeIncidents = await allRows<{ readonly incident_id: string }>(
    context.DB,
    `SELECT relation.incident_id AS incident_id
       FROM incident_services AS relation
       JOIN incident_current AS incident ON incident.incident_id = relation.incident_id
      WHERE relation.service_name = ? AND incident.state <> 'resolved'
      ORDER BY incident.started_at DESC, relation.incident_id DESC`,
    [serviceName],
  );
  recordPublicFreshness(context.telemetry, [row], now, "service");
  const directStatus = snapshot.directStatuses[serviceName]!;
  const body = {
    data: {
      service_name: row.service_name,
      display_name: row.display_name,
      description: nullableText(row.description),
      direct_status: directStatus,
      dependency_risk: dependencyRisk,
      effective_impact: effectiveImpact(directStatus, dependencyRisk.status),
      evaluated_at: row.evaluated_at ?? row.fallback_at,
      fresh_until: row.fresh_until ?? row.fallback_at,
      components: componentMap.get(serviceName) ?? [],
      active_incident_ids: activeIncidents.map(
        (incident) => incident.incident_id,
      ),
    },
    links: { self: publicSelfLink(request, context.publicOrigin) },
  };
  return jsonResponse(PublicServiceStatusResponseSchema, body, correlationId);
}

/** GET /v1/incidents。 / GET /v1/incidents. */
export async function listIncidents(
  request: Request,
  context: PublicApiContext,
  correlationId: string,
): Promise<Response> {
  const url = new URL(request.url);
  assertQueryKeys(url.searchParams, new Set(["states", "cursor", "limit"]));
  const now = currentTime(context);
  const limit = parseLimit(singleQuery(url.searchParams, "limit"));
  const states = [...new Set(url.searchParams.getAll("states"))].sort();
  const parsed = ListIncidentsQuerySchema.safeParse({
    states: states.length === 0 ? undefined : states,
    cursor: singleQuery(url.searchParams, "cursor") ?? undefined,
    limit,
  });
  if (!parsed.success)
    throw new InvalidRequestError("states, cursor, or limit is invalid");
  const queryBinding = `states=${(parsed.data.states ?? []).join(",")}`;
  const binding = {
    route: "/v1/incidents",
    query: queryBinding,
    sort: INCIDENT_SORT,
  } as const;
  const key = parsed.data.cursor
    ? await verifyCursor<{
        readonly started_at: string;
        readonly incident_id: string;
      }>(parsed.data.cursor, binding, context.cursorSecret, now)
    : undefined;
  if (
    key &&
    (typeof key.started_at !== "string" || typeof key.incident_id !== "string")
  )
    throw new InvalidCursorError();

  const where: string[] = [];
  const values: unknown[] = [];
  if (parsed.data.states?.length) {
    where.push(`ic.state IN (${parsed.data.states.map(() => "?").join(", ")})`);
    values.push(...parsed.data.states);
  }
  if (key) {
    where.push(
      "(ic.started_at < ? OR (ic.started_at = ? AND ic.incident_id < ?))",
    );
    values.push(key.started_at, key.started_at, key.incident_id);
  }
  values.push(limit + 1);
  const rows = await allRows<IncidentRow>(
    context.DB,
    `SELECT ic.incident_id AS incident_id,
            ic.title AS title,
            ic.state AS state,
            ic.impact AS impact,
            ic.started_at AS started_at,
            ic.detected_at AS detected_at,
            ic.resolved_at AS resolved_at,
            ic.revision AS revision,
            ic.public_message AS public_message,
            ic.updated_at AS updated_at
       FROM incident_current AS ic
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ic.started_at DESC, ic.incident_id DESC
      LIMIT ?`,
    values,
  );
  const hasNext = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const components = await incidentComponents(
    context,
    pageRows.map((row) => row.incident_id),
  );
  const data = pageRows.map((row) =>
    incidentSummary(row, components.get(row.incident_id) ?? []),
  );
  const last = pageRows.at(-1);
  const nextCursor =
    hasNext && last
      ? await signCursor(
          {
            ...binding,
            key: { started_at: last.started_at, incident_id: last.incident_id },
          },
          context.cursorSecret,
          now,
        )
      : null;
  return jsonResponse(
    PublicIncidentListResponseSchema,
    {
      data,
      page: { next_cursor: nextCursor },
      links: { self: publicSelfLink(request, context.publicOrigin) },
    },
    correlationId,
  );
}

/** GET /v1/incidents/{incident_id}。 / GET /v1/incidents/{incident_id}. */
export async function getIncident(
  request: Request,
  context: PublicApiContext,
  correlationId: string,
  rawIncidentId: string,
): Promise<Response> {
  rejectAllQueryParameters(request);
  const parsed = IncidentPathParamsSchema.safeParse({
    incident_id: rawIncidentId,
  });
  if (!parsed.success) throw new InvalidRequestError("incident_id is invalid");
  const incidentId = parsed.data.incident_id;
  const row = await firstRow<IncidentRow>(
    context.DB,
    `SELECT ic.incident_id AS incident_id,
            ic.title AS title,
            ic.state AS state,
            ic.impact AS impact,
            ic.started_at AS started_at,
            ic.detected_at AS detected_at,
            ic.resolved_at AS resolved_at,
            ic.revision AS revision,
            ic.public_message AS public_message,
            ic.updated_at AS updated_at,
            ic.cause AS cause
       FROM incident_current AS ic
      WHERE ic.incident_id = ?`,
    [incidentId],
  );
  if (!row)
    return problemResponse(
      404,
      "not-found",
      "Incident not found",
      "The public incident does not exist.",
      request,
      correlationId,
    );
  const [componentMap, updateRows, evidenceRows] = await Promise.all([
    incidentComponents(context, [incidentId]),
    allRows<{
      readonly sequence: number;
      readonly state: IncidentState;
      readonly impact: "degraded" | "partial_outage" | "major_outage";
      readonly public_message: string;
      readonly occurred_at: string;
    }>(
      context.DB,
      `SELECT sequence AS sequence,
              state AS state,
              impact AS impact,
              public_message AS public_message,
              occurred_at AS occurred_at
         FROM incident_updates
        WHERE incident_id = ?
        ORDER BY sequence ASC`,
      [incidentId],
    ),
    allRows<{
      readonly kind:
        | "trace"
        | "log_query"
        | "profile"
        | "metric_query"
        | "source"
        | "artifact";
      readonly evidence_count: number;
      readonly first_observed_at: string;
      readonly last_observed_at: string;
    }>(
      context.DB,
      `SELECT tr.kind AS kind,
              COUNT(*) AS evidence_count,
              MIN(tr.created_at) AS first_observed_at,
              MAX(tr.created_at) AS last_observed_at
         FROM incident_telemetry_references AS link
         JOIN telemetry_references AS tr
           ON tr.telemetry_reference_id = link.telemetry_reference_id
        WHERE link.incident_id = ?
        GROUP BY tr.kind
        ORDER BY tr.kind ASC`,
      [incidentId],
    ),
  ]);
  const updates: PublicIncidentUpdate[] = updateRows.map((update) => ({
    sequence: Number(update.sequence),
    state: update.state,
    impact: update.impact,
    message: update.public_message,
    published_at: update.occurred_at,
  }));
  const body = {
    data: {
      ...incidentSummary(row, componentMap.get(incidentId) ?? []),
      cause: nullableText(row.cause),
      updates,
      evidence: evidenceRows.map((evidence) => ({
        kind: evidence.kind,
        count: Number(evidence.evidence_count),
        first_observed_at: evidence.first_observed_at,
        last_observed_at: evidence.last_observed_at,
      })),
    },
    links: { self: publicSelfLink(request, context.publicOrigin) },
  };
  return jsonResponse(PublicIncidentResponseSchema, body, correlationId);
}

/** GET /v1/maintenance-windows。 / GET /v1/maintenance-windows. */
export async function listMaintenanceWindows(
  request: Request,
  context: PublicApiContext,
  correlationId: string,
): Promise<Response> {
  const url = new URL(request.url);
  assertQueryKeys(url.searchParams, new Set(["from", "to", "cursor", "limit"]));
  const now = currentTime(context);
  const limit = parseLimit(singleQuery(url.searchParams, "limit"));
  const parsed = ListMaintenanceWindowsQuerySchema.safeParse({
    from: singleQuery(url.searchParams, "from") ?? undefined,
    to: singleQuery(url.searchParams, "to") ?? undefined,
    cursor: singleQuery(url.searchParams, "cursor") ?? undefined,
    limit,
  });
  if (!parsed.success)
    throw new InvalidRequestError("from, to, cursor, or limit is invalid");
  const queryBinding = `from=${parsed.data.from ?? "<current>"}&to=${parsed.data.to ?? ""}`;
  const binding = {
    route: "/v1/maintenance-windows",
    query: queryBinding,
    sort: MAINTENANCE_SORT,
  } as const;
  const key = parsed.data.cursor
    ? await verifyCursor<{
        readonly starts_at: string;
        readonly maintenance_id: string;
        readonly scan_from: string;
      }>(parsed.data.cursor, binding, context.cursorSecret, now)
    : undefined;
  if (
    key &&
    (typeof key.starts_at !== "string" ||
      typeof key.maintenance_id !== "string" ||
      typeof key.scan_from !== "string")
  ) {
    throw new InvalidCursorError();
  }
  const from = parsed.data.from ?? key?.scan_from ?? now.toISOString();
  const to = parsed.data.to;
  if (to && to <= from)
    throw new InvalidRequestError("to must be later than from");

  const where = ["mw.ends_at > ?"];
  const values: unknown[] = [from];
  if (to) {
    where.push("mw.starts_at < ?");
    values.push(to);
  }
  if (key) {
    where.push(
      "(mw.starts_at > ? OR (mw.starts_at = ? AND mw.maintenance_id > ?))",
    );
    values.push(key.starts_at, key.starts_at, key.maintenance_id);
  }
  values.push(limit + 1);
  const rows = await allRows<MaintenanceRow>(
    context.DB,
    `SELECT mw.maintenance_id AS maintenance_id,
            mw.title AS title,
            mw.description AS description,
            mw.expected_impact AS expected_impact,
            mw.starts_at AS starts_at,
            mw.ends_at AS ends_at,
            mw.state AS state
       FROM maintenance_windows AS mw
      WHERE ${where.join(" AND ")}
      ORDER BY mw.starts_at ASC, mw.maintenance_id ASC
      LIMIT ?`,
    values,
  );
  const hasNext = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const targets = await maintenanceTargets(
    context,
    pageRows.map((row) => row.maintenance_id),
  );
  const data: PublicMaintenanceWindow[] = pageRows.map((row) => ({
    maintenance_id: row.maintenance_id,
    title: row.title,
    description: row.description,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    expected_impact: row.expected_impact,
    target_services: targets.get(row.maintenance_id)?.services ?? [],
    target_components: targets.get(row.maintenance_id)?.components ?? [],
    state: row.state,
  }));
  const last = pageRows.at(-1);
  const nextCursor =
    hasNext && last
      ? await signCursor(
          {
            ...binding,
            key: {
              starts_at: last.starts_at,
              maintenance_id: last.maintenance_id,
              scan_from: from,
            },
          },
          context.cursorSecret,
          now,
        )
      : null;
  return jsonResponse(
    PublicMaintenanceWindowListResponseSchema,
    {
      data,
      page: { next_cursor: nextCursor },
      links: { self: publicSelfLink(request, context.publicOrigin) },
    },
    correlationId,
  );
}

function componentFromRow(row: StatusRow, now: Date): PublicComponentStatus {
  return {
    id: row.target_id,
    display_name: row.display_name,
    status: freshStatus(
      row.effective_impact ?? row.direct_status,
      row.fresh_until,
      now,
    ),
  };
}

async function incidentComponents(
  context: PublicApiContext,
  incidentIds: readonly string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  for (const incidentId of incidentIds) result.set(incidentId, []);
  if (incidentIds.length === 0) return result;
  const rows = await allRows<{
    readonly incident_id: string;
    readonly component_id: string;
  }>(
    context.DB,
    `SELECT relation.incident_id AS incident_id,
            relation.component_id AS component_id
       FROM incident_components AS relation
       JOIN components AS component ON component.component_id = relation.component_id
       JOIN services AS service ON service.service_name = component.service_name
      WHERE relation.incident_id IN (${incidentIds.map(() => "?").join(", ")})
        AND component.public = 1 AND component.enabled = 1 AND service.enabled = 1
      ORDER BY relation.incident_id ASC, component.sort_order ASC, relation.component_id ASC`,
    incidentIds,
  );
  for (const row of rows) result.get(row.incident_id)?.push(row.component_id);
  return result;
}

function incidentSummary(
  row: IncidentRow,
  affectedComponents: string[],
): PublicIncidentSummary {
  return {
    incident_id: row.incident_id,
    title: row.title,
    state: row.state,
    impact: row.impact,
    started_at: row.started_at,
    detected_at: row.detected_at,
    resolved_at: row.resolved_at,
    affected_components: affectedComponents,
    latest_update: {
      sequence: Number(row.revision),
      state: row.state,
      impact: row.impact,
      message: row.public_message,
      published_at: row.updated_at,
    },
  };
}

async function maintenanceTargets(
  context: PublicApiContext,
  maintenanceIds: readonly string[],
): Promise<Map<string, { services: string[]; components: string[] }>> {
  const result = new Map<
    string,
    { services: string[]; components: string[] }
  >();
  for (const id of maintenanceIds)
    result.set(id, { services: [], components: [] });
  if (maintenanceIds.length === 0) return result;
  const rows = await allRows<{
    readonly maintenance_id: string;
    readonly target_type: "service" | "component";
    readonly target_id: string;
  }>(
    context.DB,
    `SELECT mt.maintenance_id AS maintenance_id,
            mt.target_type AS target_type,
            mt.target_id AS target_id
       FROM maintenance_targets AS mt
       LEFT JOIN services AS s
         ON mt.target_type = 'service' AND s.service_name = mt.target_id
       LEFT JOIN components AS c
         ON mt.target_type = 'component' AND c.component_id = mt.target_id
       LEFT JOIN services AS component_service
         ON c.service_name = component_service.service_name
      WHERE mt.maintenance_id IN (${maintenanceIds.map(() => "?").join(", ")})
        AND ((mt.target_type = 'service' AND s.enabled = 1)
          OR (mt.target_type = 'component' AND c.public = 1 AND c.enabled = 1 AND component_service.enabled = 1))
      ORDER BY mt.maintenance_id ASC, mt.target_type ASC, mt.target_id ASC`,
    maintenanceIds,
  );
  for (const row of rows) {
    const target = result.get(row.maintenance_id);
    if (!target) continue;
    if (row.target_type === "service") target.services.push(row.target_id);
    else target.components.push(row.target_id);
  }
  return result;
}

/** 单次语句快照避免各页面混用旧依赖缓存。 / One statement snapshot avoids mixing stale dependency caches across pages. */
async function loadStatusSnapshot(context: PublicApiContext, now: Date) {
  const records = await allRows<{ kind: string; payload: string }>(
    context.DB,
    `
    SELECT 'service' AS kind, json_object(
      'service_name',s.service_name,'target_id',s.service_name,'display_name',s.display_name,
      'description',s.description,'direct_status',cs.direct_status,'effective_impact',cs.effective_impact,
      'evaluated_at',cs.evaluated_at,'fresh_until',cs.fresh_until,'fallback_at',s.updated_at) AS payload
    FROM services s LEFT JOIN current_statuses cs ON cs.target_type='service' AND cs.target_id=s.service_name
    WHERE s.enabled=1
    UNION ALL
    SELECT 'component',json_object('target_id',c.component_id,'service_name',c.service_name,
      'display_name',c.display_name,'direct_status',cs.direct_status,'effective_impact',cs.effective_impact,
      'evaluated_at',cs.evaluated_at,'fresh_until',cs.fresh_until,'fallback_at',c.updated_at,'sort_order',c.sort_order)
    FROM components c JOIN services s ON s.service_name=c.service_name
    LEFT JOIN current_statuses cs ON cs.target_type='component' AND cs.target_id=c.component_id
    WHERE c.public=1 AND c.enabled=1 AND s.enabled=1
    UNION ALL
    SELECT 'dependency',json_object('source_service',d.source_service,'target_service',d.target_service,
      'capability',d.capability,'kind',d.kind,'criticality',d.criticality)
    FROM service_dependencies d JOIN services s ON s.service_name=d.source_service
    JOIN services t ON t.service_name=d.target_service WHERE s.enabled=1 AND t.enabled=1
    UNION ALL
    SELECT 'support',json_object('component_id',r.component_id,'service_name',r.service_name)
    FROM component_services r WHERE r.role='supporting'
  `,
  );
  const services: ServiceRow[] = [];
  const components: (StatusRow & {
    service_name: string;
    sort_order: number;
  })[] = [];
  const dependencies: DependencyEdge[] = [];
  const supports: { component_id: string; service_name: string }[] = [];
  for (const record of records) {
    const value = JSON.parse(record.payload);
    if (record.kind === "service") services.push(value);
    if (record.kind === "component") components.push(value);
    if (record.kind === "dependency") dependencies.push(value);
    if (record.kind === "support") supports.push(value);
  }
  services.sort((a, b) =>
    a.service_name < b.service_name
      ? -1
      : a.service_name > b.service_name
        ? 1
        : 0,
  );
  components.sort(
    (a, b) =>
      a.sort_order - b.sort_order || a.target_id.localeCompare(b.target_id),
  );
  const directStatuses = Object.fromEntries(
    services.map((row) => [
      row.service_name,
      freshStatus(row.direct_status, row.fresh_until, now),
    ]),
  );
  const risks = new Map(
    services.map((row) => [
      row.service_name,
      computeDependencyRisk(
        context,
        row.service_name,
        directStatuses,
        dependencies,
      ),
    ]),
  );
  const deadlines = dependencyDeadlines(services, dependencies);
  const projectedServices = services.map((row) => ({
    ...row,
    fresh_until: deadlines.get(row.service_name)!,
    effective_impact: effectiveImpact(
      directStatuses[row.service_name]!,
      risks.get(row.service_name)!.status,
    ),
  }));
  const byName = new Map(
    projectedServices.map((row) => [row.service_name, row]),
  );
  const supportIndex = new Map<string, string[]>();
  for (const link of supports) {
    const names = supportIndex.get(link.component_id) ?? [];
    names.push(link.service_name);
    supportIndex.set(link.component_id, names);
  }
  const projectedComponents = components.map((row) => {
    const supporting = (supportIndex.get(row.target_id) ?? []).map((name) =>
      byName.get(name),
    );
    return {
      ...row,
      effective_impact: aggregateStatus([
        freshStatus(row.direct_status, row.fresh_until, now),
        ...supporting.map((service) =>
          service
            ? freshStatus(service.effective_impact, service.fresh_until, now)
            : ("unknown" as const),
        ),
      ]),
      fresh_until: earliest(
        [
          row.fresh_until ?? row.fallback_at,
          ...supporting.map(
            (service) => service?.fresh_until ?? row.fallback_at,
          ),
        ],
        row.fallback_at,
      ),
    };
  });
  const componentsByService = new Map<string, PublicComponentStatus[]>(
    services.map((row) => [row.service_name, []]),
  );
  for (const row of projectedComponents) {
    const associations = new Set([
      row.service_name,
      ...(supportIndex.get(row.target_id) ?? []),
    ]);
    for (const name of associations)
      componentsByService.get(name)?.push(componentFromRow(row, now));
  }
  recordPublicFreshness(
    context.telemetry,
    projectedComponents,
    now,
    "components",
  );
  return {
    services: projectedServices,
    components: projectedComponents,
    componentsByService,
    risks,
    directStatuses,
  };
}

/** 缓存期限包含所有可达证明；循环只访问一次，直接状态仍使用自己的期限。
 * Cache validity includes every reachable proof; cycles are visited once and direct states retain their own deadlines.
 */
function dependencyDeadlines(
  services: readonly ServiceRow[],
  dependencies: readonly DependencyEdge[],
): Map<string, string> {
  const own = new Map(
    services.map((row) => [
      row.service_name,
      row.fresh_until ?? row.fallback_at,
    ]),
  );
  const adjacency = new Map<string, string[]>();
  for (const edge of dependencies) {
    const targets = adjacency.get(edge.source_service) ?? [];
    targets.push(edge.target_service);
    adjacency.set(edge.source_service, targets);
  }
  const result = new Map<string, string>();
  for (const row of services) {
    const visited = new Set<string>();
    const pending = [row.service_name];
    const deadlines: string[] = [];
    while (pending.length > 0) {
      const name = pending.pop()!;
      if (visited.has(name)) continue;
      visited.add(name);
      deadlines.push(own.get(name) ?? row.fallback_at);
      pending.push(...(adjacency.get(name) ?? []));
    }
    result.set(row.service_name, earliest(deadlines, row.fallback_at));
  }
  return result;
}

/** 依赖边仅含领域投影，禁止泄露配置。 / Dependency edges contain domain projection only, never configuration. */
interface DependencyEdge {
  readonly source_service: string;
  readonly target_service: string;
  readonly capability: string;
  readonly kind: "required" | "optional" | "degraded_fallback";
  readonly criticality: "low" | "medium" | "high" | "critical";
}

/** 在同一快照的直接状态上运行循环安全 Rust 算法。 / Run cycle-safe Rust over direct states from the same snapshot. */
function computeDependencyRisk(
  context: PublicApiContext,
  serviceName: string,
  directStatuses: Record<string, PublicStatus>,
  dependencies: readonly DependencyEdge[],
): DependencyRisk {
  const request = {
    operation: "dependency_risk",
    payload: {
      graph: {
        dependencies: dependencies.map((dependency) => ({
          source_service: dependency.source_service,
          target_service: dependency.target_service,
          kind: dependency.kind,
          capability: dependency.capability,
          criticality: dependency.criticality,
        })),
      },
      source_service: serviceName,
      direct_statuses: directStatuses,
    },
  };
  let raw: unknown;
  try {
    raw = JSON.parse(
      context.dependencyCore.dispatchJson(JSON.stringify(request)),
    );
  } catch {
    throw new Error("Dependency core returned invalid JSON");
  }
  if (typeof raw !== "object" || raw === null)
    throw new Error("Dependency core returned an invalid result");
  const result = raw as Record<string, unknown>;
  if (
    (result.source_service !== undefined &&
      result.source_service !== serviceName) ||
    !Array.isArray(result.contributors)
  ) {
    throw new Error("Dependency core returned an invalid result");
  }
  const contributors = result.contributors;
  const contributorNames = new Set<string>();
  const capabilities = new Set<string>();
  for (const contributor of contributors) {
    if (typeof contributor !== "object" || contributor === null)
      throw new Error("Dependency core returned an invalid contributor");
    const item = contributor as Record<string, unknown>;
    if (
      typeof item.service_name !== "string" ||
      item.service_name === serviceName ||
      typeof item.root_capability !== "string" ||
      item.root_capability.length === 0
    ) {
      throw new Error("Dependency core returned an invalid contributor");
    }
    contributorNames.add(item.service_name);
    capabilities.add(item.root_capability);
  }
  return DependencyRiskSchema.parse({
    status: result.status === "operational" ? "none" : result.status,
    affected_capabilities: [...capabilities].sort(),
    dependency_count: contributorNames.size,
  });
}

function rejectAllQueryParameters(request: Request): void {
  assertQueryKeys(new URL(request.url).searchParams, new Set());
}

function currentTime(context: PublicApiContext): Date {
  return context.now?.() ?? new Date();
}

function singleQuery(search: URLSearchParams, key: string): string | null {
  const values = search.getAll(key);
  if (values.length > 1)
    throw new InvalidRequestError(`${key} must appear at most once`);
  return values[0] ?? null;
}

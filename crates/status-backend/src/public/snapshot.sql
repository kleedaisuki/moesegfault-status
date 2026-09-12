-- 同一语句读取全部状态与依赖，避免混合快照。 / Read statuses and dependencies in one statement to avoid mixed snapshots.
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

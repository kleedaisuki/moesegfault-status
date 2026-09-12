//! 目录聚合命令：不可变身份、完整关系集合和原子 OCC。
//! Catalog aggregate commands: immutable identities, authored relation sets and atomic OCC.
use super::{assert_changed, decode, now, query, required, row, Failure, Plan};
use crate::{
    database::{Database, Query, SqlValue},
    wire::{Id, Revision, Slug, Text},
};
use serde_json::{json, Value};
use status_domain::{Criticality, DependencyKind};
use std::collections::BTreeSet;

/// 校验严格字段和原始 null，避免 optional 将 null 当作未提供。
/// Validate strict fields and raw nulls so optional values cannot erase intent.
fn validate(command: &Value, fields: &[&str], mandatory: &[&str]) -> Result<(), Failure> {
    let object = command
        .as_object()
        .ok_or(Failure::invalid("Invalid catalog command"))?;
    if object.keys().any(|k| !fields.contains(&k.as_str()))
        || mandatory.iter().any(|k| !object.contains_key(*k))
    {
        return Err(Failure::invalid("Invalid catalog fields"));
    }
    for (key, value) in object {
        match key.as_str() {
            "command_id" => {
                decode::<Id>(value)?;
            }
            "service_name" | "owner_service" => {
                decode::<Slug<63>>(value)?;
            }
            "component_id" => {
                decode::<Slug<128>>(value)?;
            }
            "display_name" | "owner" | "capability" => {
                decode::<Text<1, 128>>(value)?;
            }
            "description" => {
                decode::<Text<0, 1024>>(value)?;
            }
            "criticality" => {
                decode::<Criticality>(value)?;
            }
            "kind" => {
                decode::<DependencyKind>(value)?;
            }
            "enabled" | "public" => {
                decode::<bool>(value)?;
            }
            "sort_order" => {
                if decode::<u32>(value)? > 100_000 {
                    return Err(Failure::invalid("Invalid sort order"));
                }
            }
            "dependencies" | "components" | "supporting_services" => {
                if value.as_array().is_none_or(|a| a.len() > 256) {
                    return Err(Failure::invalid("Invalid catalog collection"));
                }
            }
            _ => return Err(Failure::invalid("Invalid catalog field")),
        }
    }
    Ok(())
}

/// SQL 参数只接受已验证标量。 / SQL parameters accept validated scalars only.
fn scalar(v: &Value) -> SqlValue {
    match v {
        Value::String(s) => s.clone().into(),
        Value::Bool(b) => (*b).into(),
        Value::Number(n) => n.as_i64().unwrap_or_default().into(),
        _ => SqlValue::Null,
    }
}

/// 用一个 JSON 参数校验关系集合，避免 N 次 D1 往返和绑定参数上限。
/// Validate a relation set with one JSON parameter, avoiding N D1 round trips and bind limits.
async fn services_exist(db: &Database, ids: BTreeSet<&str>) -> Result<(), Failure> {
    if ids.is_empty() {
        return Ok(());
    }
    let count = row(
        db,
        "SELECT COUNT(*) AS n FROM services WHERE service_name IN (SELECT value FROM json_each(?))",
        vec![json!(ids).to_string().into()],
    )
    .await?
    .ok_or(Failure::internal("Missing existence result"))?;
    if count["n"].as_u64() != Some(ids.len() as u64) {
        return Err(Failure::invalid("Unknown catalog service"));
    }
    Ok(())
}

/// 创建或更新目录，审计/outbox/幂等由共同执行器追加。
/// Plan catalog creation or mutation; the shared executor appends audit/outbox/idempotency.
pub(super) async fn plan(db: &Database, op: &str, raw: &Value) -> Result<Plan, Failure> {
    let service = matches!(op, "registerService" | "updateServiceCatalog");
    let create = matches!(op, "registerService" | "createComponent");
    let command = &raw["command"];
    let service_fields = [
        "command_id",
        "service_name",
        "display_name",
        "description",
        "owner",
        "criticality",
        "enabled",
        "components",
        "dependencies",
    ];
    let component_fields = [
        "command_id",
        "component_id",
        "owner_service",
        "display_name",
        "description",
        "public",
        "sort_order",
        "enabled",
        "supporting_services",
    ];
    let fields: Vec<&str> = if service {
        service_fields.to_vec()
    } else {
        component_fields.to_vec()
    }
    .into_iter()
    .filter(|f| {
        create
            || ![
                "service_name",
                "component_id",
                "owner_service",
                "components",
            ]
            .contains(f)
    })
    .collect();
    validate(
        command,
        &fields,
        if create { &fields } else { &["command_id"] },
    )?;
    if !create && command.as_object().is_none_or(|o| o.len() < 2) {
        return Err(Failure::invalid("At least one mutable field is required"));
    }
    if op == "registerService" {
        decode::<Text<1, 1024>>(&command["description"])?;
    }
    let id_field = if service {
        "service_name"
    } else {
        "component_id"
    };
    let id = required(if create { command } else { raw }, id_field)?.to_owned();
    if service {
        decode::<Slug<63>>(&json!(id))?;
    } else {
        decode::<Slug<128>>(&json!(id))?;
    }
    let table = if service { "services" } else { "components" };
    let timestamp = now();
    let mut before = Value::Null;
    let revision = if create {
        1
    } else {
        let expected = decode::<Revision>(&raw["expected_revision"])?.get() as i64;
        if expected >= 9_007_199_254_740_991 {
            return Err(Failure::conflict("Revision exhausted"));
        }
        before = row(
            db,
            format!("SELECT * FROM {table} WHERE {id_field}=?"),
            vec![id.clone().into()],
        )
        .await?
        .ok_or(Failure::missing("Catalog target not found"))?;
        if before["revision"].as_i64() != Some(expected) {
            return Err(Failure::conflict("Catalog revision conflict"));
        }
        expected + 1
    };
    let mut data = if create {
        command.clone()
    } else {
        before.clone()
    };
    for (k, v) in command
        .as_object()
        .ok_or(Failure::invalid("Invalid catalog command"))?
    {
        data[k] = v.clone();
    }
    data.as_object_mut().unwrap().remove("command_id");
    data[id_field] = json!(id);
    data["revision"] = json!(revision);
    data["updated_at"] = json!(timestamp);
    if create {
        data["created_at"] = json!(timestamp);
    }
    let columns = if service {
        vec![
            "display_name",
            "description",
            "owner",
            "criticality",
            "enabled",
        ]
    } else {
        vec![
            "display_name",
            "description",
            "public",
            "sort_order",
            "enabled",
        ]
    };
    for key in ["enabled", "public"] {
        if data[key].is_number() {
            data[key] = json!(data[key].as_i64() == Some(1));
        }
    }
    let mut queries = Vec::new();
    if create {
        let mut cols = vec![id_field];
        if !service {
            cols.push("service_name");
        }
        cols.extend(columns.iter().copied());
        cols.extend(["created_at", "updated_at", "revision"]);
        let mut values = vec![id.clone().into()];
        if !service {
            values.push(scalar(&data["owner_service"]));
        }
        values.extend(columns.iter().map(|k| scalar(&data[*k])));
        values.extend([
            timestamp.clone().into(),
            timestamp.clone().into(),
            revision.into(),
        ]);
        queries.push(query(
            format!(
                "INSERT INTO {table} ({}) VALUES ({})",
                cols.join(","),
                vec!["?"; cols.len()].join(",")
            ),
            values,
        ));
    } else {
        let mut values: Vec<_> = columns.iter().map(|k| scalar(&data[*k])).collect();
        values.extend([
            timestamp.clone().into(),
            id.clone().into(),
            (revision - 1).into(),
        ]);
        queries.push(query(format!("UPDATE {table} SET {},updated_at=?,revision=revision+1 WHERE {id_field}=? AND revision=?",columns.iter().map(|c|format!("{c}=?")).collect::<Vec<_>>().join(",")),values));
        queries.push(assert_changed());
    }
    if service {
        dependencies(db, command, &id, &timestamp, &mut queries, &mut data).await?;
    } else {
        supports(
            db,
            command,
            required(
                if create { command } else { &before },
                if create {
                    "owner_service"
                } else {
                    "service_name"
                },
            )?,
            &id,
            &timestamp,
            &mut queries,
            &mut data,
        )
        .await?;
    }
    if op == "registerService" {
        let mut seen = BTreeSet::new();
        for c in command["components"]
            .as_array()
            .ok_or(Failure::invalid("Invalid components"))?
        {
            let fields = ["component_id", "display_name", "public", "sort_order"];
            validate(c, &fields, &fields)?;
            let cid = required(c, "component_id")?;
            if !seen.insert(cid) {
                return Err(Failure::invalid("Duplicate component"));
            }
            queries.push(query("INSERT INTO components(component_id,service_name,display_name,public,sort_order,created_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,1)",vec![cid.into(),id.clone().into(),scalar(&c["display_name"]),scalar(&c["public"]),scalar(&c["sort_order"]),timestamp.clone().into(),timestamp.clone().into()]));
        }
        data["components"].as_array_mut().unwrap().sort_by_key(|c| {
            (
                c["sort_order"].as_i64().unwrap_or_default(),
                c["component_id"].as_str().unwrap_or_default().to_owned(),
            )
        });
        data["registered_at"] = json!(timestamp);
        data.as_object_mut().unwrap().remove("created_at");
        data.as_object_mut().unwrap().remove("updated_at");
    }
    let action = match op {
        "registerService" => "service.registered",
        "updateServiceCatalog" => "service.catalog_updated",
        "createComponent" => "component.created",
        _ => "component.catalog_updated",
    };
    let mut plan = Plan::new(
        queries,
        data,
        if service { "service" } else { "component" },
        id,
        action,
    );
    plan.event_type = "catalog.changed";
    plan.event_payload = Some(if service {
        json!({"service_name":plan.target_id,"revision":revision})
    } else {
        json!({"component_id":plan.target_id,"owner_service":plan.response["owner_service"],"revision":revision})
    });
    plan.before_revision = (!create).then_some(revision - 1);
    plan.after_revision = Some(revision);
    plan.details = json!({"changed_fields":command.as_object().unwrap().keys().filter(|k|k.as_str()!="command_id").collect::<Vec<_>>()});
    Ok(plan)
}

/// 按稳定边身份更新而非删除重建，保留 created_at。
/// Upsert by stable edge identity rather than recreating retained edges, preserving created_at.
async fn dependencies(
    db: &Database,
    command: &Value,
    id: &str,
    at: &str,
    queries: &mut Vec<Query>,
    data: &mut Value,
) -> Result<(), Failure> {
    let old=db.all::<Value>(&query("SELECT target_service,capability,kind,criticality FROM service_dependencies WHERE source_service=? ORDER BY target_service,capability",vec![id.into()])).await?;
    let Some(edges) = command.get("dependencies") else {
        data["dependencies"] = json!(old);
        return Ok(());
    };
    let edges = edges
        .as_array()
        .ok_or(Failure::invalid("Invalid dependencies"))?;
    let mut keys = BTreeSet::new();
    for edge in edges {
        let fields = ["target_service", "capability", "kind", "criticality"];
        // target_service 单独校验，避免将标识当普通文本。 / Validate target identity separately.
        let mut copy = edge.clone();
        let target = required(edge, "target_service")?;
        decode::<Slug<63>>(&json!(target))?;
        if edge
            .as_object()
            .is_none_or(|o| o.len() != 4 || o.keys().any(|k| !fields.contains(&k.as_str())))
        {
            return Err(Failure::invalid("Invalid dependency"));
        }
        copy.as_object_mut().unwrap().remove("target_service");
        validate(&copy, &fields[1..], &fields[1..])?;
        let capability = required(edge, "capability")?;
        if target == id || !keys.insert((target, capability)) {
            return Err(Failure::invalid("Self or duplicate dependency"));
        }
        queries.push(query("INSERT INTO service_dependencies(source_service,target_service,capability,kind,criticality,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(source_service,target_service,capability) DO UPDATE SET kind=excluded.kind,criticality=excluded.criticality",vec![id.into(),target.into(),capability.into(),scalar(&edge["kind"]),scalar(&edge["criticality"]),at.into()]));
    }
    services_exist(db, keys.iter().map(|(target, _)| *target).collect()).await?;
    for edge in old {
        let target = required(&edge, "target_service")?;
        let cap = required(&edge, "capability")?;
        if !keys.contains(&(target, cap)) {
            queries.push(query("DELETE FROM service_dependencies WHERE source_service=? AND target_service=? AND capability=?",vec![id.into(),target.into(),cap.into()]));
        }
    }
    let mut ordered = edges.clone();
    ordered.sort_by_key(|e| {
        (
            e["target_service"].as_str().unwrap_or_default().to_owned(),
            e["capability"].as_str().unwrap_or_default().to_owned(),
        )
    });
    data["dependencies"] = json!(ordered);
    Ok(())
}

/// owner 不可变；补齐旧注册路径缺少的冗余关系。
/// Owner is immutable; materialize the redundant relationship missing from legacy registration.
async fn supports(
    db: &Database,
    command: &Value,
    owner: &str,
    id: &str,
    at: &str,
    queries: &mut Vec<Query>,
    data: &mut Value,
) -> Result<(), Failure> {
    let old=db.all::<Value>(&query("SELECT service_name,role FROM component_services WHERE component_id=? ORDER BY service_name",vec![id.into()])).await?;
    if old.iter().any(|r| {
        (r["role"] == "owner" && r["service_name"] != owner)
            || (r["service_name"] == owner && r["role"] != "owner")
    }) {
        return Err(Failure::conflict(
            "Component owner relationship is inconsistent",
        ));
    }
    let prior: Vec<Value> = old
        .iter()
        .filter(|r| r["role"] == "supporting")
        .map(|r| r["service_name"].clone())
        .collect();
    let desired = command
        .get("supporting_services")
        .cloned()
        .unwrap_or(json!(prior));
    let mut names = BTreeSet::new();
    for value in desired
        .as_array()
        .ok_or(Failure::invalid("Invalid supporting services"))?
    {
        let name = decode::<Slug<63>>(value)?;
        let name = name.as_str().to_owned();
        if name == owner || !names.insert(name.clone()) {
            return Err(Failure::invalid("Owner or duplicate supporting service"));
        }
    }
    services_exist(
        db,
        names
            .iter()
            .map(String::as_str)
            .chain(std::iter::once(owner))
            .collect(),
    )
    .await?;
    queries.push(query("INSERT INTO component_services(component_id,service_name,role,created_at) VALUES (?,?,'owner',?) ON CONFLICT(component_id,service_name) DO NOTHING",vec![id.into(),owner.into(),at.into()]));
    for value in &prior {
        let name = value
            .as_str()
            .ok_or(Failure::internal("Invalid stored supporting service"))?;
        if !names.contains(name) {
            queries.push(query("DELETE FROM component_services WHERE component_id=? AND service_name=? AND role='supporting'",vec![id.into(),name.into()]));
        }
    }
    for name in &names {
        queries.push(query("INSERT INTO component_services(component_id,service_name,role,created_at) VALUES (?,?,'supporting',?) ON CONFLICT(component_id,service_name) DO NOTHING",vec![id.into(),name.clone().into(),at.into()]));
    }
    data.as_object_mut().unwrap().remove("service_name");
    data["owner_service"] = json!(owner);
    data["supporting_services"] = json!(names);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_validation_rejects_null_unknown_fields_and_large_sort() {
        assert!(validate(&json!({"enabled":null}), &["enabled"], &[]).is_err());
        assert!(validate(&json!({"owner_service":"api"}), &["display_name"], &[]).is_err());
        assert!(validate(&json!({"sort_order":100_001}), &["sort_order"], &[]).is_err());
        assert!(validate(
            &json!({"sort_order":0,"enabled":false}),
            &["sort_order", "enabled"],
            &[]
        )
        .is_ok());
        assert!(validate(&json!({}), &["description"], &["description"]).is_err());
    }

    #[test]
    fn text_limits_match_browser_utf16_and_collections_are_bounded() {
        assert!(validate(
            &json!({"display_name":"😀".repeat(65)}),
            &["display_name"],
            &[]
        )
        .is_err());
        assert!(validate(&json!({"description":""}), &["description"], &[]).is_ok());
        assert!(validate(
            &json!({"dependencies":vec![Value::Null;257]}),
            &["dependencies"],
            &[]
        )
        .is_err());
    }
}

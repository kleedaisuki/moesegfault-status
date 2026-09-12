//! 有向依赖图的循环安全风险视图。 / Cycle-safe risk view over a directed dependency graph.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::{Deserialize, Serialize};

use crate::{DomainError, DomainResult, Status};

/// 服务依赖的交互种类。 / Interaction kind of a service dependency.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DependencyKind {
    /// capability 不存在时调用方无法履约。 / Caller cannot meet its contract without the capability.
    Required,
    /// 有明确降级路径的可选能力。 / Optional capability with an explicit fallback.
    Optional,
    /// 主路径失败时启用的降级依赖。 / Fallback dependency activated when the primary path fails.
    DegradedFallback,
}

/// 目录中依赖边的业务关键度。 / Business criticality of a dependency edge in the registry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Criticality {
    /// 可选增强能力；最大风险为 degraded。 / Optional enhancement; maximum risk is degraded.
    Low,
    /// 常用但有降级路径；最大风险为 degraded。 / Common dependency with fallback; maximum risk is degraded.
    Medium,
    /// 主要能力的一部分；最大风险为 partial outage。 / Part of a primary capability; maximum risk is partial outage.
    High,
    /// 核心强依赖；最大风险为 major outage。 / Hard dependency of the core capability; maximum risk is major outage.
    Critical,
}

impl Criticality {
    const fn maximum_impact(self) -> Status {
        match self {
            Self::Low | Self::Medium => Status::Degraded,
            Self::High => Status::PartialOutage,
            Self::Critical => Status::MajorOutage,
        }
    }
}

/// 一条 `source -> target` 有向依赖边。 / One directed `source -> target` dependency edge.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Dependency {
    /// 调用或依赖方服务。 / Calling or dependent service.
    pub source_service: String,
    /// 被依赖服务。 / Target dependency service.
    pub target_service: String,
    /// 交互种类。 / Interaction kind.
    pub kind: DependencyKind,
    /// 稳定 capability 名称。 / Stable capability name.
    pub capability: String,
    /// 业务关键度，按规范映射为最大风险。 / Business criticality, normatively mapped to maximum risk.
    pub criticality: Criticality,
}

/// 已验证的有向依赖图；循环是合法输入。 / Validated directed dependency graph; cycles are legal input.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DependencyGraph {
    /// 图的边集合。 / Edge set of the graph.
    pub dependencies: Vec<Dependency>,
}

impl DependencyGraph {
    /// 校验名称、影响和边唯一性。 / Validates names, impacts, and edge uniqueness.
    pub fn validate(&self) -> DomainResult<()> {
        let mut unique = BTreeSet::new();
        for edge in &self.dependencies {
            if edge.source_service.trim().is_empty()
                || edge.target_service.trim().is_empty()
                || edge.capability.trim().is_empty()
            {
                return Err(DomainError::Validation(
                    "dependency service and capability names must be non-empty".into(),
                ));
            }
            let key = (
                edge.source_service.as_str(),
                edge.target_service.as_str(),
                edge.capability.as_str(),
            );
            if !unique.insert(key) {
                return Err(DomainError::Validation(
                    "duplicate source/target/capability dependency edge".into(),
                ));
            }
        }
        Ok(())
    }
}

/// 一个导致依赖风险的可审计路径。 / One auditable path contributing dependency risk.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DependencyContributor {
    /// 从查询源出发的根 capability。 / Root capability from the queried source.
    pub root_capability: String,
    /// 路径终点的服务。 / Service at the end of the path.
    pub service_name: String,
    /// 终点服务自身状态，不改写调用方状态。 / Endpoint service's own status, which does not overwrite the caller status.
    pub direct_status: Status,
    /// 沿边限制后的风险状态。 / Risk status after edge-wise clamping.
    pub risk_status: Status,
    /// 从查询源到终点的服务路径。 / Service path from the queried source to the endpoint.
    pub path: Vec<String>,
}

/// 与 direct status 分离的依赖风险结果。 / Dependency-risk result kept separate from direct status.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DependencyRisk {
    /// 被查询服务。 / Queried service.
    pub source_service: String,
    /// 最强风险；不代表源服务自身故障。 / Strongest risk; does not claim the source itself is failing.
    pub status: Status,
    /// 确定性遍历产生的贡献路径。 / Contributor paths produced by deterministic traversal.
    pub contributors: Vec<DependencyContributor>,
}

/// 以迭代 `visited set` 计算循环安全依赖风险。 / Computes cycle-safe dependency risk with an iterative visited set.
pub fn compute_dependency_risk(
    graph: &DependencyGraph,
    source_service: &str,
    direct_statuses: &BTreeMap<String, Status>,
) -> DomainResult<DependencyRisk> {
    graph.validate()?;
    if source_service.trim().is_empty() {
        return Err(DomainError::Validation(
            "source_service must be non-empty".into(),
        ));
    }

    let mut adjacency: BTreeMap<&str, Vec<&Dependency>> = BTreeMap::new();
    for edge in &graph.dependencies {
        adjacency
            .entry(&edge.source_service)
            .or_default()
            .push(edge);
    }
    for edges in adjacency.values_mut() {
        edges.sort_by(|left, right| {
            (&left.target_service, &left.capability)
                .cmp(&(&right.target_service, &right.capability))
        });
    }

    // A plain service-only visited set loses stronger parallel capabilities.  The
    // best cap per (service, root capability) remains finite (four ranked states),
    // so cycles terminate while all materially different root capabilities survive.
    let mut visited: BTreeMap<(String, String), u8> = BTreeMap::new();
    let mut queue = VecDeque::new();
    if let Some(edges) = adjacency.get(source_service) {
        for edge in edges {
            visited.insert(
                (source_service.to_owned(), edge.capability.clone()),
                Status::MajorOutage.failure_rank().unwrap_or(3),
            );
            queue.push_back((
                *edge,
                vec![source_service.to_owned(), edge.target_service.clone()],
                edge.criticality.maximum_impact(),
                edge.capability.clone(),
            ));
        }
    }

    let mut contributor_map: BTreeMap<(String, String), DependencyContributor> = BTreeMap::new();
    while let Some((edge, path, path_cap, root_capability)) = queue.pop_front() {
        let key = (edge.target_service.clone(), root_capability.clone());
        let cap_rank = path_cap.failure_rank().unwrap_or(0);
        if visited.get(&key).is_some_and(|seen| *seen >= cap_rank) {
            continue;
        }
        visited.insert(key.clone(), cap_rank);
        let direct = direct_statuses
            .get(&edge.target_service)
            .copied()
            .unwrap_or(Status::Unknown);
        let risk = match direct {
            Status::Operational => Status::Operational,
            Status::Degraded | Status::PartialOutage | Status::MajorOutage => {
                direct.clamp_failure(path_cap)
            }
            Status::Maintenance | Status::Unknown => Status::Unknown,
        };
        if risk != Status::Operational {
            contributor_map.insert(
                key,
                DependencyContributor {
                    root_capability: root_capability.clone(),
                    service_name: edge.target_service.clone(),
                    direct_status: direct,
                    risk_status: risk,
                    path: path.clone(),
                },
            );
        }

        if let Some(next_edges) = adjacency.get(edge.target_service.as_str()) {
            for next in next_edges {
                let mut next_path = path.clone();
                next_path.push(next.target_service.clone());
                let cap = path_cap.clamp_failure(next.criticality.maximum_impact());
                queue.push_back((*next, next_path, cap, root_capability.clone()));
            }
        }
    }
    let contributors: Vec<_> = contributor_map.into_values().collect();
    let uncertain = contributors
        .iter()
        .any(|contributor| contributor.risk_status == Status::Unknown);
    let mut strongest = contributors
        .iter()
        .map(|contributor| contributor.risk_status)
        .filter_map(|status| status.failure_rank())
        .max()
        .map(Status::from_failure_rank)
        .unwrap_or(Status::Operational);
    if strongest == Status::Operational && uncertain {
        strongest = Status::Unknown;
    }
    Ok(DependencyRisk {
        source_service: source_service.to_owned(),
        status: strongest,
        contributors,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(source: &str, target: &str, criticality: Criticality) -> Dependency {
        Dependency {
            source_service: source.into(),
            target_service: target.into(),
            kind: DependencyKind::Required,
            capability: format!("{source}-to-{target}"),
            criticality,
        }
    }

    #[test]
    fn cycle_terminates_and_never_marks_source_as_its_own_dependency() {
        let graph = DependencyGraph {
            dependencies: vec![
                edge("a", "b", Criticality::Critical),
                edge("b", "c", Criticality::High),
                edge("c", "a", Criticality::Critical),
            ],
        };
        let statuses = BTreeMap::from([
            ("a".into(), Status::Operational),
            ("b".into(), Status::Operational),
            ("c".into(), Status::MajorOutage),
        ]);
        let risk = compute_dependency_risk(&graph, "a", &statuses).unwrap();
        assert_eq!(risk.status, Status::PartialOutage);
        assert_eq!(risk.contributors.len(), 1);
        assert_eq!(risk.contributors[0].path, ["a", "b", "c"]);
    }

    #[test]
    fn unknown_dependency_is_not_claimed_as_an_outage() {
        let graph = DependencyGraph {
            dependencies: vec![edge("a", "b", Criticality::Critical)],
        };
        let risk = compute_dependency_risk(&graph, "a", &BTreeMap::new()).unwrap();
        assert_eq!(risk.status, Status::Unknown);
        assert_eq!(risk.contributors[0].direct_status, Status::Unknown);
    }

    #[test]
    fn stronger_parallel_capability_is_not_hidden_by_first_edge() {
        let mut low = edge("a", "b", Criticality::Low);
        low.capability = "alpha".into();
        let mut critical = edge("a", "b", Criticality::Critical);
        critical.capability = "omega".into();
        let graph = DependencyGraph {
            dependencies: vec![low, critical],
        };
        let statuses = BTreeMap::from([("b".into(), Status::MajorOutage)]);
        let risk = compute_dependency_risk(&graph, "a", &statuses).unwrap();
        assert_eq!(risk.status, Status::MajorOutage);
        assert_eq!(risk.contributors.len(), 2);
        assert_eq!(risk.contributors[0].root_capability, "alpha");
        assert_eq!(risk.contributors[1].root_capability, "omega");
    }
}

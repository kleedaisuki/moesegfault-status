//! 管理目录快照读取；类型约束在 D1 解码边界执行。
//! Administrative catalog snapshots with type constraints enforced at the D1 decoding boundary.

use super::{RpcContext, RpcProblem};
use crate::{
    access::AdminRole,
    database::{Database, Query},
    wire::{Id, Revision, Slug, Text, UtcTime},
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use status_domain::{Criticality, DependencyKind, Environment};

/// 已声明的私有读取方法，不提供任意 SQL 或通用公开 RPC。
/// Declared private read methods, never arbitrary SQL or public generic RPC.
#[derive(Clone, Copy)]
pub enum ReadOperation {
    /// 服务目录。 / Service catalog.
    Service,
    /// 组件目录。 / Component catalog.
    Component,
    /// 服务保留策略。 / Service retention assignment.
    Retention,
    /// 部署激活上下文。 / Deployment activation context.
    Activation,
}
impl ReadOperation {
    /// 保持既有方法名。 / Preserve existing method names.
    pub fn name(self) -> &'static str {
        match self {
            Self::Service => "getServiceCatalog",
            Self::Component => "getComponentCatalog",
            Self::Retention => "getServiceRetentionPolicyAssignment",
            Self::Activation => "getDeploymentActivationContext",
        }
    }
    /// 唯一目标字段。 / Sole target field.
    fn field(self) -> &'static str {
        match self {
            Self::Service | Self::Retention => "service_name",
            Self::Component => "component_id",
            Self::Activation => "deployment_id",
        }
    }
}

/// 类型化有向目录依赖。 / Typed directed catalog dependency.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogDependency {
    /// 目标服务。 / Target service.
    pub target_service: Slug<63>,
    /// 稳定能力。 / Stable capability.
    pub capability: Text<1, 128>,
    /// 依赖种类。 / Dependency kind.
    pub kind: DependencyKind,
    /// 业务关键性。 / Business criticality.
    pub criticality: Criticality,
}
/// 可审计的服务目录快照。 / Auditable service catalog snapshot.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceCatalog {
    /// 稳定身份。 / Stable identity.
    pub service_name: Slug<63>,
    /// 显示名。 / Display name.
    pub display_name: Text<1, 128>,
    /// 描述。 / Description.
    pub description: Text<0, 1024>,
    /// 负责人。 / Owner.
    pub owner: Text<1, 128>,
    /// 关键性。 / Criticality.
    pub criticality: Criticality,
    /// 启用状态。 / Enabled state.
    pub enabled: bool,
    /// 完整 authored 依赖集合。 / Complete authored dependency set.
    pub dependencies: Vec<CatalogDependency>,
    /// 创建时间。 / Creation time.
    pub created_at: UtcTime,
    /// 更新时间。 / Update time.
    pub updated_at: UtcTime,
    /// OCC 版本。 / OCC revision.
    pub revision: Revision,
}
/// 稳定 owner 的组件目录快照。 / Component snapshot with a stable owner.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ComponentCatalog {
    /// 稳定组件标识。 / Stable component identity.
    pub component_id: Slug<128>,
    /// 唯一 owner。 / Sole owner.
    pub owner_service: Slug<63>,
    /// 显示名。 / Display name.
    pub display_name: Text<1, 128>,
    /// 描述。 / Description.
    pub description: Text<0, 1024>,
    /// 公开性。 / Public visibility.
    pub public: bool,
    /// 排序序号。 / Sort order.
    pub sort_order: u32,
    /// 启用状态。 / Enabled state.
    pub enabled: bool,
    /// 额外支撑服务。 / Additional supporting services.
    pub supporting_services: Vec<Slug<63>>,
    /// 创建时间。 / Creation time.
    pub created_at: UtcTime,
    /// 更新时间。 / Update time.
    pub updated_at: UtcTime,
    /// OCC 版本。 / OCC revision.
    pub revision: Revision,
}

/// 私有能力入口调用的读取分派；不应从 HTTP 传入伪造主体。
/// Read dispatch for the private capability entrypoint; never pass forged HTTP principals here.
pub async fn read(db: &Database, operation: ReadOperation, raw: Value) -> Value {
    match perform(db, operation, &raw).await {
        Ok(Some(data)) => json!({"data":data}),
        Ok(None) => {
            json!({"problem":RpcProblem::new(404,"Administrative snapshot not found",&raw,operation.name())})
        }
        Err(problem) => json!({"problem":problem}),
    }
}

/// 在存储访问前完成全部请求校验。 / Complete request validation before storage access.
async fn perform(
    db: &Database,
    operation: ReadOperation,
    raw: &Value,
) -> Result<Option<Value>, RpcProblem> {
    let fail = |code, title| RpcProblem::new(code, title, raw, operation.name());
    let context = RpcContext::parse(raw, &[operation.field()])
        .map_err(|_| fail(400, "Invalid RPC request"))?;
    if !context.require(AdminRole::Viewer) {
        return Err(fail(403, "Forbidden"));
    }
    let target = raw[operation.field()]
        .as_str()
        .ok_or_else(|| fail(400, "Invalid RPC request"))?;
    let valid = match operation {
        ReadOperation::Service | ReadOperation::Retention => Slug::<63>::new(target.into()).is_ok(),
        ReadOperation::Component => Slug::<128>::new(target.into()).is_ok(),
        ReadOperation::Activation => Id::new(target.into()).is_ok(),
    };
    if !valid {
        return Err(fail(400, "Invalid RPC request"));
    }
    let result = match operation {
        ReadOperation::Service => service(db, target).await,
        ReadOperation::Component => component(db, target).await,
        ReadOperation::Retention => retention(db, target).await,
        ReadOperation::Activation => activation(db, target).await,
    };
    result.map_err(|_| fail(500, "Administrative read failed"))
}

/// JSON 对象在 SQLite 单语句内产生，保持目录与关系同一快照。
/// Build JSON within one SQLite statement, keeping catalog and relationships in one snapshot.
async fn load<T: DeserializeOwned>(
    db: &Database,
    sql: &str,
    target: &str,
) -> Result<Option<T>, ()> {
    #[derive(Deserialize)]
    struct Row {
        payload: String,
    }
    let row: Option<Row> = db
        .first(&Query::new(sql, vec![target.into()]))
        .await
        .map_err(|_| ())?;
    row.map(|row| serde_json::from_str(&row.payload).map_err(|_| ()))
        .transpose()
}

/// 服务和依赖的一致快照。 / Consistent service/dependency snapshot.
async fn service(db: &Database, target: &str) -> Result<Option<Value>, ()> {
    let row:Option<ServiceCatalog>=load(db,"SELECT json_object('service_name',s.service_name,'display_name',s.display_name,'description',s.description,'owner',s.owner,'criticality',s.criticality,'enabled',json(CASE WHEN s.enabled=1 THEN 'true' ELSE 'false' END),'created_at',s.created_at,'updated_at',s.updated_at,'revision',s.revision,'dependencies',json(COALESCE((SELECT json_group_array(json_object('target_service',ordered.target_service,'capability',ordered.capability,'kind',ordered.kind,'criticality',ordered.criticality)) FROM (SELECT target_service,capability,kind,criticality FROM service_dependencies WHERE source_service=s.service_name ORDER BY target_service,capability) ordered),'[]'))) AS payload FROM services s WHERE s.service_name=?",target).await?;
    if row.as_ref().is_some_and(|r| r.dependencies.len() > 256) {
        return Err(());
    }
    row.map(|r| serde_json::to_value(r).map_err(|_| ()))
        .transpose()
}

/// 组件与支撑关系的一致快照。 / Consistent component/support snapshot.
async fn component(db: &Database, target: &str) -> Result<Option<Value>, ()> {
    let row:Option<ComponentCatalog>=load(db,"SELECT json_object('component_id',c.component_id,'owner_service',c.service_name,'display_name',c.display_name,'description',c.description,'public',json(CASE WHEN c.public=1 THEN 'true' ELSE 'false' END),'sort_order',c.sort_order,'enabled',json(CASE WHEN c.enabled=1 THEN 'true' ELSE 'false' END),'created_at',c.created_at,'updated_at',c.updated_at,'revision',c.revision,'supporting_services',json(COALESCE((SELECT json_group_array(ordered.service_name) FROM (SELECT service_name FROM component_services WHERE component_id=c.component_id AND role='supporting' ORDER BY service_name) ordered),'[]'))) AS payload FROM components c WHERE c.component_id=?",target).await?;
    if row
        .as_ref()
        .is_some_and(|r| r.supporting_services.len() > 256 || r.sort_order > 100_000)
    {
        return Err(());
    }
    row.map(|r| serde_json::to_value(r).map_err(|_| ()))
        .transpose()
}

/// 保留策略 revision。 / Retention policy revision.
#[derive(Deserialize, Serialize)]
struct RetentionPolicy {
    /// 策略标识。 / Policy identity.
    policy_id: Text<1, 64>,
    /// 策略版本。 / Policy revision.
    revision: Revision,
    /// 原始 occurrence 保留天数。 / Raw occurrence retention days.
    occurrence_retention_days: u32,
    /// 清理批次上限。 / Cleanup batch bound.
    cleanup_batch_size: u32,
}
/// 可追溯的策略绑定。 / Traceable policy assignment.
#[derive(Deserialize, Serialize)]
struct Retention {
    /// 服务。 / Service.
    service_name: Slug<63>,
    /// 已登记策略。 / Registered policy.
    policy: RetentionPolicy,
    /// 绑定版本。 / Assignment revision.
    assignment_revision: Revision,
    /// 绑定时间。 / Assignment time.
    assigned_at: UtcTime,
    /// 绑定操作者。 / Assignment actor.
    assigned_by: Text<1, 255>,
    /// 策略登记时间。 / Policy registration time.
    policy_registered_at: UtcTime,
    /// 策略登记者。 / Policy registrar.
    policy_registered_by: Text<1, 255>,
}
/// 读取保留策略，不隐式创建默认绑定。 / Read retention policy without implicitly creating defaults.
async fn retention(db: &Database, target: &str) -> Result<Option<Value>, ()> {
    let row:Option<Retention>=load(db,"SELECT json_object('service_name',s.service_name,'policy',json_object('policy_id',s.policy_id,'revision',s.policy_revision,'occurrence_retention_days',p.occurrence_retention_days,'cleanup_batch_size',p.cleanup_batch_size),'assignment_revision',s.revision,'assigned_at',s.assigned_at,'assigned_by',s.assigned_by,'policy_registered_at',p.created_at,'policy_registered_by',p.created_by) AS payload FROM service_retention_policies s JOIN data_retention_policies p ON p.policy_id=s.policy_id AND p.revision=s.policy_revision WHERE s.service_name=?",target).await?;
    if row.as_ref().is_some_and(|r| {
        !valid_policy_id(r.policy.policy_id.as_str())
            || !(1..=3650).contains(&r.policy.occurrence_retention_days)
            || !(1..=10_000).contains(&r.policy.cleanup_batch_size)
    }) {
        return Err(());
    }
    row.map(|r| serde_json::to_value(r).map_err(|_| ()))
        .transpose()
}

/// 策略标识以小写字母开始，分隔符之间必须有非空字母数字段。
/// Policy identifiers start with lowercase letters and have nonempty alphanumeric segments.
fn valid_policy_id(value: &str) -> bool {
    value.bytes().next().is_some_and(|b| b.is_ascii_lowercase())
        && value.split(['-', '_', '.']).all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

/// 部署生命周期。 / Deployment lifecycle.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum DeploymentState {
    Registered,
    ArtifactsPending,
    Ready,
    Active,
    Retired,
    Failed,
}
/// 当前部署指针。 / Current deployment pointer.
#[derive(Deserialize, Serialize)]
struct Pointer {
    /// 指向的部署。 / Referenced deployment.
    deployment_id: Id,
    /// 指针版本。 / Pointer revision.
    revision: Revision,
}
/// 激活命令读取的完整并发控制上下文。 / Complete concurrency context used by activation commands.
#[derive(Deserialize, Serialize)]
struct Activation {
    /// 目标部署。 / Target deployment.
    deployment_id: Id,
    /// 服务。 / Service.
    service_name: Slug<63>,
    /// 环境。 / Environment.
    environment: Environment,
    /// 生命周期状态。 / Lifecycle state.
    state: DeploymentState,
    /// 部署版本。 / Deployment revision.
    deployment_revision: Revision,
    /// 当前指针或明确的 null。 / Current pointer or explicit null.
    current_pointer: Option<Pointer>,
}
/// 同一查询读部署版本与指针版本，避免混合读。 / Read deployment and pointer revisions together, avoiding mixed reads.
async fn activation(db: &Database, target: &str) -> Result<Option<Value>, ()> {
    let row:Option<Activation>=load(db,"SELECT json_object('deployment_id',d.deployment_id,'service_name',d.service_name,'environment',d.environment,'state',s.state,'deployment_revision',s.revision,'current_pointer',CASE WHEN p.deployment_id IS NULL THEN NULL ELSE json_object('deployment_id',p.deployment_id,'revision',p.revision) END) AS payload FROM deployments d JOIN deployment_current_status s ON s.deployment_id=d.deployment_id LEFT JOIN service_environment_deployments p ON p.service_name=d.service_name AND p.environment=d.environment WHERE d.deployment_id=?",target).await?;
    row.map(|r| serde_json::to_value(r).map_err(|_| ()))
        .transpose()
}

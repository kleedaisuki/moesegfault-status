# Evidence backend queries / 证据后端查询

本模块把 `telemetry_backends` 中原本只被保存的 `query_adapter`、
`ui_url_template`、`auth_reference` 与 `capabilities_json` 变成可执行但有界的只读能力。
它只接受数据库中已经存在的 `telemetry_reference_id`，**不接受 URL 或临时查询**。

This module turns the previously passive `query_adapter`, `ui_url_template`,
`auth_reference`, and `capabilities_json` registry fields into a bounded,
read-only capability. It accepts only an existing database
`telemetry_reference_id`; **URLs and ad-hoc queries are not request inputs**.

## Security invariants / 安全不变量

| Invariant / 不变量                           | Enforcement / 实现                                                                                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No locator-driven SSRF / locator 不驱动 SSRF | The API endpoint comes only from `TELEMETRY_BACKEND_CONFIG_JSON`; exact hostnames and HTTPS are checked before every fetch. / API 端点只来自部署配置，每次请求前精确检查 hostname 与 HTTPS。                                   |
| Credentials remain secret / 凭据保持 secret  | D1 stores only an uppercase `auth_reference`; values come from the `TELEMETRY_AUTH_JSON` Worker secret and are used only to build the outbound header. / D1 只存大写符号引用；真实值仅从 Worker secret 取出并用于出站 header。 |
| Bounded work / 工作量有界                    | 3 s default timeout, 512 KiB default body cap, at most 100 normalized records, fixed read-only `GET`, redirects rejected. / 默认 3 秒超时、512 KiB 正文上限、最多 100 条规范化记录、固定只读 `GET`、拒绝重定向。               |
| Finite code paths / 有限代码路径             | Adapter is one of `tempo`, `loki`, `prometheus`, `pyroscope`, `source-commit`, or `artifact-registry`; registry text cannot load code. / adapter 只能来自封闭枚举，注册表文本不能加载代码。                                    |
| Immutable provenance / 不可变来源            | Source locators must match the deployment repository and full commit OID; artifacts must exist for the deployment and content digest. / 源码必须匹配部署仓库与完整 commit OID；产物必须以部署与内容摘要存在。                  |

## Configuration / 配置

`TELEMETRY_BACKEND_CONFIG_JSON` is a non-secret environment variable:

```json
{
  "logs": {
    "endpoint": "https://loki.example.com",
    "allowed_hosts": ["loki.example.com", "grafana.example.com"],
    "auth_scheme": "bearer",
    "timeout_ms": 3000,
    "max_response_bytes": 512000,
    "tenant_id": "production"
  }
}
```

`TELEMETRY_AUTH_JSON` must be installed as a Worker secret. Its keys are the
symbolic D1 `auth_reference` values:

```json
{ "LOKI_QUERY_TOKEN": "<secret value>" }
```

不要把第二段 JSON 写进 `wrangler.jsonc`、日志、RPC 返回值或审计详情。
Do not put the second JSON object in `wrangler.jsonc`, logs, RPC results, or
audit details.

## Vendor API mapping / 供应商 API 映射

查询只接受 Diagnostic SDK 的有限结构化字段；不执行 `query.expression` 或把任意 `profile_id` 当查询语言。编译器总是注入数据库引用上的 `service_name`、`deployment_id`，并拒绝与这些身份冲突的 locator。

Queries accept only the Diagnostic SDK's finite structured fields. Raw `query.expression` and executable `profile_id` fallbacks are unsupported. The compiler always injects the authoritative reference's `service_name` and `deployment_id` and rejects conflicting locator identities.

后端 ingest/relabel 配置必须将 OpenTelemetry 资源身份映射到 `service_name` 和 `deployment_id` 标签；可选字段使用 `environment`、`trace_id`、`span_id`、`severity` 等固定名称（完整映射见 `query.ts`）。上线时用已知 deployment canary 验证查得样本属于相同身份。不要为了“查到数据”移除身份筛选；标签尚未映射时应修复后端配置。

Backend ingest/relabel configuration must map OpenTelemetry resource identity to the `service_name` and `deployment_id` labels. Optional fields use the fixed names in `query.ts`, such as `environment`, `trace_id`, `span_id`, and `severity`. Verify a known-deployment canary before rollout. Fix missing label mappings rather than removing identity filters to obtain results.

The adapters follow the vendor read APIs rather than emulating them:

- Tempo: `GET /api/v2/traces/<traceID>` with optional epoch-second range,
  following the [official Tempo HTTP API](https://grafana.com/docs/tempo/latest/api_docs/).
- Loki: `GET /loki/api/v1/query_range` with `query`, nanosecond `start/end`,
  and `limit=100`, following the [official Loki HTTP API](https://grafana.com/docs/loki/latest/reference/loki-http-api/).
- Prometheus: `GET /api/v1/query_range` with a computed step that requests at
  most about 100 samples per series, following the [official Prometheus HTTP API](https://prometheus.io/docs/prometheus/latest/querying/api/).
- Pyroscope: `GET /pyroscope/render` with `query`, `from`, `until`, JSON format,
  and `maxNodes=100`, following the [official Pyroscope server API](https://grafana.com/docs/pyroscope/latest/reference-server-api/).

供应商响应不会原样返回。适配器只抽取有限的标题、时间与原始标量属性，避免凭据、
巨大嵌套对象或供应商 schema 泄漏进稳定 RPC 契约。Vendor responses are never
passed through: adapters extract only bounded titles, timestamps, and primitive
attributes so credentials, giant nested objects, and vendor schemas cannot leak
into the stable RPC contract.

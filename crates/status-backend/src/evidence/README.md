# Rust evidence queries / Rust 证据查询

`query_telemetry_reference(&Env, Value)` is called only by the private Admin RPC.
`map_reference(&Value)` is the shared fallible D1 row projection for diagnostic graphs.
Both retain the existing JSON field names. No TypeScript dispatcher is used.

`query_telemetry_reference(&Env, Value)` 仅由私有 Admin RPC 调用；
`map_reference(&Value)` 为诊断图提供共享、可失败的 D1 行投影。保留既有 JSON 字段名，不调用 TypeScript dispatcher。

## Invariants / 不变量

- SQL reads use bound registered IDs, never user URLs or ad-hoc expressions. / SQL 使用已注册 ID 的绑定参数，不接受用户 URL 或临时表达式。
- Six fixed adapters: Tempo, Loki, Prometheus, Pyroscope, source commit, artifact registry. / 六种固定适配器，不由数据库加载代码。
- Selector identity always comes from authoritative service/deployment fields. Unknown query keys, conflicting identities and executable profile IDs are unsupported. / 选择器身份永远来自权威 service/deployment，拒绝未知键、身份冲突及可执行 profile ID。
- HTTPS endpoint and exact hostname policy come from `TELEMETRY_BACKEND_CONFIG_JSON`. Credentials come only from `TELEMETRY_AUTH_JSON` secret. / HTTPS 端点和精确主机策略来自部署配置，凭据只来自 secret。
- Redirects are errors. The abort deadline covers both headers and streamed body; byte limit is checked on every chunk. All terminal paths abort transport. / 重定向报错；取消期限覆盖响应头和流式正文，每块检查字节上限，所有终态取消传输。
- Vendor output is reduced to 100 bounded scalar records. Secret-shaped keys and text are scrubbed by Rust. / 供应商输出缩减到最多 100 条有界标量记录，Rust 清理秘密形态键与文本。
- Source links match immutable repository and commit; artifact locators must match registered deployment/digest/kind/build. / 源码链接匹配不可变仓库及 commit，产物匹配部署、摘要、类别及 build。

Native tests cover reference validation, selector injection, normalization bounds, secret redaction and config allowlists.
Actual provider interoperability and production credentials require deployment canaries; native tests do not prove network deployment.
原生测试覆盖引用验证、选择器注入、归一化上限、脱敏和配置许可列表；真实供应商互操作与生产凭据仍须部署 canary 验证，原生测试不等价于网络部署验证。

Platform reference / 平台参考：https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
Vendor protocol reference / 供应商协议参考：[Rust vendor protocols](vendor-protocols.md)。

# Rust private probe executor / Rust 私有探针执行器

The default fetch entrypoint delegates directly to `status_backend::probes::handle`.
默认 fetch 入口直接委托 Rust，不包含 TypeScript 业务桥接。
Build with the repository Rust release pipeline; `build/index.js` is generated SDK glue, never handwritten business logic.
使用仓库 Rust 发布流水线构建；入口 JS 仅是 SDK 生成的绑定胶水。

## Trust and operation / 信任与运维

- No public routes, workers.dev, or preview URLs. Invoke only via declared service bindings.
  无公开路由，仅允许已声明服务绑定调用。
- The caller never sends `cf-placement`. Only platform `local-XXX` or `remote-XXX` supplies actual execution colo. `request.cf.colo`, configured region, and caller labels are not substitutes.
  调用方不设置来源头；仅平台 placement 是实际执行机房证据，禁止配置位置冒充来源。
- The scheduler validates the entire operator registry and matches executor/run/monitor/correlation/time/colo before folding any sample. Transport errors return no sample, never target failures.
  调度器验证注册表与身份、时间、机房；传输错误不是被测服务故障。
- Empty host/port/binding allowlists deliberately fail closed. Declare separate `PROBE_SERVICE_*` bindings and finite RPC operations/synthetic scenarios; synthetic receivers must enforce deadlines, isolate correlation IDs and finish cleanup before returning.
  默认白名单为空；RPC 与合成场景须独立声明有限能力，接收方必须执行截止时间、隔离与清理。

## Safety boundaries / 安全边界

HTTP manually checks each redirect and cancels every response body. DNS uses bounded A/AAAA DoH responses, and rejects mixed public/private answers. TCP connects to a validated IP rather than re-resolving a hostname.
HTTP 每跳重新校验并释放响应体；DNS 同时校验全部 A/AAAA；TCP 固定已验证 IP。

HTTP Workers fetch still performs platform DNS resolution after preflight DoH. This is not cryptographic DNS pinning: only operator-controlled exact hostnames are permitted; do not allow attacker-controlled domains. Cloudflare disallows network-private destinations, but this code does not claim to eliminate the DNS re-resolution race by itself.
HTTP 平台 fetch 会再次解析，预检不是 DNS 固定证明；仅准许运维控制的精确域名，不能允许攻击者域名。此实现不声称单独消除二次解析竞态。

Deadlines bound all I/O waits. Fetch abort, reader cancellation, and socket close guards run when an execution future is dropped. Remote RPC cancellation cannot promise rollback; synthetic receivers own cleanup, and a false cleanup confirmation is a failed probe.
截止时间限制所有等待；取消路径主动释放 fetch、reader 和 socket。远端 RPC 取消不保证回滚，清理由接收方负责。

## Runtime regression checks / 运行时回归

`tests/probes-rust-runtime.test.ts` executes the compiled Rust Wasm against real local workerd HTTP/DNS/RPC fixtures. Keep the manual redirect mode: workerd rejects `redirect: "error"` at Request construction. RPC methods must use `Reflect.apply`, not `Function.call`, because dynamic RPC proxies interpret `.call` as a remote method.
本地 workerd 测试执行实际编译的 Rust；请求必须使用 manual 重定向，RPC 必须以 Reflect.apply 调用，避免把 call 解释为远端方法。

## Evidence / 资料

- [Cloudflare placement](https://developers.cloudflare.com/workers/configuration/placement/)
- [Cloudflare TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [IANA IPv6 special-purpose registry](https://www.iana.org/assignments/iana-ipv6-special-registry/)
- [RPC lifecycle](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/)

Local workerd tests cannot prove geographic placement. Production geographic claims require a private real-platform invocation whose observed colo matches the trusted registry. No deployment has been performed by this migration.
本地测试无法证明真实地理位置；必须以私有真实平台调用证据验证。此次迁移未部署。

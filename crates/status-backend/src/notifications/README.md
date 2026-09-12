# 外部通知 / External notifications

`NOTIFICATIONS_ENABLED` 缺省为 `false`；只有精确的字符串 `true` 才允许外部投递。
其他值是配置错误。关闭不读取通知凭据，不生成假目标，不把跳过当成发送成功。
`NOTIFICATIONS_ENABLED` defaults to `false`; only the exact string `true` enables
external delivery. Other values are configuration errors. Disabled delivery needs
no credentials, fabricates no endpoint, and never reports skipped work as sent.

调度器在领取外部 outbox 前调用 `delivery_enabled`，关闭时保留 D1 中的 pending
事件及尝试次数；内部状态重算不受影响。`publish` 再次检查模式及凭据，防止绕过。
The scheduler calls `delivery_enabled` before claiming external outbox work,
preserving pending D1 events and their attempt counts while disabled. Internal
reevaluations continue. `publish` checks the mode and credentials again.

启用前以 Worker Secrets 配置 `NOTIFICATION_WEBHOOK_URL` 和
`NOTIFICATION_AUTHORIZATION`，再设置 `NOTIFICATIONS_ENABLED=true` 并启用消费者。
HTTPS 目标和凭据均须通过验证；凭据不应进入普通变量或源码。
Before enabling the consumer and setting `NOTIFICATIONS_ENABLED=true`, install
`NOTIFICATION_WEBHOOK_URL` and `NOTIFICATION_AUTHORIZATION` as Worker Secrets.
Both the HTTPS destination and authorization must validate; never put credentials
in ordinary variables or source code.

关闭时不应开启通知消费者。若已有消息进入消费者，禁止调用 webhook；沿用有限重试
和持久 DLQ 后确认机制，失败原因是 `notification-delivery-disabled`，不是投递成功。
Queue 有保留期限，不能代替停发期间的 D1 持久 pending 存储。
Keep notification consumers disabled while delivery is disabled. Already queued
messages must not reach the webhook; bounded retries and durable DLQ acceptance
retain their failure semantics as `notification-delivery-disabled`, not successful
delivery. Queue retention is finite and cannot replace pending D1 storage.

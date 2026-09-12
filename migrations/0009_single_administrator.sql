-- 会话仅存随机令牌摘要，密码记录只存在 Worker secret。
-- Sessions store random-token digests only; the password record lives exclusively in a Worker secret.
CREATE TABLE administrator_sessions (
 token_hash TEXT PRIMARY KEY,
 record_fingerprint TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at > created_at)
) STRICT;
CREATE INDEX administrator_sessions_expiry ON administrator_sessions(expires_at);
-- 全局预算不能通过轮换 IP 绕过。 / Global budget cannot be bypassed by rotating IPs.
CREATE TABLE administrator_login_budget (
 singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
 window_start INTEGER NOT NULL,
 attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 30)
) STRICT;
INSERT INTO administrator_login_budget VALUES(1,0,0);

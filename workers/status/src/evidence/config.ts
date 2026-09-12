import { z } from "zod";

import type { EvidenceBackendConfig } from "./types.js";

const HostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  );

const BackendConfigSchema = z
  .strictObject({
    endpoint: z.url({ protocol: /^https$/ }).max(2048),
    allowed_hosts: z.array(HostSchema).min(1).max(16),
    auth_scheme: z.enum(["bearer", "basic", "none"]).default("bearer"),
    timeout_ms: z.number().int().min(100).max(10_000).default(3_000),
    max_response_bytes: z
      .number()
      .int()
      .min(1_024)
      .max(2_000_000)
      .default(512_000),
    tenant_id: z.string().min(1).max(128).optional(),
  })
  .superRefine((value, context) => {
    const endpoint = new URL(value.endpoint);
    if (!value.allowed_hosts.includes(endpoint.hostname.toLowerCase())) {
      context.addIssue({
        code: "custom",
        path: ["allowed_hosts"],
        message: "endpoint hostname must be explicitly allowlisted",
      });
    }
  });

const ConfigMapSchema = z.record(
  z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
  BackendConfigSchema,
);

/** 解析按注册名索引的非 secret 后端配置 / Parse non-secret backend configuration indexed by registry name. */
export function parseBackendConfigs(
  raw: string | undefined,
): Readonly<Record<string, EvidenceBackendConfig>> {
  if (raw === undefined || raw.length > 256_000) return {};
  try {
    return ConfigMapSchema.parse(JSON.parse(raw)) as Readonly<
      Record<string, EvidenceBackendConfig>
    >;
  } catch {
    return {};
  }
}

/** 解析 secret 引用表；值永不写入结果或日志 / Parse the secret reference table; values never enter results or logs. */
export function parseTelemetrySecrets(
  raw: string | undefined,
): Readonly<Record<string, string>> {
  if (raw === undefined || raw.length > 256_000) return {};
  try {
    return z
      .record(
        z.string().regex(/^[A-Z][A-Z0-9_]*$/),
        z.string().min(1).max(16_384),
      )
      .parse(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** 要求 HTTPS 且 hostname 精确命中配置 allowlist / Require HTTPS and an exact configured hostname allowlist match. */
export function requireAllowedHttpsUrl(
  raw: string,
  allowedHosts: readonly string[],
): URL {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    !allowedHosts.includes(url.hostname.toLowerCase())
  )
    throw new Error("URL is outside the configured HTTPS host allowlist");
  return url;
}

/** 旧调用点的明确别名 / Explicit alias for earlier callers. */
export const parseAuthReferences = parseTelemetrySecrets;

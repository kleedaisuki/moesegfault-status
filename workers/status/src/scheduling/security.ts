/** 目标安全策略。 / Target safety policy. */
export interface TargetPolicy {
  /** 允许的精确、规范化公网主机名。 / Exact normalized public hostnames allowed for probes. */
  readonly allowedHostnames: ReadonlySet<string>;
  /** TCP 允许端口；HTTP 始终仅允许 80/443。 / Allowed TCP ports; HTTP is always restricted to 80/443. */
  readonly allowedTcpPorts: ReadonlySet<number>;
}

/** DNS 解析器；调用方必须返回本次查询的全部地址。 / DNS resolver that returns every address observed for this lookup. */
export interface AddressResolver {
  /** 解析 A/AAAA，并遵守取消信号。 / Resolve A/AAAA records while honoring cancellation. */
  resolve(
    hostname: string,
    signal: AbortSignal,
    recordType?: "A" | "AAAA",
  ): Promise<readonly string[]>;
}

const IPV4_DENY: readonly [number, number][] = [
  [0x00000000, 0xff000000],
  [0x0a000000, 0xff000000],
  [0x64400000, 0xffc00000],
  [0x7f000000, 0xff000000],
  [0xa9fe0000, 0xffff0000],
  [0xac100000, 0xfff00000],
  [0xc0000000, 0xffffff00],
  [0xc0000200, 0xffffff00],
  [0xc0a80000, 0xffff0000],
  [0xc6120000, 0xfffe0000],
  [0xc6336400, 0xffffff00],
  [0xcb007100, 0xffffff00],
  [0xe0000000, 0xf0000000],
  [0xf0000000, 0xf0000000],
];

/** 规范化主机名；拒绝本地名称和模糊尾点。 / Normalize a hostname while rejecting local names and ambiguous trailing dots. */
export function normalizeHostname(value: string): string {
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa")
  ) {
    throw new TargetSecurityError("local_hostname");
  }
  if (
    !host ||
    host.length > 253 ||
    host.includes("%") ||
    host.includes("/") ||
    host.includes("\\")
  ) {
    throw new TargetSecurityError("invalid_hostname");
  }
  return host;
}

/** 判断地址是否属于可公开路由范围。 / Return whether an address is globally routable enough for an external probe. */
export function isPublicAddress(address: string): boolean {
  const ipv4 = parseIpv4(address);
  if (ipv4 !== null)
    return !IPV4_DENY.some(
      ([network, mask]) => (ipv4 & mask) >>> 0 === network >>> 0,
    );
  const ipv6 = parseIpv6(address);
  if (ipv6 === null) return false;
  return !(
    inV6(ipv6, 0n, 128) ||
    inV6(ipv6, 1n, 128) ||
    inV6(ipv6, 0n, 96) ||
    inV6(ipv6, 0xffffn << 32n, 96) ||
    inV6(ipv6, 0x0064ff9bn << 96n, 96) ||
    inV6(ipv6, 0x0100n << 112n, 64) ||
    inV6(ipv6, 0xfc00n << 112n, 7) ||
    inV6(ipv6, 0xfe80n << 112n, 10) ||
    inV6(ipv6, 0xff00n << 112n, 8) ||
    inV6(ipv6, 0x20010db8n << 96n, 32) ||
    inV6(ipv6, 0x20010002n << 96n, 48) ||
    inV6(ipv6, 0x20010010n << 96n, 28) ||
    inV6(ipv6, 0x2002n << 112n, 16)
  );
}

/** 校验精确 allowlist 与解析结果；空 DNS 结果也失败。 / Enforce the exact allowlist and resolved-address policy; empty DNS results fail too. */
export async function assertSafeHostname(
  hostname: string,
  policy: TargetPolicy,
  resolver: AddressResolver,
  signal: AbortSignal,
): Promise<string> {
  const host = normalizeHostname(hostname);
  if (!policy.allowedHostnames.has(host))
    throw new TargetSecurityError("hostname_not_allowed");
  const literal = parseLiteral(host);
  const addresses =
    literal === null ? await resolver.resolve(host, signal) : [literal];
  if (addresses.length === 0) throw new TargetSecurityError("dns_no_address");
  if (addresses.some((address) => !isPublicAddress(address)))
    throw new TargetSecurityError("private_or_reserved_address");
  return host;
}

/** 校验 HTTP URL，禁止凭据、非标准端口与非 HTTP(S) 协议。 / Validate an HTTP URL, rejecting credentials, nonstandard ports, and other schemes. */
export async function assertSafeHttpUrl(
  value: string,
  policy: TargetPolicy,
  resolver: AddressResolver,
  signal: AbortSignal,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TargetSecurityError("invalid_url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new TargetSecurityError("invalid_scheme");
  if (url.username || url.password)
    throw new TargetSecurityError("url_credentials");
  const effectivePort = url.port
    ? Number(url.port)
    : url.protocol === "https:"
      ? 443
      : 80;
  if (effectivePort !== 80 && effectivePort !== 443)
    throw new TargetSecurityError("http_port_not_allowed");
  await assertSafeHostname(
    stripIpv6Brackets(url.hostname),
    policy,
    resolver,
    signal,
  );
  return url;
}

/** 校验 TCP 目标。 / Validate a TCP target. */
export async function assertSafeTcpTarget(
  hostname: string,
  port: number,
  policy: TargetPolicy,
  resolver: AddressResolver,
  signal: AbortSignal,
): Promise<{ hostname: string; port: number }> {
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !policy.allowedTcpPorts.has(port)
  ) {
    throw new TargetSecurityError("tcp_port_not_allowed");
  }
  return {
    hostname: await assertSafeHostname(
      stripIpv6Brackets(hostname),
      policy,
      resolver,
      signal,
    ),
    port,
  };
}

/** 安全拒绝类型，仅暴露稳定分类而不泄漏目标。 / Safe rejection carrying only a stable category, never the target. */
export class TargetSecurityError extends Error {
  /** 稳定、低基数的错误类型。 / Stable low-cardinality error type. */
  readonly code: string;

  constructor(code: string) {
    super("Probe target rejected by policy");
    this.name = "TargetSecurityError";
    this.code = code;
  }
}

function parseLiteral(host: string): string | null {
  return parseIpv4(host) !== null || parseIpv6(host) !== null ? host : null;
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function parseIpv4(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = result * 256 + octet;
  }
  return result >>> 0;
}

function parseIpv6(value: string): bigint | null {
  let source = value.toLowerCase();
  if (source.includes(".")) {
    const index = source.lastIndexOf(":");
    const v4 = parseIpv4(source.slice(index + 1));
    if (index < 0 || v4 === null) return null;
    source = `${source.slice(0, index)}:${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < (halves.length === 2 ? 1 : 0)) return null;
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))
  )
    return null;
  return groups.reduce(
    (result, group) => (result << 16n) | BigInt(`0x${group}`),
    0n,
  );
}

function inV6(address: bigint, network: bigint, prefix: number): boolean {
  const shift = BigInt(128 - prefix);
  return address >> shift === network >> shift;
}

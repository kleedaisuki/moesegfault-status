/** 可由组合根统一映射成 RFC 9457 的领域错误 / Domain error mapped to RFC 9457 by the composition root. */
export class DeploymentProblem extends Error {
  public constructor(
    public readonly status: number,
    public readonly type: string,
    public readonly title: string,
    detail: string,
  ) {
    super(detail);
    this.name = "DeploymentProblem";
  }
}

/** 抛出稳定的问题类型，避免持久层错误文本泄漏 / Throw a stable problem type without leaking persistence errors. */
export function problem(
  status: number,
  slug: string,
  title: string,
  detail: string,
): never {
  throw new DeploymentProblem(
    status,
    `https://status.moesegfault.dev/problems/${slug}`,
    title,
    detail,
  );
}

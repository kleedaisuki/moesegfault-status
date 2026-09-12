import { describe, expect, it } from "vitest";
import { nextStandardCron } from "./schedule.js";

describe("UTC cron planning", () => {
  it("uses Cloudflare weekday numbering where 1 is Sunday", () => {
    const saturday = Date.parse("2026-09-12T00:00:00.000Z");
    expect(
      new Date(nextStandardCron("0 0 * * 1", saturday)).toISOString(),
    ).toBe("2026-09-13T00:00:00.000Z");
    expect(
      new Date(nextStandardCron("0 0 * * sun", saturday)).toISOString(),
    ).toBe("2026-09-13T00:00:00.000Z");
  });

  it("rejects unsupported Quartz extensions instead of silently mis-scheduling", () => {
    expect(() => nextStandardCron("0 0 LW * *", Date.now())).toThrow(
      "unsupported_cron_extension",
    );
  });
});

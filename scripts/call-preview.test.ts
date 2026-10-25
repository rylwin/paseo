import { describe, expect, it } from "vitest";
import {
  admitUpgrade,
  validateTool,
  authenticate,
  authenticateStart,
  readMarker,
} from "./call-preview.mjs";

describe("scoped token and timeline", () => {
  it("rejects malformed start envelopes without crashing the preview", () => {
    expect(authenticateStart(null, "a".repeat(64))).toBe(false);
    expect(authenticateStart("start", "a".repeat(64))).toBe(false);
    expect(authenticateStart({ type: "start", token: "a".repeat(64) }, "a".repeat(64))).toBe(true);
  });
  it("rejects absent, malformed and incorrect tokens", () => {
    expect(authenticate("a".repeat(64), "a".repeat(64))).toBe(true);
    expect(authenticate(undefined, "a".repeat(64))).toBe(false);
    expect(authenticate("b".repeat(64), "a".repeat(64))).toBe(false);
    expect(authenticate({}, "a".repeat(64))).toBe(false);
    expect(authenticate("é".repeat(64), "a".repeat(64))).toBe(false);
  });
  it("requires a fresh exact answer line rather than the echoed instruction", () => {
    expect(
      readMarker("Reply exactly PI_CONTROL_OK_123.\nPI_CONTROL_OK_old\n", "PI_CONTROL_OK_123"),
    ).toBe(false);
    expect(
      readMarker("Reply exactly PI_CONTROL_OK_123.\nPI_CONTROL_OK_123\n", "PI_CONTROL_OK_123"),
    ).toBe(true);
  });
});

describe("restricted tool", () => {
  it("accepts only an empty-argument marker operation", () => {
    expect(validateTool("paseo_pi_marker", {})).toBe(true);
    expect(validateTool("paseo_pi_marker", { prompt: "delete files" })).toBe(false);
    expect(validateTool("shell", {})).toBe(false);
    expect(validateTool("paseo_pi_marker", null)).toBe(false);
  });
});

describe("call preview admission", () => {
  it("accepts only the configured host and exact browser origin", () => {
    const origin = "https://titanium.tail75866.ts.net:8443";
    expect(admitUpgrade({ host: "titanium.tail75866.ts.net:8443", origin }, [origin])).toBe(true);
    expect(admitUpgrade({ host: "evil.test", origin }, [origin])).toBe(false);
    expect(
      admitUpgrade({ host: "titanium.tail75866.ts.net:8443", origin: "https://evil.test" }, [
        origin,
      ]),
    ).toBe(false);
    expect(admitUpgrade({ host: "titanium.tail75866.ts.net:8443" }, [origin])).toBe(false);
  });
});

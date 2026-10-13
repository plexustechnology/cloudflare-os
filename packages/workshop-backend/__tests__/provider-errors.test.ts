import { describe, expect, it } from "vitest";
import { classifyPersonalProviderFailure } from "../src/provider-errors.js";

describe("personal inference error presentation and incident classification", () => {
  it("treats policy, authentication, quota and cancellation as expected without upstream status", () => {
    for (const code of ["connection_required", "reconnect_required", "connection_forbidden", "model_unavailable", "usage_limit",
      "rate_limited", "invalid_request", "unsupported_feature", "adapter_disabled", "cancelled"]) {
      const failure = classifyPersonalProviderFailure(new Error(code));
      expect(failure.expected).toBe(true);
      expect(failure.error.message).toBe(code);
      expect(failure.message).not.toBe(code);
      expect(failure.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(classifyPersonalProviderFailure(new Error("connection_forbidden")).message).toContain("Paid context summaries");
    expect(classifyPersonalProviderFailure(new Error("usage_limit")).message).toContain("cannot accept another request");
    expect(classifyPersonalProviderFailure(new Error("rate_limited")).message).toContain("rate or usage limit");
  });

  it("retains a bounded observed failure status and discards raw unknown diagnostics and causes", () => {
    const caught = new Error("PRIVATE_PROVIDER_BODY", { cause: new Error("PRIVATE_CREDENTIAL") });
    const failure = classifyPersonalProviderFailure(caught, 504);
    expect(failure).toMatchObject({ code: "provider_unavailable", expected: false, statusCode: 504 });
    expect(failure.error).not.toHaveProperty("cause");
    expect(JSON.stringify(failure)).not.toContain("PRIVATE");
    expect(failure.error.stack).not.toContain("PRIVATE");
    expect(classifyPersonalProviderFailure(caught, Infinity).statusCode).toBe(503);
    expect(classifyPersonalProviderFailure(new Error("stream_incomplete"), 200)).toMatchObject({ expected: false, statusCode: 502 });
  });

  it("uses actual caller cancellation without inspecting an arbitrary abort reason", () => {
    expect(classifyPersonalProviderFailure(new Error("PRIVATE_ABORT_REASON"), undefined, true))
      .toMatchObject({ code: "cancelled", expected: true, statusCode: 499 });
  });
});

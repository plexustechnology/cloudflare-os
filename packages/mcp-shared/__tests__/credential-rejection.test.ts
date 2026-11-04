import { describe, expect, it } from "vitest";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/client";

import { isCredentialRejection, oauthRefreshDiagnostic, revokeToken, safeOAuthError } from "../src/oauth.js";
import { safeServerText } from "../src/util.js";

describe("isCredentialRejection", () => {
  it.each([
    OAuthErrorCode.InvalidGrant,
    OAuthErrorCode.InvalidClient,
    OAuthErrorCode.UnauthorizedClient,
    OAuthErrorCode.InvalidScope,
    "interaction_required" as OAuthErrorCode,
    "login_required" as OAuthErrorCode,
    "consent_required" as OAuthErrorCode,
  ])("treats the authorization server's %s verdict as final", code => {
    expect(isCredentialRejection(new OAuthError(code, "credential rejected"))).toBe(true);
  });

  it("keeps outages and unknown failures transient", () => {
    expect(isCredentialRejection(
      new OAuthError(OAuthErrorCode.TemporarilyUnavailable, "try later"))).toBe(false);
    expect(isCredentialRejection(new Error("network error"))).toBe(false);
    expect(isCredentialRejection(new OAuthError("invalid_resource" as OAuthErrorCode, "request rejected"))).toBe(false);
    expect(isCredentialRejection(new OAuthError("PRIVATE_UNKNOWN_CODE" as OAuthErrorCode, "unknown"))).toBe(false);
    expect(isCredentialRejection(Object.assign(new Error("interaction_required"), {
      code: "interaction_required", name: "OAuthError",
    }))).toBe(false);
  });
});

describe("oauthRefreshDiagnostic", () => {
  const privateText = "PRIVATE-REFRESH-TOKEN-user@example.com";

  it.each([
    "invalid_request", "invalid_grant", "invalid_client", "unauthorized_client", "invalid_scope",
    "invalid_target", "invalid_resource", "access_denied", "interaction_required", "login_required",
    "consent_required", "temporarily_unavailable", "server_error", "too_many_requests",
  ])("returns only the allowlisted OAuth code %s", code => {
    const error = Object.assign(new OAuthError(code as OAuthErrorCode, privateText, `https://example.com/${privateText}`), {
      cause: new Error(privateText), body: privateText,
    });
    const diagnostic = oauthRefreshDiagnostic("token-response", 400, error);
    expect(diagnostic).toBe(`[MCP_OAUTH_REFRESH stage=token-response http=4xx oauth=${code}]`);
    expect(diagnostic).not.toMatch(/PRIVATE|example\.com|https:|REFRESH-TOKEN/);
  });

  it.each([
    "connection-policy", "token-setup", "token-request", "token-response", "token-policy",
  ] as const)("retains the source-owned stage %s without inspecting error content", stage => {
    const error = new Error(`stage=token-response oauth=invalid_grant ${privateText}`, {
      cause: new OAuthError(OAuthErrorCode.InvalidGrant, privateText),
    });
    expect(oauthRefreshDiagnostic(stage, undefined, error))
      .toBe(`[MCP_OAUTH_REFRESH stage=${stage} http=none oauth=unknown]`);
  });

  it.each([
    { status: undefined, category: "none" }, { status: 0, category: "other" },
    { status: 199, category: "other" }, { status: 200, category: "2xx" }, { status: 299, category: "2xx" },
    { status: 300, category: "3xx" }, { status: 399, category: "3xx" },
    { status: 400, category: "4xx" }, { status: 499, category: "4xx" },
    { status: 500, category: "5xx" }, { status: 599, category: "5xx" }, { status: 600, category: "other" },
    { status: -1, category: "other" }, { status: Number.NaN, category: "other" },
    { status: Number.POSITIVE_INFINITY, category: "other" }, { status: 200.5, category: "other" },
  ])("classifies only the supplied HTTP status $status as $category", ({ status, category }) => {
    const error = Object.assign(new Error(`HTTP 401 ${privateText}`), { status: 401 });
    expect(oauthRefreshDiagnostic("token-response", status, error))
      .toBe(`[MCP_OAUTH_REFRESH stage=token-response http=${category} oauth=unknown]`);
  });

  it("does not expose unknown OAuth codes or infer codes from descriptions", () => {
    for (const code of [privateText, "INVALID_GRANT", "invalid_grant extra", "invalid_grant\n", ""]) {
      const error = new OAuthError(code as OAuthErrorCode, `invalid_grant ${privateText}`);
      expect(oauthRefreshDiagnostic("token-response", 400, error))
        .toBe("[MCP_OAUTH_REFRESH stage=token-response http=4xx oauth=unknown]");
    }
  });

  it("ignores plain objects and forged Error properties instead of reporting their claimed code", () => {
    const forged = { name: "OAuthError", code: "invalid_grant", message: privateText,
      errorUri: `https://example.com/${privateText}`, cause: new OAuthError(OAuthErrorCode.InvalidGrant, privateText) };
    for (const error of [forged, Object.assign(new Error(privateText), forged), privateText, null, undefined]) {
      expect(oauthRefreshDiagnostic("token-request", undefined, error))
        .toBe("[MCP_OAUTH_REFRESH stage=token-request http=none oauth=unknown]");
    }
  });
});

describe("safeServerText", () => {
  it("flattens and caps server-written text", () => {
    expect(safeServerText("denied\nERROR fake entry")).toBe("denied ERROR fake entry");
    expect(safeServerText("x".repeat(10_000))!.length).toBeLessThan(250);
  });
});

describe("safeOAuthError", () => {
  it("redacts submitted secrets before capping server text", () => {
    const refreshToken = `rt-${"s".repeat(60)}`;
    const err = safeOAuthError(
      new Error(`${"context-".repeat(20)}refresh_token=${encodeURIComponent(refreshToken)}`),
      [refreshToken],
    );
    expect(err.message).not.toContain(refreshToken);
    expect(err.message).not.toContain(refreshToken.slice(0, 24));
    expect(err.message).toContain("[redacted]");
  });

  it("redacts a confidential client's secret and Basic credential", () => {
    const client = {
      client_id: "client:name",
      client_secret: "cs/secret+0123456789",
    };
    const basic = btoa(`${client.client_id}:${client.client_secret}`);
    const err = safeOAuthError(
      new Error(`invalid Authorization header: Basic ${basic}`), [], client);
    expect(err.message).not.toContain(basic);
    expect(err.message).not.toContain(client.client_secret);
    expect(err.message).toContain("Basic [redacted]");
  });

  it("keeps a useful explanation that quotes no secret", () => {
    expect(safeOAuthError(new Error("The grant has expired.")).message)
      .toContain("The grant has expired.");
  });
});

describe("revokeToken", () => {
  it("uses public-client authentication and reports rejection", async () => {
    let request: RequestInit | undefined;
    const discovery = {
      authorizationServerMetadata: { revocation_endpoint: "https://auth.example/revoke" },
    } as never;
    const client = { client_id: "client-id", client_secret: "must-not-send" } as never;

    await revokeToken(discovery, client, "refresh-token", "refresh_token", async (_url, init) => {
      request = init;
      return new Response(null, { status: 200 });
    });

    expect(new Headers(request?.headers).has("Authorization")).toBe(false);
    expect(String(request?.body)).toBe(
      "token=refresh-token&token_type_hint=refresh_token&client_id=client-id");
    await expect(revokeToken(discovery, client, "refresh-token", "refresh_token",
      async () => new Response(null, { status: 400 }))).rejects.toThrow(/HTTP 400/);
  });
});

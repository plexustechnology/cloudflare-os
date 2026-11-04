import {
  OAuthError,
  type FetchLike,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";

import { redactSecrets, safeServerText } from "./util.js";

/** SDK tokens plus the absolute expiry used by the account's hot path. */
export type OAuthTokens = StoredOAuthTokens & { expiresAt?: number };

const CREDENTIAL_REJECTIONS = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "invalid_scope",
  "interaction_required",
  "login_required",
  "consent_required",
]);

/** Fixed stages tracked locally while renewing an OAuth grant. */
export type OAuthRefreshStage = "connection-policy" | "token-setup" | "token-request" | "token-response" | "token-policy";

/** Only source-owned categories enter refresh diagnostics; provider text and unknown codes are discarded. */
export function oauthRefreshDiagnostic(stage: OAuthRefreshStage, status: number | undefined, error: unknown): string {
  const http = status === undefined ? "none" : !Number.isInteger(status) ? "other" : status >= 200 && status < 300 ? "2xx"
    : status >= 300 && status < 400 ? "3xx" : status >= 400 && status < 500 ? "4xx"
    : status >= 500 && status < 600 ? "5xx" : "other";
  let code = "unknown";
  if (OAuthError.isInstance(error)) {
    switch (error.code) {
      case "invalid_request": case "invalid_grant": case "invalid_client": case "unauthorized_client":
      case "invalid_scope": case "invalid_target": case "invalid_resource": case "access_denied":
      case "interaction_required": case "login_required": case "consent_required":
      case "temporarily_unavailable": case "server_error": case "too_many_requests":
        code = error.code;
    }
  }
  return `[MCP_OAUTH_REFRESH stage=${stage} http=${http} oauth=${code}]`;
}

/** Credential rejection or an explicit interactive-sign-in requirement retires a grant; outages remain retryable. */
export function isCredentialRejection(err: unknown): boolean {
  return OAuthError.isInstance(err) && CREDENTIAL_REJECTIONS.has(String(err.code));
}

/** SDK errors may quote a rejected request. Scrub submitted credentials before logging or display. */
export function safeOAuthError(
  err: unknown,
  secrets: readonly (string | null | undefined)[] = [],
  client?: StoredOAuthClientInformation,
): Error {
  const text = err instanceof Error ? err.message : String(err);
  const basic = client?.client_secret
    ? btoa(`${client.client_id}:${client.client_secret}`)
    : undefined;
  const encodedBasic = client?.client_secret
    ? btoa(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`)
    : undefined;
  const detail = safeServerText(redactSecrets(
    text, [...secrets, client?.client_secret, basic, encodedBasic]));
  return new Error(detail ?? "The authorization server refused the request.");
}

/** Best-effort RFC 7009 revocation; the SDK does not expose a revocation helper. */
export async function revokeToken(
  discovery: OAuthDiscoveryState,
  client: StoredOAuthClientInformation,
  token: string,
  tokenTypeHint: "access_token" | "refresh_token",
  fetchFn: FetchLike,
): Promise<void> {
  const metadata = discovery.authorizationServerMetadata;
  const endpoint = metadata && "revocation_endpoint" in metadata &&
    typeof metadata.revocation_endpoint === "string" ? metadata.revocation_endpoint : undefined;
  if (!endpoint) return;
  const body = new URLSearchParams({
    token,
    token_type_hint: tokenTypeHint,
    client_id: client.client_id,
  });
  const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
  // The account registers as a public client with token_endpoint_auth_method "none".
  const response = await fetchFn(endpoint, { method: "POST", headers, body });
  if (!response.ok) throw new Error(`Token revocation failed with HTTP ${response.status}.`);
}

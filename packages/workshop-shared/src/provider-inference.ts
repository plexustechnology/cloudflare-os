/** Fixed private service endpoint; no identity or credential appears in its URL. */
export const PROVIDER_INFERENCE_URL = "https://provider-adapter.internal/internal/v1/inference";
/** Fixed request-scoped cancellation endpoint, independent of the inference signal. */
export const PROVIDER_INFERENCE_CANCEL_URL = "https://provider-adapter.internal/internal/v1/inference/cancel";
/** Maximum lifetime of one backend-created inference admission. */
export const PROVIDER_INFERENCE_MAX_LIFETIME_MS = 180000;
/** Overall local grace for cancellation acknowledgement and reader cleanup. */
export const PROVIDER_INFERENCE_CLEANUP_GRACE_MS = 1000;
/** Required success-response marker for the selected native Responses protocol. */
export const PROVIDER_INFERENCE_PROTOCOL = "responses-v1";
/** Local planning budget, not a provider capability or entitlement claim. */
export const PROVIDER_CONNECTION_PLANNING_WINDOW = 32768;
/** Local response reservation enforced for the initial personal route. */
export const PROVIDER_CONNECTION_OUTPUT_LIMIT = 4096;

/** Owner-approved purposes; background and gadget inference have no personal authority. */
export type ProviderInferencePurpose = "ownerInteractive" | "approvalResume" | "sessionCompaction";

/** Backend-created owner session identity, never a browser authorization claim. */
export interface ProviderInferenceSession {
  /** Actual 64-hex Overseer Durable Object identity. */
  workspaceId: string;
  /** Nonnegative safe chat identifier within the workspace. */
  chatId: number;
  /** Server-created UUID4 retained across approved owner continuations. */
  turnId: string;
}

/** Exact private request; the credential Worker validates its unknown native payload. */
export interface ProviderInferenceRequest {
  /** Version of this private envelope. */
  version: 1;
  /** Fresh backend UUID4 for one inference; never proof of billing idempotency. */
  requestId: string;
  /** Captured positive safe Unix milliseconds; admission and cancellation share this expiry. */
  expiresAt: number;
  /** Actual connection-owning UserDO identity. */
  ownerId: string;
  /** Actual authenticated or persisted initiating UserDO identity. */
  requesterUserId: string;
  /** Actual persisted workspace owner's UserDO identity. */
  workspaceOwnerId: string;
  /** Owner-indexed opaque connection identifier. */
  connectionId: string;
  /** Authority generation captured by explicit model selection. */
  generation: number;
  /** Fixed initial native transport. */
  transport: "openai-api-responses";
  /** Explicit initial funding mode. */
  billing: "openai-platform-api";
  /** Deployment-allowlisted provider model slug. */
  model: string;
  /** Authorized owner session purpose. */
  purpose: ProviderInferencePurpose;
  /** Scoped backend session, containing no provider conversation authority. */
  session: ProviderInferenceSession;
  /** Pinned Pi native Responses body; runtime validated before upstream I/O. */
  payload: unknown;
}

/** Fixed safe inference categories; raw provider diagnostics never cross the boundary. */
export type ProviderInferenceErrorCode = "connection_required" | "reconnect_required" |
  "connection_forbidden" | "model_unavailable" | "usage_limit" | "rate_limited" |
  "provider_unavailable" | "invalid_request" | "unsupported_feature" | "stream_incomplete" |
  "cancelled" | "adapter_disabled";

/** Original request authority only; cancellation cannot grant purposes or target later work. */
export type ProviderInferenceCancelRequest = Pick<ProviderInferenceRequest,
  "version" | "requestId" | "ownerId" | "requesterUserId" | "workspaceOwnerId" |
  "connectionId" | "generation" | "expiresAt">;

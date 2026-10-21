import type { RpcTarget } from "capnweb";
import type { AiChatAuthorInfo } from "./api.js";
import type { ProviderConnectionConsent, ProviderConnectionDescriptor, ProviderConnectionCatalog, ProviderSubscriptionDescriptor, ProviderSubscriptionConsent } from "./provider-connections.js";

/** Protected write-only credential intake for the initial OpenAI Platform API profile. */
export interface ProviderConnectionInput {
  /** Trimmed display label of 1 to 80 characters, without control characters. */
  label: string;
  /** Write-only API key: 1 to 4096 visible ASCII characters, never returned or persisted here. */
  apiKey: string;
  /** Explicit funding and permitted owner purposes. */
  consent: ProviderConnectionConsent;
}

/** Owner-scoped connection controls; holding an identifier alone grants no authority. */
export interface ProviderConnectionsApi extends RpcTarget {
  /** Lists the owner's bounded connection index, including recoverable reservations. */
  list(): Promise<ProviderConnectionDescriptor[]>;
  /** Reserves a credential-free identifier before protected key intake or cancellation. */
  reserve(input: Pick<ProviderConnectionInput, "label" | "consent">): Promise<ProviderConnectionDescriptor>;
  /** Adds a server-constructed model after owner, generation, policy and fresh catalog checks. */
  selectModel(connectionId: string, expectedGeneration: number, model: string): Promise<AiChatAuthorInfo>;
  /** Reserves an opaque identifier before submitting a write-only credential. */
  create(input: ProviderConnectionInput): Promise<ProviderConnectionDescriptor>;
  /**
   * Replaces credentials only when the owner-selected generation matches. Generation zero explicitly
   * recovers a pending reservation only after the adapter confirms no credential record exists.
   */
  reconnect(connectionId: string, expectedGeneration: number, input: ProviderConnectionInput): Promise<ProviderConnectionDescriptor>;
  /** Returns sanitized local status; configured credentials do not prove live readiness. */
  status(connectionId: string): Promise<ProviderConnectionDescriptor>;
  /** Discovers bounded allowlisted model identities; catalog presence does not prove readiness. */
  discover(connectionId: string): Promise<ProviderConnectionCatalog>;
  /** Invalidates local authority; API-key remote revocation is not supported by this profile. */
  disconnect(connectionId: string): Promise<ProviderConnectionDescriptor>;
}

/** Credential-free consent captured by an authenticated owner capability. */
export interface ProviderSubscriptionInput {
  /** Trimmed label of 1 to 80 characters. */
  label: string;
  /** Explicit ChatGPT funding and purpose acknowledgments. */
  consent: ProviderSubscriptionConsent;
}

/** Public setup for a callback-only helper, containing no verifier or credential. */
export interface ProviderSubscriptionHandoff {
  /** Server-generated correlation. */
  attemptId: string;
  /** Fixed provider authorization URL with public PKCE challenge. */
  authorizationUrl: string;
  /** Original intent deadline in Unix milliseconds. */
  expiresAt: number;
  /** Canonical base64url SPKI for this attempt's RSA receiver. */
  receiver: string;
}

/** Explicit result of this exact sign-in, independent of metadata changed by another tab. */
export interface ProviderSubscriptionCompletion {
  /** Whether this callback saved authorization or the owner declined consent. */
  outcome: "saved" | "denied";
  /** Current sanitized state; a denied callback may retain a previously saved grant. */
  connection: ProviderSubscriptionDescriptor;
}

/** One-shot owner intent; dispose when finished, and inspect status after uncertain outcomes. */
export interface ProviderSubscriptionAttempt extends RpcTarget {
  /** Admit once using the exact already-listening loopback port. */
  begin(callbackPort: number): Promise<ProviderSubscriptionHandoff>;
  /** Submit one opaque encrypted capsule; never accepts plaintext callback fields. */
  complete(sealedCapsule: string): Promise<ProviderSubscriptionCompletion>;
  /** Fence this exact intent without deleting a newer or completed grant. */
  cancel(): Promise<ProviderSubscriptionDescriptor>;
}

/** Current scoped catalog and matching sanitized credential revision. */
export interface ProviderSubscriptionDiscovery {
  /** Current captured subscription authority. */
  connection: ProviderSubscriptionDescriptor;
  /** Bounded choices; presence never proves eligibility. */
  catalog: ProviderConnectionCatalog;
}

/** Explicit model selection with owner-scoped presentation bookkeeping. */
export interface ProviderSubscriptionSelection {
  /** Server-minted token-free model profile. */
  profile: AiChatAuthorInfo;
  /** True once when the owner is offered the plan welcome. */
  showPlanWelcome: boolean;
}

/** Authenticated subscription management, distinct from API billing and inference controls. */
export interface ProviderSubscriptionConnectionsApi extends RpcTarget {
  /** Discover current grant-scoped choices without inference or automatic model selection. */
  discover(connectionId: string): Promise<ProviderSubscriptionDiscovery>;
  /** Explicitly select a choice under the exact current generation and credential revision. */
  selectModel(connectionId: string, expectedGeneration: number, expectedCredentialRevision: number, model: string): Promise<ProviderSubscriptionSelection>;
  /** List this owner's bounded subscription slots. */
  list(): Promise<ProviderSubscriptionDescriptor[]>;
  /** Reserve credential-free identity before helper setup. */
  reserve(input: ProviderSubscriptionInput): Promise<ProviderSubscriptionDescriptor>;
  /** Validate current authority and mint a five-minute intent without starting OAuth. */
  prepare(connectionId: string, expectedGeneration: number, input: ProviderSubscriptionInput): Promise<import("capnweb").RpcStub<ProviderSubscriptionAttempt>>;
  /** Read sanitized registration and exact pending recovery metadata. */
  status(connectionId: string): Promise<ProviderSubscriptionDescriptor>;
  /** Fence only the exact correlation obtained from this owner's pending status. */
  cancelPending(connectionId: string, attemptId: string): Promise<ProviderSubscriptionDescriptor>;
  /** Delete local authority before best-effort remote revocation. */
  disconnect(connectionId: string): Promise<ProviderSubscriptionDescriptor>;
}

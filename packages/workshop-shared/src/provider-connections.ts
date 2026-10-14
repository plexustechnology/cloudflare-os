/** Consent to the initial connection's explicitly selected funding and purposes. */
export interface ProviderConnectionConsent {
  /** The owner accepts OpenAI Platform API billing for this connection. */
  billing: "openai-platform-api";
  /** Only the authenticated owner's interactive turns may use this connection. */
  ownerInteractive: true;
  /** Whether compaction within that owner's session may use the same funding. */
  sessionCompaction: boolean;
}

/** Explicit funding, purpose and cost-limit consent for the protected subscription profile. */
export interface ProviderSubscriptionConsent {
  /** The owner selects ChatGPT plan and credit usage permitted by provider settings. */
  billing: "chatgpt-plan";
  /** Only the authenticated owner's interactive turns may use this connection. */
  ownerInteractive: true;
  /** Whether same-session compaction may use this funding. */
  sessionCompaction: boolean;
  /** Provider generation/cost may precede Plexus rejecting output above its acceptance limit. */
  acceptsProviderControlledOutput: true;
  /** Shared allowance/credits may be consumed; this does not authorize purchases or top-ups. */
  acceptsSharedPlanAndCreditUsage: true;
}

/** Paired subscription transport and consent; no API funding substitution is permitted. */
export interface ProviderSubscriptionProfile {
  /** Protected direct subscription Responses transport, independently of API inference. */
  transport: "openai-chatgpt-responses";
  /** Explicit subscription funding and purpose consent. */
  consent: ProviderSubscriptionConsent;
}

/** Saved authorization metadata; subscription inference remains unavailable. */
export type ProviderSubscriptionDescriptor = Omit<ProviderConnectionDescriptor, "transport" | "consent" | "status" | "inferenceEnabled" | "lastSuccessfulInference"> &
  ProviderSubscriptionProfile & {
    /** Local authorization state, independent of provider eligibility. */
    status: ProviderConnectionDescriptor["status"] | "plan-disabled";
    /** Public client association; verified does not establish inference readiness. */
    registration?: { /** Association state without provider identity. */ status: "none" | "provisional" | "verified";
      /** Provider-issued public client identifier, when retained. */ clientId?: string };
    /** Exact current correlation for explicit pending recovery only. */
    pendingAuthorization?: { /** Server-generated intent. */ attemptId: string;
      /** Pending callback or already issued exchange. */ phase: "pending" | "issued";
      /** Original deadline in Unix milliseconds. */ expiresAt: number };
  };

/** Sanitized connection metadata; catalog or configured credentials never imply readiness. */
export interface ProviderConnectionDescriptor {
  /** Server-generated opaque connection identifier; possession alone grants no authority. */
  connectionId: string;
  /** Owner-selected bounded display label. */
  label: string;
  /** Provider supported by the initial engineering profile. */
  provider: "openai";
  /** Fixed native Responses transport; subscription OAuth is not enabled. */
  transport: "openai-api-responses";
  /** Explicit owner funding and purpose consent. */
  consent: ProviderConnectionConsent;
  /** Local status, independent of entitlement or successful live inference. */
  status: "pending" | "disabled" | "reconnect-required";
  /** Whether an encrypted local credential is present; this is not readiness. */
  credentialConfigured: boolean;
  /** Authority generation; zero denotes a reserved pre-create slot, stored records start at one. */
  generation: number;
  /** Credential replacement revision; zero denotes a reserved slot, stored records start at one. */
  credentialRevision: number;
  /** Creation time as Unix milliseconds. */
  createdAt: number;
  /** Most recent local state change as Unix milliseconds. */
  updatedAt: number;
  /** True only when private deployment policy permits inference; absence means unavailable. */
  inferenceEnabled?: boolean;
  /** One strictly completed call for this generation, never universal model readiness. */
  lastSuccessfulInference?: {
    /** Provider model used by the completed call. */
    model: string;
    /** Current connection authority generation at completion. */
    generation: number;
    /** Validated completion time as Unix milliseconds. */
    completedAt: number;
  };
}

/** Allowlisted model identity; OpenAI's catalog does not validate inference capabilities. */
export interface ProviderConnectionModel {
  /** Server-generated namespaced selection identifier. */
  id: string;
  /** Provider model slug, bounded to 128 characters and deployment-allowlisted. */
  model: string;
  /** Sanitized model name; initially the same verified catalog slug. */
  name: string;
  /** Explicit unknown values until the selected inference route validates these properties. */
  capabilities: {
    /** Catalog discovery provides no validated context-window size. */
    contextWindow: null;
    /** Catalog discovery provides no validated output-token limit. */
    maxOutputTokens: null;
    /** Image support remains unverified. */
    images: "unknown";
    /** Reasoning support remains unverified. */
    reasoning: "unknown";
  };
}

/** Owner-scoped catalog, limited to 64 models; no listing implies entitlement or readiness. */
export interface ProviderConnectionCatalog {
  /** Fresh within five minutes, stale after expiry/failure, or unknown when no usable cache exists. */
  status: "fresh" | "stale" | "unknown";
  /** Allowlisted model descriptors with unknown capabilities. */
  models: ProviderConnectionModel[];
  /** Successful fetch time in Unix milliseconds, null when no catalog has been obtained. */
  fetchedAt: number | null;
  /** Bounded failure category without any upstream message, header or body. */
  error?: "provider_unavailable" | "rate_limited" | "reconnect_required";
}

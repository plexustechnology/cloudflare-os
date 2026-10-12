/** Consent to the initial connection's explicitly selected funding and purposes. */
export interface ProviderConnectionConsent {
  /** The owner accepts OpenAI Platform API billing for this connection. */
  billing: "openai-platform-api";
  /** Only the authenticated owner's interactive turns may use this connection. */
  ownerInteractive: true;
  /** Whether compaction within that owner's session may use the same funding. */
  sessionCompaction: boolean;
}

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

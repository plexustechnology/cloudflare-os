import type { RpcTarget } from "capnweb";
import type { ProviderConnectionConsent, ProviderConnectionDescriptor, ProviderConnectionCatalog } from "./provider-connections.js";

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

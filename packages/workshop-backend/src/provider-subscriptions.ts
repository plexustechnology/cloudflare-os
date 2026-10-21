import { RpcTarget } from "capnweb";
import type { RpcStub } from "capnweb";
import { validateRpc } from "capnweb-validate";
import type { ProviderSubscriptionAttempt, ProviderSubscriptionConnectionsApi, ProviderSubscriptionInput, ProviderSubscriptionHandoff, ProviderSubscriptionCompletion } from "@gadgets/workshop-shared/provider-connections-api";
import type { ProviderSubscriptionDescriptor } from "@gadgets/workshop-shared/provider-connections";
import type { UserDurableObject } from "./user.js";

/** One exact owner intent; captured factory/context never participates in RPC traversal. */
@validateRpc<ProviderSubscriptionAttempt>()
export class ProviderSubscriptionAttemptImpl extends RpcTarget implements ProviderSubscriptionAttempt {
  #getUser: () => DurableObjectStub<UserDurableObject>;
  #schedule: (work: Promise<unknown>) => void;
  #connectionId: string;
  #generation: number;
  #input: ProviderSubscriptionInput;
  #attemptId = crypto.randomUUID();
  #expiresAt = Date.now() + 300000;
  #beginStarted = false;
  #begun = false;
  #completeStarted = false;
  #cancelled = false;
  #settled = false;
  #cancellation?: Promise<ProviderSubscriptionDescriptor>;

  constructor(getUser: () => DurableObjectStub<UserDurableObject>, schedule: (work: Promise<unknown>) => void, connectionId: string, generation: number, input: ProviderSubscriptionInput) {
    super(); this.#getUser = getUser; this.#schedule = schedule; this.#connectionId = connectionId;
    this.#generation = generation; this.#input = { label: input.label, consent: { ...input.consent } };
  }
  /** Begin once; root receipts fence cancellation even if this response is lost. */
  async begin(callbackPort: number): Promise<ProviderSubscriptionHandoff> {
    if (this.#beginStarted || this.#cancelled || this.#settled || this.#expiresAt <= Date.now()) throw new Error("reconnect_required");
    this.#beginStarted = true;
    if (!Number.isSafeInteger(callbackPort) || callbackPort < 1024 || callbackPort > 65535) throw new Error("invalid_request");
    const result = await this.#getUser().beginProviderSubscription(this.#connectionId, this.#generation, this.#input, this.#attemptId, this.#expiresAt, callbackPort);
    if (this.#cancelled) { await this.cancel(); throw new Error("reconnect_required"); }
    this.#begun = true; return result;
  }
  /** One ciphertext submission; uncertain results cannot be replayed on this capability. */
  async complete(sealedCapsule: string): Promise<ProviderSubscriptionCompletion> {
    if (!this.#begun || this.#completeStarted || this.#cancelled || this.#settled || this.#expiresAt <= Date.now()) throw new Error("reconnect_required");
    this.#completeStarted = true;
    const result = await this.#getUser().completeProviderSubscription(this.#connectionId, this.#attemptId, sealedCapsule);
    this.#settled = true; return result;
  }
  /** Completion winning its transaction is reported by current metadata, never revoked here. */
  cancel(): Promise<ProviderSubscriptionDescriptor> {
    this.#cancelled = true;
    if (this.#settled && !this.#cancellation) return this.#getUser().getProviderSubscriptionStatus(this.#connectionId);
    this.#cancellation ??= this.#getUser().cancelProviderSubscription(this.#connectionId, this.#generation, this.#input, this.#attemptId, this.#expiresAt)
      .then(result => { this.#settled = true; return result; });
    return this.#cancellation;
  }
  /** Best-effort lifetime cleanup; durable receipts and fixed expiry provide correctness. */
  [Symbol.dispose](): void {
    if (!this.#settled) this.#schedule(this.cancel().catch(() => undefined));
  }
}

/** Separate subscription management facade derives all authority from the real authenticated UserDO. */
@validateRpc<ProviderSubscriptionConnectionsApi>()
export class ProviderSubscriptionConnectionsApiImpl extends RpcTarget implements ProviderSubscriptionConnectionsApi {
  #getUser: () => DurableObjectStub<UserDurableObject>;
  #schedule: (work: Promise<unknown>) => void;
  constructor(getUser: () => DurableObjectStub<UserDurableObject>, schedule: (work: Promise<unknown>) => void) { super(); this.#getUser = getUser; this.#schedule = schedule; }
  /** Return current subscription metadata and bounded choices. */
  discover(connectionId: string) { return this.#getUser().discoverProviderSubscriptionModels(connectionId); }
  /** Explicit revision-checked selection; this never starts inference. */
  selectModel(connectionId: string, expectedGeneration: number, expectedCredentialRevision: number, model: string) {
    return this.#getUser().selectProviderSubscriptionModel(connectionId, expectedGeneration, expectedCredentialRevision, model);
  }
  /** List sanitized owner subscription slots. */
  list(): Promise<ProviderSubscriptionDescriptor[]> { return this.#getUser().listProviderSubscriptions(); }
  /** Reserve a credential-free subscription slot. */
  reserve(input: ProviderSubscriptionInput): Promise<ProviderSubscriptionDescriptor> { return this.#getUser().reserveProviderSubscription(input); }
  /** Mint an exact one-shot intent after checking current native owner authority. */
  async prepare(connectionId: string, expectedGeneration: number, input: ProviderSubscriptionInput): Promise<RpcStub<ProviderSubscriptionAttempt>> {
    const safe = await this.#getUser().prepareProviderSubscription(connectionId, expectedGeneration, input);
    // @ts-expect-error Cap'n Web marshals targets into stubs at the RPC boundary.
    return new ProviderSubscriptionAttemptImpl(this.#getUser, this.#schedule, connectionId, expectedGeneration, safe);
  }
  /** Return public association and pending correlation only. */
  status(connectionId: string): Promise<ProviderSubscriptionDescriptor> { return this.#getUser().getProviderSubscriptionStatus(connectionId); }
  /** Cancel only the exact owner-visible pending correlation. */
  cancelPending(connectionId: string, attemptId: string): Promise<ProviderSubscriptionDescriptor> { return this.#getUser().cancelPendingProviderSubscription(connectionId, attemptId); }
  /** Fence local credentials before optional remote revocation. */
  disconnect(connectionId: string): Promise<ProviderSubscriptionDescriptor> { return this.#getUser().disconnectProviderSubscription(connectionId); }
}

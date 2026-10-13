import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import type { ProviderConnectionDescriptor, ProviderConnectionCatalog, ProviderConnectionModel } from "@gadgets/workshop-shared/provider-connections";
import type { ProviderConnectionInput, ProviderConnectionsApi } from "@gadgets/workshop-shared/provider-connections-api";
import type { UserDurableObject } from "./user.js";
import type { Singleton } from "@gadgets/typed-storage";

const MAX_CONNECTIONS = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ERROR_STATUS: Record<string, number> = { adapter_disabled: 503, connection_forbidden: 403,
  invalid_request: 400, connection_required: 404, reconnect_required: 409,
  provider_unavailable: 503, unsupported_feature: 400 };
const ERROR_CODES = new Set(Object.keys(ERROR_STATUS));
/** Sanitized owner index reservation; never includes credentials or authority-bearing stubs. */
export type ProviderConnectionReservation = Pick<ProviderConnectionDescriptor, "connectionId" | "label" | "consent" | "createdAt">;
type Action = "available" | "create" | "reconnect" | "status" | "disconnect" | "discover";

function failure(code = "provider_unavailable"): never { throw new Error(code); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function counter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function label(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 80 &&
    value === value.trim() && !Array.from(value).some(character => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    });
}
function consent(value: unknown): value is ProviderConnectionInput["consent"] {
  return object(value) && keys(value, ["billing", "ownerInteractive", "sessionCompaction"]) && value.billing === "openai-platform-api" && value.ownerInteractive === true &&
    typeof value.sessionCompaction === "boolean";
}
function intake(input: ProviderConnectionInput): ProviderConnectionInput {
  // Structural RPC checks are generated; semantic limits also guard the native UserDO boundary.
  if (!object(input) || !keys(input, ["label", "apiKey", "consent"]) || !label(input.label) || !consent(input.consent) ||
      typeof input.apiKey !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(input.apiKey)) failure("invalid_request");
  return { label: input.label, apiKey: input.apiKey, consent: {
    billing: "openai-platform-api", ownerInteractive: true,
    sessionCompaction: input.consent.sessionCompaction,
  } };
}
function descriptor(value: unknown, connectionId: string): ProviderConnectionDescriptor {
  if (!object(value) || value.connectionId !== connectionId || !label(value.label) || !consent(value.consent) ||
      value.provider !== "openai" || value.transport !== "openai-api-responses" ||
      typeof value.status !== "string" || !["pending", "disabled", "reconnect-required"].includes(value.status) ||
      typeof value.credentialConfigured !== "boolean" || !counter(value.generation) ||
      !counter(value.credentialRevision) || value.generation < 1 || value.credentialRevision < 1 ||
      !counter(value.createdAt) || !counter(value.updatedAt) || value.updatedAt < value.createdAt ||
      (value.inferenceEnabled !== undefined && typeof value.inferenceEnabled !== "boolean")) failure();
  let success: ProviderConnectionDescriptor["lastSuccessfulInference"];
  if (value.lastSuccessfulInference !== undefined) {
    const s = value.lastSuccessfulInference;
    if (!object(s) || !keys(s, ["model", "generation", "completedAt"]) ||
        typeof s.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(s.model) ||
        s.generation !== value.generation || !counter(s.completedAt) || s.completedAt < 1 || s.completedAt > Date.now()) failure();
    success = { model: s.model, generation: value.generation, completedAt: s.completedAt };
  }
  return { connectionId, label: value.label, provider: "openai", transport: "openai-api-responses",
    consent: { billing: "openai-platform-api", ownerInteractive: true, sessionCompaction: value.consent.sessionCompaction },
    status: value.status as ProviderConnectionDescriptor["status"], credentialConfigured: value.credentialConfigured,
    generation: value.generation, credentialRevision: value.credentialRevision,
    createdAt: value.createdAt, updatedAt: value.updatedAt,
    ...(value.inferenceEnabled === undefined ? {} : { inferenceEnabled: value.inferenceEnabled }),
    ...(success ? { lastSuccessfulInference: success } : {}) };
}

function catalog(value: unknown, connectionId: string): ProviderConnectionCatalog {
  if (!object(value) || typeof value.status !== "string" || !["fresh", "stale", "unknown"].includes(value.status) ||
      !Array.isArray(value.models) || value.models.length > 64 ||
      (value.fetchedAt !== null && !counter(value.fetchedAt)) ||
      (value.error !== undefined && (typeof value.error !== "string" ||
        !["provider_unavailable", "rate_limited", "reconnect_required"].includes(value.error)))) failure();
  const models: ProviderConnectionModel[] = value.models.map(model => {
    if (!object(model) || typeof model.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(model.model) ||
        model.name !== model.model || model.id !== `provider-connection/${connectionId}/${encodeURIComponent(model.model)}` ||
        typeof model.id !== "string" || model.id.length > 450 || !object(model.capabilities) ||
        !keys(model.capabilities, ["contextWindow", "maxOutputTokens", "images", "reasoning"]) ||
        model.capabilities.contextWindow !== null || model.capabilities.maxOutputTokens !== null ||
        model.capabilities.images !== "unknown" || model.capabilities.reasoning !== "unknown") failure();
    return { id: model.id, model: model.model, name: model.model,
      capabilities: { contextWindow: null, maxOutputTokens: null, images: "unknown", reasoning: "unknown" } };
  });
  if (new Set(models.map(model => model.id)).size !== models.length ||
      (value.status === "unknown" && (models.length !== 0 || value.fetchedAt !== null)) ||
      (value.status !== "unknown" && value.fetchedAt === null)) failure();
  return { status: value.status as ProviderConnectionCatalog["status"], models, fetchedAt: value.fetchedAt,
    ...(value.error === undefined ? {} : { error: value.error as ProviderConnectionCatalog["error"] }) };
}

/** Local sanitized index plus fixed private transport, owned solely by the authenticated UserDO. */
export class ProviderConnectionIndex {
  #storage: Singleton<ProviderConnectionReservation[]>;
  #binding: Cloudflare.Env["AI_PROVIDER_ADAPTER"];
  #ownerId: string;
  constructor(storage: Singleton<ProviderConnectionReservation[]>, binding: Cloudflare.Env["AI_PROVIDER_ADAPTER"], ownerId: string) {
    this.#storage = storage;
    this.#binding = binding;
    this.#ownerId = ownerId;
  }

  #index(): ProviderConnectionReservation[] {
    let value: unknown;
    try { value = this.#storage.get(); } catch { return failure(); }
    if (!Array.isArray(value) || value.length > MAX_CONNECTIONS || value.some(entry =>
      !object(entry) || !keys(entry, ["connectionId", "label", "consent", "createdAt"]) || typeof entry.connectionId !== "string" || !UUID.test(entry.connectionId) ||
      !label(entry.label) || !consent(entry.consent) || !counter(entry.createdAt)) ||
      new Set(value.map(entry => entry.connectionId)).size !== value.length) failure();
    return value.map(entry => ({ connectionId: entry.connectionId, label: entry.label,
      consent: { billing: "openai-platform-api", ownerInteractive: true, sessionCompaction: entry.consent.sessionCompaction },
      createdAt: entry.createdAt }));
  }

  #owned(connectionId: string): ProviderConnectionReservation {
    if (typeof connectionId !== "string" || !UUID.test(connectionId)) failure("connection_forbidden");
    const entry = this.#index().find(entry => entry.connectionId === connectionId);
    if (!entry) failure("connection_forbidden");
    return entry;
  }

  async #call(action: Action, connectionId?: string, expectedGeneration?: number, input?: ProviderConnectionInput,
    reservation?: Pick<ProviderConnectionReservation, "label" | "consent">): Promise<Record<string, unknown>> {
    const binding = this.#binding;
    if (!binding) return failure("adapter_disabled");
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("provider_unavailable")); }, 15_000);
    });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await binding.fetch("https://provider-adapter.internal/internal/v1/connections", {
          method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ version: 1, action, ownerId: this.#ownerId,
            ...(connectionId === undefined ? {} : { connectionId }),
            ...(expectedGeneration === undefined ? {} : { expectedGeneration }),
            ...(input === undefined ? {} : { input }),
            ...(reservation === undefined ? {} : { reservation }) }),
        });
        if (!response.body) failure();
        reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
        let bytes = 0, body = "";
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 65_536) failure();
            body += decoder.decode(value, { stream: true });
          }
          body += decoder.decode();
        } finally { void reader.cancel().catch(() => {}); }
        const result: unknown = JSON.parse(body);
        if (!object(result)) failure();
        if (result.ok === false && object(result.error) && typeof result.error.code === "string" &&
            ERROR_CODES.has(result.error.code) && response.status === ERROR_STATUS[result.error.code]) failure(result.error.code);
        if (!response.ok || result.ok !== true) failure();
        return result;
      })()]);
    } catch (error) {
      // Only our fixed categories survive transport/storage/provider failures and telemetry.
      // The original cause may contain credential or provider diagnostics; retain only our fixed category.
      // oxlint-disable-next-line preserve-caught-error
      if (error instanceof Error && ERROR_CODES.has(error.message)) throw new Error(error.message);
      return failure();
    } finally { clearTimeout(timer); void reader?.cancel().catch(() => {}); }
  }

  /** Availability is rechecked by the adapter for every control, even for a previously minted cap. */
  async available(): Promise<boolean> {
    if (!this.#binding) return false;
    try { return (await this.#call("available")).available === true; }
    catch (error) {
      if (error instanceof Error && ["adapter_disabled", "connection_forbidden"].includes(error.message)) return false;
      throw error;
    }
  }

  /** Bounded owner listing preserves a pending slot after a lost create outcome. */
  async list(): Promise<ProviderConnectionDescriptor[]> {
    if (!await this.available()) failure("adapter_disabled");
    const entries = this.#index();
    const result: ProviderConnectionDescriptor[] = [];
    for (const entry of entries) result.push(await this.status(entry.connectionId));
    return result;
  }

  /** Validates before reserving; the durable reservation precedes any uncertain credential write. */
  async create(input: ProviderConnectionInput): Promise<ProviderConnectionDescriptor> {
    const safeInput = intake(input);
    const reserved = await this.reserve({ label: safeInput.label, consent: safeInput.consent });
    return descriptor((await this.#call("create", reserved.connectionId, 0, safeInput)).connection, reserved.connectionId);
  }

  /** Durable credential-free cancellation identity, minted before key intake. */
  async reserve(input: Pick<ProviderConnectionInput, "label" | "consent">): Promise<ProviderConnectionDescriptor> {
    if (!object(input) || !keys(input, ["label", "consent"]) || !label(input.label) || !consent(input.consent)) failure("invalid_request");
    if (!await this.available()) failure("adapter_disabled");
    const entries = this.#index();
    if (entries.length >= MAX_CONNECTIONS) failure("invalid_request");
    const connectionId = crypto.randomUUID();
    entries.push({ connectionId, label: input.label, consent: { ...input.consent }, createdAt: Date.now() });
    try { this.#storage.put(entries); } catch { return failure(); }
    return this.status(connectionId);
  }

  /** Capture a currently permitted model only after validating the selected authority. */
  async selection(connectionId: string, expectedGeneration: number, model: string): Promise<ProviderConnectionDescriptor> {
    this.#owned(connectionId);
    if (!counter(expectedGeneration) || expectedGeneration < 1 || typeof model !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(model)) failure("invalid_request");
    const current = await this.status(connectionId);
    if (current.generation !== expectedGeneration || current.status !== "pending" || !current.credentialConfigured) failure("reconnect_required");
    if (current.inferenceEnabled !== true) failure("adapter_disabled");
    const choices = await this.discover(connectionId);
    if (choices.status !== "fresh" || !choices.models.some(choice => choice.model === model)) failure("invalid_request");
    const fresh = await this.status(connectionId);
    if (fresh.generation !== expectedGeneration || fresh.status !== "pending" || !fresh.credentialConfigured) failure("reconnect_required");
    if (fresh.inferenceEnabled !== true) failure("adapter_disabled");
    return fresh;
  }

  /** Explicit generation-zero recovery creates only after a confirmed absent adapter record. */
  async reconnect(connectionId: string, expectedGeneration: number, input: ProviderConnectionInput): Promise<ProviderConnectionDescriptor> {
    this.#owned(connectionId);
    const safeInput = intake(input);
    if (!counter(expectedGeneration)) failure("invalid_request");
    if (expectedGeneration === 0) {
      try { await this.#call("status", connectionId); }
      catch (error) {
        if (error instanceof Error && error.message === "connection_required") {
          return descriptor((await this.#call("create", connectionId, 0, safeInput)).connection, connectionId);
        }
        throw error;
      }
      failure("reconnect_required");
    }
    return descriptor((await this.#call("reconnect", connectionId, expectedGeneration, safeInput)).connection, connectionId);
  }

  /** Returns adapter metadata or the reservation only after confirmed absence. */
  async status(connectionId: string): Promise<ProviderConnectionDescriptor> {
    const entry = this.#owned(connectionId);
    try { return descriptor((await this.#call("status", connectionId)).connection, connectionId); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== "connection_required") throw error;
      return { connectionId, label: entry.label, consent: { billing: "openai-platform-api", ownerInteractive: true,
          sessionCompaction: entry.consent.sessionCompaction }, provider: "openai",
        transport: "openai-api-responses", status: "pending", credentialConfigured: false,
        generation: 0, credentialRevision: 0, createdAt: entry.createdAt, updatedAt: entry.createdAt };
    }
  }

  /** Keeps the index entry so a disconnected connection remains owner-visible and reconnectable. */
  async disconnect(connectionId: string): Promise<ProviderConnectionDescriptor> {
    const { label, consent } = this.#owned(connectionId);
    return descriptor((await this.#call("disconnect", connectionId, undefined, undefined, { label, consent })).connection, connectionId);
  }

  /** Validates private catalog metadata again before exposing it to the owner. */
  async discover(connectionId: string): Promise<ProviderConnectionCatalog> {
    this.#owned(connectionId);
    const result = await this.#call("discover", connectionId);
    descriptor(result.connection, connectionId);
    return catalog(result.catalog, connectionId);
  }
}

/** Narrow facade holds only the actual authenticated UserDO factory, hidden from RPC traversal. */
@validateRpc<ProviderConnectionsApi>()
export class ProviderConnectionsApiImpl extends RpcTarget implements ProviderConnectionsApi {
  #getUser: () => DurableObjectStub<UserDurableObject>;
  constructor(getUser: () => DurableObjectStub<UserDurableObject>) { super(); this.#getUser = getUser; }
  /** Lists sanitized owner metadata. */
  list(): Promise<ProviderConnectionDescriptor[]> { return this.#getUser().listProviderConnections(); }
  /** Reserves a key-free owner slot for cancellable intake. */
  reserve(input: Pick<ProviderConnectionInput, "label" | "consent">): Promise<ProviderConnectionDescriptor> {
    return this.#getUser().reserveProviderConnection(input);
  }
  /** Adds a server-resolved personal model without browser profile authority. */
  selectModel(connectionId: string, expectedGeneration: number, model: string) {
    return this.#getUser().selectProviderConnectionModel(connectionId, expectedGeneration, model);
  }
  /** Submits a write-only credential once. */
  create(input: ProviderConnectionInput): Promise<ProviderConnectionDescriptor> { return this.#getUser().createProviderConnection(input); }
  /** Performs one explicit generation-checked replacement. */
  reconnect(connectionId: string, expectedGeneration: number, input: ProviderConnectionInput): Promise<ProviderConnectionDescriptor> {
    return this.#getUser().reconnectProviderConnection(connectionId, expectedGeneration, input);
  }
  /** Reads one owner-indexed connection. */
  status(connectionId: string): Promise<ProviderConnectionDescriptor> { return this.#getUser().getProviderConnectionStatus(connectionId); }
  /** Discovers only this owner's indexed connection through the fixed private service. */
  discover(connectionId: string): Promise<ProviderConnectionCatalog> { return this.#getUser().discoverProviderConnectionModels(connectionId); }
  /** Invalidates local connection authority without automatic remote revocation. */
  disconnect(connectionId: string): Promise<ProviderConnectionDescriptor> { return this.#getUser().disconnectProviderConnection(connectionId); }
}

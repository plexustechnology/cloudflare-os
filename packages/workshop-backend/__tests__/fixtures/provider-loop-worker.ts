import { DurableObject, WorkerEntrypoint, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { RpcTarget } from "capnweb";
import type { ApprovalQueue, ResourceDescription } from "@gadgets/workshop-shared/gatekeeper";
import { ProviderConnectionStore } from "../../../../../packages/ai-provider-adapter/src/connection-store";
import { ConnectionInference } from "../../../../../packages/ai-provider-adapter/src/inference-runtime";
import { validateInference, validateInferenceCancel } from "../../../../../packages/ai-provider-adapter/src/inference-request";
import { PROVIDER_INFERENCE_CANCEL_URL } from "@gadgets/workshop-shared/provider-inference";
import type { ProviderInferenceRequest, ProviderInferenceCancelRequest } from "@gadgets/workshop-shared/provider-inference";
import { inferencePolicy, providerResponse, textEvents } from "../../../../../packages/ai-provider-adapter/src/fixtures/inference";
// Reuse the unit Worker's restore-symbol bridge for the pool's native DO wrapper.
import { OverseerDurableObject as ProductionOverseerDurableObject } from "../test-worker.js";
import type { GatekeeperLoopback as ProductionGatekeeperLoopback } from "../../src/overseer.js";

export {
  default, PendingLogin, LoginConnectCallbackImpl, LanguageModelGatekeeper, AdminSettings,
  UserDurableObject, UserDirectoryDurableObject, GatekeeperConnectCallbackImpl,
  GatekeeperHookLoopback, CodeModeTailLoopback, AgentSpawnerGatekeeper, GadgetTailLoopback,
  AgentSelfLoopback, TransientStubLoopback, ExternalMessageGateway,
} from "../../src/server.js";
export { TestProviderUser } from "./provider-connections-worker.js";

/** Actual production actor with only test-native incarnation and abrupt-restart instrumentation. */
export class OverseerDurableObject extends ProductionOverseerDurableObject {
  #incarnation = crypto.randomUUID();
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    const impl = Reflect.get(this, "impl");
    // Restore the same native fixture capabilities on every real actor incarnation.
    impl.users = Reflect.get(env, "TestProviderUser");
    impl.env = { ...env, AI_PROVIDER_ADAPTER: env.AI_PROVIDER_ADAPTER ?? Reflect.get(ctx.exports, "QaInferenceDispatcher")({ props: {} }) };
  }
  /** A fresh UUID proves the native constructor ran again, rather than reconstructing its impl. */
  getTestIncarnation(): string { return this.#incarnation; }
  /** Kill this native actor only; its durable data and other actors remain intact. */
  forceTestRestart(): void { this.ctx.abort("QA_FORCED_NATIVE_RESTART"); }
}

/**
 * Test-only explicit method facade for the pool's prototype-checking RPC shim. Production's
 * GatekeeperLoopback returns a Proxy whose prototype is WorkerEntrypoint.prototype; the pool
 * incorrectly rejects dynamic session methods. Session minting and approval remain production.
 */
export class GatekeeperLoopback extends WorkerEntrypoint<Cloudflare.Env,
  ConstructorParameters<typeof ProductionGatekeeperLoopback>[0]["props"]> {
  #session: ReturnType<OverseerDurableObject["startGatekeeperSession"]> | undefined;
  async #getSession() {
    if (!this.#session) {
      const namespace = Reflect.get(this.ctx.exports, "OverseerDurableObject") as DurableObjectNamespace<ProductionOverseerDurableObject>;
      this.#session = namespace.get(namespace.idFromString(this.ctx.props.overseerId))
        .startGatekeeperSession(this.ctx.props.target, this.ctx.props.caller);
    }
    return this.#session;
  }
  async read(): Promise<number> {
    using session = await this.#getSession();
    return await session.read();
  }
  async write(value: number): Promise<void> {
    using session = await this.#getSession();
    await session.write(value);
  }
}

/** Synthetic fixture evidence decoded from JSON, including the strict validator's unknown payload. */
export type QaInferenceSnapshot = { captured: ProviderInferenceRequest[]; cancellations: ProviderInferenceCancelRequest[]; headers: number; errors: string[] };

/** Real SQLite/response I/O owner for the production connection store/runtime in QA. */
export class QaConnectionStorage extends DurableObject {
  #runtime: ConnectionInference | undefined;
  #owner: string | undefined;
  #signal: AbortSignal | null | undefined;
  #replies: (Record<string, unknown>[] | null)[] = [];
  #captured: ProviderInferenceRequest[] = [];
  #cancellations: ProviderInferenceCancelRequest[] = [];
  #headers = 0;
  #errors: string[] = [];

  /** Test-only setup; never exported by the deployed adapter. */
  async configure(owner: string, id: string, replies: (Record<string, unknown>[] | null)[]): Promise<void> {
    this.#owner = owner; this.#replies = replies;
    const namespace = Reflect.get(this.env, "QaConnectionStorage") as DurableObjectNamespace<QaConnectionStorage>;
    const store = new ProviderConnectionStore(this.ctx.storage, "fixture-dev", this.ctx.id.toString(),
      id => namespace.idFromName(id).toString(),
      { activeKeyVersion: "v1", keyVersions: ["v1"], getKey: () => btoa("1".repeat(32)) });
    await store.create(owner, id, "QA API", { billing: "openai-platform-api", ownerInteractive: true, sessionCompaction: true },
      { kind: "api-key", apiKey: "QA_SYNTHETIC_KEY" });
    this.#runtime = new ConnectionInference(store); await this.#runtime.recovered();
  }

  /** Fixed synthetic network edge; native fetch keeps store/pull I/O in its owning DO. */
  override async fetch(request: Request): Promise<Response> {
    try { return await this.#infer(request); }
    catch (error) { this.#errors.push("qa.inference.fixture.failed"); throw error; }
  }

  async #infer(request: Request): Promise<Response> {
    if (!this.#owner || !this.#runtime) throw new Error("QA connection unconfigured");
    const policy = inferencePolicy({ ownerIds: [this.#owner] });
    const envelope = await request.json();
    if (request.url === PROVIDER_INFERENCE_CANCEL_URL) {
      const cancellation = validateInferenceCancel(envelope, policy);
      this.#cancellations.push(cancellation);
      await this.#runtime.cancelRequest(cancellation);
      return Response.json({ ok: true });
    }
    const validated = validateInference(envelope, policy);
    this.#captured.push(validated.request);
    const events = this.#replies.shift();
    if (events === undefined) throw new Error("QA unexpected additional inference");
    const response = await this.#runtime.run(validated, policy, request.signal, async (_url, init) => {
      this.#signal = init?.signal;
      if (events === null) {
        let sent = false;
        return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
          if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(
            `data: ${JSON.stringify(textEvents()[0])}\n\n`)); }
        } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
      }
      return providerResponse(events, 256, events.at(-1)?.type === "response.completed").response;
    });
    this.#headers++;
    return response;
  }
  /** Volatile test evidence remains in its native I/O owner and is read through ordinary RPC. */
  async snapshot(): Promise<string> {
    const evidence: QaInferenceSnapshot = { captured: this.#captured, cancellations: this.#cancellations, headers: this.#headers, errors: this.#errors };
    // Unknown protocol payloads cannot be native RPC values; the validated synthetic DTO travels as JSON.
    return JSON.stringify(evidence);
  }
  async probe(): Promise<{ issued: boolean; aborted: boolean }> {
    return { issued: await this.ctx.storage.get("inference-v1") !== undefined, aborted: this.#signal?.aborted ?? false };
  }
}

/** Native forwarding edge; no request-created JS callback or response body is retained in Overseer. */
export class QaInferenceDispatcher extends WorkerEntrypoint<{
  QaConnectionStorage: DurableObjectNamespace<QaConnectionStorage>;
}> {
  override async fetch(request: Request): Promise<Response> {
    const envelope = await request.clone().json() as { connectionId: string };
    return this.env.QaConnectionStorage.getByName(envelope.connectionId).fetch(request);
  }
}

/** Deterministic external service: only applyAction mutates committed state. */
export class QaGatekeeper extends DurableObject {
  async describe(): Promise<ResourceDescription> {
    return { title: "QA resource", tsType: "QaSession", url: "https://fixture.example.test/resource",
      snippet: "Deterministic QA resource", suggestedBindingName: "TEST_RESOURCE" };
  }
  async getTypeScriptTypes(): Promise<string> {
    return "interface QaSession { read(): Promise<number>; write(value:number): Promise<void> }";
  }
  async getAutoApprovableActions(): Promise<[]> { return []; }
  async addObserver(): Promise<void> { }
  async removeObserver(): Promise<void> { }
  async startSession(queue: NativeRpcStub<ApprovalQueue>): Promise<QaSession> {
    return new QaSession(this.ctx.storage, queue.dup());
  }
  async applyAction(action: number): Promise<void> {
    const value = this.ctx.storage.kv.get<number>(`pending:${action}`);
    if (value === undefined) throw new Error("QA action missing");
    this.ctx.storage.kv.put("value", value);
    this.ctx.storage.kv.put("applied", (this.ctx.storage.kv.get<number>("applied") ?? 0) + 1);
    this.ctx.storage.kv.delete(`pending:${action}`);
  }
  async rejectAction(action: number): Promise<void> {
    this.ctx.storage.kv.delete(`pending:${action}`);
    this.ctx.storage.kv.put("rejected", (this.ctx.storage.kv.get<number>("rejected") ?? 0) + 1);
  }
  async evidence(): Promise<{ value: number; applied: number; rejected: number }> {
    return { value: this.ctx.storage.kv.get<number>("value") ?? 0,
      applied: this.ctx.storage.kv.get<number>("applied") ?? 0,
      rejected: this.ctx.storage.kv.get<number>("rejected") ?? 0 };
  }
}

/** Session reads audit before disclosure and simulates a queued write without applying it. */
class QaSession extends RpcTarget {
  #storage: DurableObjectStorage;
  #queue: NativeRpcStub<ApprovalQueue>;
  #simulated: number | undefined;
  constructor(storage: DurableObjectStorage, queue: NativeRpcStub<ApprovalQueue>) {
    super(); this.#storage = storage; this.#queue = queue;
  }
  [Symbol.dispose](): void { this.#queue[Symbol.dispose](); }
  async read(): Promise<number> {
    await this.#queue.authorizeObservation({ title: "QA read", description: "Read synthetic state" });
    const latest = (this.#storage.kv.get<number>("next") ?? 0) - 1;
    return this.#simulated ?? this.#storage.kv.get<number>(`pending:${latest}`) ?? this.#storage.kv.get<number>("value") ?? 0;
  }
  async write(value: number): Promise<void> {
    const id = this.#storage.kv.get<number>("next") ?? 0;
    this.#storage.kv.put("next", id + 1);
    this.#storage.kv.put(`pending:${id}`, value);
    await this.#queue.submitAction(id, { title: "QA write", description: "Change synthetic state",
      awaitDecision: true, implementsRevert: false });
    this.#simulated = value;
  }
}

import { createAssistantMessageEventStream, type AssistantMessage, type Context, type FetchFunction, type Model } from "@earendil-works/pi-ai";
import { stream as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import type { AiConnectionModelConfig } from "@gadgets/workshop-shared/api";
import { PROVIDER_INFERENCE_URL, PROVIDER_INFERENCE_CANCEL_URL, PROVIDER_INFERENCE_MAX_LIFETIME_MS,
  PROVIDER_INFERENCE_CLEANUP_GRACE_MS, PROVIDER_INFERENCE_PROTOCOL, PROVIDER_CONNECTION_PLANNING_WINDOW,
  PROVIDER_CONNECTION_OUTPUT_LIMIT, type ProviderInferenceRequest, type ProviderInferencePurpose,
  type ProviderInferenceErrorCode, type ProviderInferenceCancelRequest } from "@gadgets/workshop-shared/provider-inference";
import type { ModelHandle } from "./ai-models.js";
import { zeroUsage } from "./ai-invoke.js";

/** Backend-derived session authority with a live check before every privately billed call. */
export type ProviderModelAuthority = Pick<ProviderInferenceRequest, "ownerId" | "requesterUserId" | "workspaceOwnerId" | "session"> & {
  /** Fixed purpose of this owner-authenticated turn or continuation. */
  purpose: Exclude<ProviderInferencePurpose, "sessionCompaction">;
  /** Rechecks actual UserDO, sharing, selected generation and stored purpose consent. */
  authorize: (purpose: ProviderInferencePurpose) => Promise<void>;
};

const ERROR_CODES = new Set<ProviderInferenceErrorCode>(["connection_required", "reconnect_required", "connection_forbidden",
  "model_unavailable", "usage_limit", "rate_limited", "provider_unavailable", "invalid_request", "unsupported_feature",
  "stream_incomplete", "cancelled", "adapter_disabled"]);

function safeCode(value: unknown): ProviderInferenceErrorCode {
  return typeof value === "string" && ERROR_CODES.has(value as ProviderInferenceErrorCode)
    ? value as ProviderInferenceErrorCode : "provider_unavailable";
}

function failed(model: Model<"openai-responses">, code: ProviderInferenceErrorCode): AssistantMessage {
  return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: zeroUsage(), timestamp: Date.now(), stopReason: code === "cancelled" ? "aborted" : "error", errorMessage: code };
}

/** Fixed private native Responses handle; provider credentials never enter the kernel. */
export function getProviderConnectionModel(env: Cloudflare.Env, config: AiConnectionModelConfig, authority: ProviderModelAuthority): ModelHandle {
  const scope = `provider-connection/${config.connectionId}/${config.generation}`;
  const model: Model<"openai-responses"> = {
    id: config.model, name: config.model, api: "openai-responses", provider: scope,
    baseUrl: "https://provider-adapter.internal/v1", reasoning: true, input: ["text", "image"],
    contextWindow: PROVIDER_CONNECTION_PLANNING_WINDOW, maxTokens: PROVIDER_CONNECTION_OUTPUT_LIMIT,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsDeveloperRole: true, supportsStrictMode: false, supportsLongCacheRetention: false },
  };
  Object.freeze(model.compat);
  Object.freeze(model);
  const handle: ModelHandle = { model, stream: (_callerModel, context, options = {}) => {
    handle.lastResponse = undefined;
    const output = createAssistantMessageEventStream();
    const controller = new AbortController();
    const expiresAt = Date.now() + PROVIDER_INFERENCE_MAX_LIFETIME_MS;
    let cancelRequest: ProviderInferenceCancelRequest | undefined;
    let adapterReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let settled = false;
    let terminalTask: Promise<void> | undefined;
    let readerCancellation: Promise<void> | undefined;
    let stopReading!: () => void;
    const abortedRead = new Promise<ReadableStreamReadResult<Uint8Array>>(resolve => {
      stopReading = () => resolve({ done: true, value: undefined });
    });
    const cancelReader = () => {
      if (!adapterReader) return Promise.resolve();
      readerCancellation ??= adapterReader.cancel().catch(() => {});
      return readerCancellation;
    };
    const cancelPrivate = async (signal: AbortSignal) => {
      if (!cancelRequest) return;
      const response = await env.AI_PROVIDER_ADAPTER!.fetch(PROVIDER_INFERENCE_CANCEL_URL, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(cancelRequest), signal,
      });
      // The private acknowledgement contains only fixed success/error values; never retain it.
      await response.body?.cancel().catch(() => {});
    };
    const cleanup = async (cancelInference: boolean) => {
      const cleanupController = new AbortController();
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const tasks = [cancelReader()];
        if (cancelInference) tasks.push(cancelPrivate(cleanupController.signal));
        await Promise.race([Promise.allSettled(tasks), new Promise<void>(resolve => {
          cleanupTimer = setTimeout(resolve, PROVIDER_INFERENCE_CLEANUP_GRACE_MS);
        })]);
      } finally { clearTimeout(cleanupTimer); cleanupController.abort(); }
    };
    let code: ProviderInferenceErrorCode = "provider_unavailable";
    const finish = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancelled);
      return true;
    };
    const fail = (reason: ProviderInferenceErrorCode) => {
      if (!finish()) return;
      terminalTask = (async () => {
        // Keep the request scope alive for bounded native cancellation before publishing its result.
        const pendingCleanup = cleanup(true);
        stopReading();
        await pendingCleanup;
        controller.abort();
        const message = failed(model, reason);
        output.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message });
        output.end();
      })();
    };
    const cancelled = () => fail("cancelled");
    const timer = setTimeout(() => fail("provider_unavailable"), PROVIDER_INFERENCE_MAX_LIFETIME_MS);
    options.signal?.addEventListener("abort", cancelled, { once: true });
    if (options.signal?.aborted) { cancelled(); return output; }
    // The SDK reads process.env at construction, before its custom fetch. Require effective
    // diagnostics off rather than trusting a binding that process.env could override.
    if (globalThis.process?.env?.OPENAI_LOG?.trim() !== "off") { fail("adapter_disabled"); return output; }
    if (!env.AI_PROVIDER_ADAPTER) { fail("adapter_disabled"); return output; }
    // Pi-agent-core passes its orchestration config to StreamFn as well. These fields are
    // ignored here; only the four selected inference options enter the provider adapter.
    const permitted = new Set(["signal", "maxTokens", "thinking", "purpose", "model", "convertToLlm",
      "toolExecution", "shouldStopAfterTurn", "apiKey"]);
    if (Object.keys(options).some(key => !permitted.has(key)) ||
        options.apiKey !== undefined ||
        (options.purpose !== undefined && options.purpose !== "sessionCompaction")) {
      fail("unsupported_feature"); return output;
    }
    const cap = options.maxTokens ?? PROVIDER_CONNECTION_OUTPUT_LIMIT;
    if (!Number.isSafeInteger(cap) || cap < 16 || cap > PROVIDER_CONNECTION_OUTPUT_LIMIT) { fail("invalid_request"); return output; }
    const purpose = options.purpose ?? authority.purpose;
    void (async () => {
      try {
        await authority.authorize(purpose);
        if (settled) return;
        if (globalThis.process?.env?.OPENAI_LOG?.trim() !== "off") throw new Error("adapter_disabled");
        // Native Pi preserves both call/item IDs only for its own OpenAI provider. Translate
        // same-authority history for serialization and make every other provenance foreign.
        const native: Model<"openai-responses"> = { ...model, provider: "openai" };
        const scopedContext: Context = { ...context, messages: context.messages.map(message =>
          message.role === "assistant" ? { ...message, provider: message.provider === scope ? "openai" : "foreign-provider-connection" } : message) };
        const transport: FetchFunction = async (input, init) => {
          await authority.authorize(purpose);
          controller.signal.throwIfAborted();
          const request = new Request(input, init);
          if (request.url !== "https://provider-adapter.internal/v1/responses" || request.method !== "POST") throw new Error("invalid_request");
          const envelope: ProviderInferenceRequest = { version: 1, requestId: crypto.randomUUID(), expiresAt,
            ownerId: authority.ownerId, requesterUserId: authority.requesterUserId, workspaceOwnerId: authority.workspaceOwnerId,
            session: authority.session, connectionId: config.connectionId, generation: config.generation,
            transport: config.transport, billing: config.billing, model: config.model, purpose, payload: await request.json() };
          if (settled) throw new Error("cancelled");
          cancelRequest = { version: envelope.version, requestId: envelope.requestId, expiresAt,
            ownerId: envelope.ownerId, requesterUserId: envelope.requesterUserId, workspaceOwnerId: envelope.workspaceOwnerId,
            connectionId: envelope.connectionId, generation: envelope.generation };
          const response = await env.AI_PROVIDER_ADAPTER!.fetch(PROVIDER_INFERENCE_URL, { method: "POST",
            headers: { "content-type": "application/json" }, body: JSON.stringify(envelope), signal: controller.signal });
          if (settled) { void response.body?.cancel().catch(() => {}); throw new Error("cancelled"); }
          handle.lastResponse = { status: response.status };
          if (!response.ok) {
            // Only a fixed code escapes; neither SDK nor provider response diagnostics survive.
            const reader = adapterReader = response.body?.getReader();
            let body = "", bytes = 0;
            try {
              if (reader) for (;;) {
                const chunk = await Promise.race([reader.read(), abortedRead]);
                if (chunk.done) break;
                bytes += chunk.value.byteLength;
                if (bytes > 16384) break;
                body += new TextDecoder().decode(chunk.value);
              }
              const value: unknown = JSON.parse(body);
              if (value && typeof value === "object" && "error" in value && value.error && typeof value.error === "object" && "code" in value.error) code = safeCode(value.error.code);
            } catch { code = "provider_unavailable"; }
            finally { void reader?.cancel().catch(() => {}); }
            throw new Error(code);
          }
          if (response.headers.get("x-plexus-provider-protocol") !== PROVIDER_INFERENCE_PROTOCOL ||
              response.headers.get("content-type")?.split(";")[0].trim() !== "text/event-stream" || !response.body) {
            void response.body?.cancel().catch(() => {});
            code = "stream_incomplete";
            throw new Error(code);
          }
          // AbortSignal alone is not a response-reader cancellation contract across a service
          // binding. Own the reader so cancellation explicitly reaches the credential Worker.
          const reader = adapterReader = response.body.getReader();
          let bytesCancelled = false;
          return new Response(new ReadableStream<Uint8Array>({
            async pull(bytes) {
              try {
                const chunk = await Promise.race([reader.read(), abortedRead]);
                if (bytesCancelled) return;
                if (chunk.done) bytes.close();
                else bytes.enqueue(chunk.value);
              } catch {
                code = "stream_incomplete";
                // Closing owned bytes avoids workerd native iterator rejection diagnostics;
                // Pi's strict EOF check and the owned assistant stream carry the safe failure.
                if (!bytesCancelled) bytes.close();
              }
            },
            async cancel() { bytesCancelled = true; stopReading(); await cleanup(false); },
          }, { highWaterMark: 0 }), { status: response.status, headers: {
            "content-type": "text/event-stream", "x-plexus-provider-protocol": PROVIDER_INFERENCE_PROTOCOL,
          } });
        };
        const source = streamResponses(native, scopedContext, { apiKey: "plexus-private-noncredential-shim",
          fetch: transport, maxRetries: 0, cacheRetention: "none", maxTokens: cap, signal: controller.signal,
          ...(options.thinking === false ? {} : { reasoningEffort: "medium" as const }) });
        for await (const event of source) {
          if (settled) break;
          if (event.type === "error") {
            const category = event.error.errorMessage?.match(/(?:^|\b)(connection_required|reconnect_required|connection_forbidden|model_unavailable|usage_limit|rate_limited|provider_unavailable|invalid_request|unsupported_feature|stream_incomplete|cancelled|adapter_disabled)(?:\b|$)/)?.[1];
            fail(category ? safeCode(category) : code);
          } else {
            if ("partial" in event) event.partial.provider = scope;
            if (event.type === "done") {
              if (event.reason !== "stop" && event.reason !== "toolUse") { fail("stream_incomplete"); break; }
              event.message.provider = scope;
              finish();
              await cleanup(false);
            }
            output.push(event);
          }
        }
        if (!settled) fail("stream_incomplete");
      } catch (error) { fail(controller.signal.aborted ? "cancelled" : safeCode(error instanceof Error ? error.message : undefined)); }
      finally {
        if (terminalTask) await terminalTask;
        else await cleanup(false);
        output.end();
      }
    })();
    return output;
  } };
  return handle;
}

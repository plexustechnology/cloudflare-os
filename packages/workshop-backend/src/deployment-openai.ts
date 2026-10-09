import { z } from "zod";
import { createAssistantMessageEventStream, type AssistantMessage, type FetchFunction,
  type Model } from "@earendil-works/pi-ai";
import { stream as streamCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import type { AiModelConfig } from "@gadgets/workshop-shared/api";
import type { ModelHandle } from "./ai-models.js";
import { zeroUsage } from "./ai-invoke.js";

const schema = z.object({
  model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/),
  name: z.string().min(1).max(96),
  baseUrl: z.string().max(512),
  transport: z.enum(["vpc-service", "https"]),
  contextWindow: z.number().int().min(2048).max(1_048_576),
  outputLimit: z.number().int().min(1).max(8192),
  timeoutMs: z.number().int().min(1000).max(300_000),
  maxConcurrent: z.number().int().min(1).max(4),
  // Optional server-side reasoning budget for reasoning models (vLLM `reasoning_effort`).
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
}).strict().refine(c => c.outputLimit + 1024 < c.contextWindow);

/** Non-secret, deployment-owned descriptor for one private Chat Completions endpoint. */
export type DeploymentOpenAiConfig = z.infer<typeof schema>;

function credential(value: string | undefined): value is string {
  return !!value && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value);
}

/** Absent configuration disables the provider; incomplete configuration fails closed. */
export function readDeploymentOpenAiConfig(env: Cloudflare.Env): DeploymentOpenAiConfig | undefined {
  if (env.OPENAI_COMPATIBLE_CONFIG === undefined) return undefined;
  let input: unknown;
  try { input = JSON.parse(env.OPENAI_COMPATIBLE_CONFIG); }
  catch { throw new Error("Invalid deployment OpenAI-compatible configuration."); }
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid deployment OpenAI-compatible configuration.");
  const config = parsed.data;
  let url: URL;
  try { url = new URL(config.baseUrl); }
  catch { throw new Error("Invalid deployment OpenAI-compatible endpoint."); }
  if (url.href !== config.baseUrl || url.username || url.password || url.search || url.hash ||
      url.pathname !== "/v1" || !["https:", "http:"].includes(url.protocol) ||
      config.transport === "https" && url.protocol !== "https:") {
    throw new Error("Invalid deployment OpenAI-compatible endpoint.");
  }
  if (!credential(env.OPENAI_COMPATIBLE_API_KEY)) {
    throw new Error("Deployment OpenAI-compatible API credential is missing or invalid.");
  }
  if (config.transport === "vpc-service" && typeof env.OPENAI_COMPATIBLE_VPC_SERVICE?.fetch !== "function") {
    throw new Error("Deployment OpenAI-compatible VPC Service binding is missing.");
  }
  const accessId = env.OPENAI_COMPATIBLE_ACCESS_CLIENT_ID;
  const accessSecret = env.OPENAI_COMPATIBLE_ACCESS_CLIENT_SECRET;
  if ((accessId !== undefined || accessSecret !== undefined) &&
      (config.transport !== "https" || !credential(accessId) || !credential(accessSecret))) {
    throw new Error("Invalid deployment OpenAI-compatible Access credentials.");
  }
  return config;
}

/** Server-resolved model reference; no endpoint or credential crosses into user storage. */
export function deploymentOpenAiModelConfig(config: DeploymentOpenAiConfig): AiModelConfig {
  return { provider: "deployment-openai-compatible", model: config.model, apiToken: "",
    contextWindow: config.contextWindow, outputLimit: config.outputLimit };
}

// An isolate-wide fail-fast cap covers all handles, including separate user/Overseer DOs.
// The inference server must also enforce its own global admission limit across Worker isolates.
let inFlight = 0;

// Validate before the SDK: its malformed-SSE diagnostic can log raw provider data.
function completionFrame(frame: string): Uint8Array | undefined {
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:") && !["", "message"].includes(line.slice(6).trim())) {
      throw new Error("Invalid completion event.");
    }
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length) return undefined;
  const payload = data.join("\n");
  if (payload !== "[DONE]") {
    const value: unknown = JSON.parse(payload);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid completion data.");
  }
  return new TextEncoder().encode(`${frame}\n\n`);
}

function failed(model: Model<"openai-completions">, message: string, aborted = false): AssistantMessage {
  return { role: "assistant", content: [], api: model.api, provider: model.provider,
    model: model.id, usage: zeroUsage(), stopReason: aborted ? "aborted" : "error",
    errorMessage: message, timestamp: Date.now() };
}

/** Fixed-origin, credential-owned transport with no retries, redirects, or caller headers. */
export function getDeploymentOpenAiModel(env: Cloudflare.Env, config: AiModelConfig): ModelHandle {
  const deployment = readDeploymentOpenAiConfig(env);
  if (!deployment || config.model !== deployment.model) {
    throw new Error("Deployment OpenAI-compatible model is unavailable.");
  }
  const model: Model<"openai-completions"> = {
    id: deployment.model, name: deployment.name, api: "openai-completions",
    provider: "deployment-openai-compatible", baseUrl: deployment.baseUrl,
    reasoning: false, input: ["text"],
    contextWindow: deployment.contextWindow, maxTokens: deployment.outputLimit,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
      supportsUsageInStreaming: false, supportsStrictMode: false,
      supportsLongCacheRetention: false, sendSessionAffinityHeaders: false,
      maxTokensField: "max_tokens" },
  };
  Object.freeze(model.compat);
  Object.freeze(model);
  const handle: ModelHandle = {
    model,
    stream: (_callerModel, context, options = {}) => {
      handle.lastResponse = undefined;
      const output = createAssistantMessageEventStream();
      const fail = (message: string, aborted = false) => {
        output.push({ type: "error", reason: aborted ? "aborted" : "error", error: failed(model, message, aborted) });
        output.end();
      };
      if (inFlight >= deployment.maxConcurrent) {
        fail("Deployment OpenAI-compatible model is busy.");
        return output;
      }
      const requestedTokens = options.maxTokens ?? deployment.outputLimit;
      if (!Number.isSafeInteger(requestedTokens) || requestedTokens < 1) {
        fail("Invalid deployment OpenAI-compatible output limit.");
        return output;
      }
      const maxTokens = Math.min(requestedTokens, deployment.outputLimit);
      inFlight++;
      const abort = new AbortController();
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", cancelled);
        inFlight--;
      };
      const cancelled = () => {
        abort.abort();
        fail("Deployment OpenAI-compatible request cancelled.", true);
        finish();
      };
      const timer = setTimeout(() => {
        abort.abort();
        fail("Deployment OpenAI-compatible request timed out.");
        finish();
      }, deployment.timeoutMs);
      options.signal?.addEventListener("abort", cancelled, { once: true });
      if (options.signal?.aborted) { cancelled(); return output; }

      const transport: FetchFunction = async (input, init) => {
        const request = new Request(input, init);
        if (request.url !== `${deployment.baseUrl}/chat/completions` || request.method !== "POST") {
          throw new Error("Deployment OpenAI-compatible request target denied.");
        }
        const body = await request.text();
        const payload = JSON.parse(body) as Record<string, unknown>;
        if (payload.model !== deployment.model || payload.stream !== true || payload.max_tokens !== maxTokens) {
          throw new Error("Deployment OpenAI-compatible request parameters denied.");
        }
        // Deployment-owned reasoning budget; never caller-controlled.
        delete payload.reasoning_effort;
        if (deployment.reasoningEffort) payload.reasoning_effort = deployment.reasoningEffort;
        const outgoingBody = JSON.stringify(payload);
        // Conservative byte upper bound plus framing reserve. The origin remains responsible
        // for exact tokenizer/template accounting; never advertise this guard as tokenization.
        if (new TextEncoder().encode(outgoingBody).length > deployment.contextWindow - maxTokens - 1024) {
          throw new Error("Deployment OpenAI-compatible context limit exceeded.");
        }
        const headers = new Headers({ "content-type": "application/json", accept: "text/event-stream",
          authorization: `Bearer ${env.OPENAI_COMPATIBLE_API_KEY}` });
        if (env.OPENAI_COMPATIBLE_ACCESS_CLIENT_ID && env.OPENAI_COMPATIBLE_ACCESS_CLIENT_SECRET) {
          headers.set("cf-access-client-id", env.OPENAI_COMPATIBLE_ACCESS_CLIENT_ID);
          headers.set("cf-access-client-secret", env.OPENAI_COMPATIBLE_ACCESS_CLIENT_SECRET);
        }
        let response: Response;
        try {
          const outgoing = new Request(request.url, { method: "POST", body: outgoingBody, headers,
            redirect: "manual", signal: abort.signal });
          response = deployment.transport === "vpc-service"
            ? await env.OPENAI_COMPATIBLE_VPC_SERVICE!.fetch(outgoing)
            : await globalThis.fetch(outgoing);
        } catch { throw new Error("Deployment OpenAI-compatible origin unavailable."); }
        handle.lastResponse = { status: response.status };
        if (!response.ok) {
          await response.body?.cancel();
          // Never hand the SDK a provider error body that can echo a prompt or credentials.
          const status = response.status >= 300 && response.status < 400 ? 502 : response.status;
          return Response.json({ error: { message: "Deployment OpenAI-compatible origin rejected request." } }, { status });
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Deployment OpenAI-compatible response missing.");
        // Cancellation may reject closed independently of the handled pending read.
        void reader.closed.catch(() => {});
        if (abort.signal.aborted) { await reader.cancel(); abort.signal.throwIfAborted(); }
        let bytes = 0;
        const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
        let pending = "";
        let closed = false;
        let downstream!: ReadableStreamDefaultController<Uint8Array>;
        const close = () => {
          if (!closed) { closed = true; downstream.close(); }
          abort.signal.removeEventListener("abort", onAbort);
        };
        const onAbort = () => { close(); void reader.cancel().catch(() => {}); };
        abort.signal.addEventListener("abort", onAbort, { once: true });
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { downstream = controller; },
          async pull(controller) {
            try {
              while (true) {
                if (closed) return;
                abort.signal.throwIfAborted();
                const chunk = await reader.read();
                if (closed) return;
                bytes += chunk.value?.byteLength ?? 0;
                if (bytes > 2_097_152) throw new Error("Deployment OpenAI-compatible response limit exceeded.");
                pending += decoder.decode(chunk.value, { stream: !chunk.done });
                let sent = false;
                let delimiter: RegExpExecArray | null;
                while ((delimiter = /\r?\n\r?\n/.exec(pending))) {
                  const frame = completionFrame(pending.slice(0, delimiter.index));
                  pending = pending.slice(delimiter.index + delimiter[0].length);
                  if (frame) { controller.enqueue(frame); sent = true; }
                }
                if (chunk.done) {
                  if (pending.trim()) {
                    const frame = completionFrame(pending);
                    if (frame) controller.enqueue(frame);
                  }
                  close();
                  return;
                }
                if (sent) return;
              }
            } catch {
              // Terminate the owned event stream before closing bytes. Erroring a
              // workerd Response body can leave its native iterator rejection unhandled.
              if (!settled) { finish(); fail("Deployment OpenAI-compatible response interrupted."); }
              close();
              await reader.cancel().catch(() => {});
            }
          },
          async cancel() {
            closed = true;
            abort.signal.removeEventListener("abort", onAbort);
            await reader.cancel().catch(() => {});
          },
        }), { headers: { "content-type": "text/event-stream" } });
      };
      const source = streamCompletions(model, context, {
        apiKey: "unused", maxTokens, signal: abort.signal, fetch: transport,
        maxRetries: 0, timeoutMs: deployment.timeoutMs, cacheRetention: "none",
      });
      void (async () => {
        try {
          for await (const event of source) {
            if (settled) break;
            if (event.type === "error") {
              const status = handle.lastResponse?.status;
              finish();
              fail(`${status ? `${status} ` : ""}Deployment OpenAI-compatible request failed.`);
            } else {
              // result() resolves on the terminal event: release admission before its caller
              // can immediately start the next tool step.
              if (event.type === "done") finish();
              output.push(event);
            }
          }
        } catch { if (!settled) fail("Deployment OpenAI-compatible request failed."); }
        finally { finish(); output.end(); }
      })();
      return output;
    },
  };
  return handle;
}

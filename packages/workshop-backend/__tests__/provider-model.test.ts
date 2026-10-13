import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import type { AiConnectionModelConfig } from "@gadgets/workshop-shared/api";
import { PROVIDER_INFERENCE_PROTOCOL, PROVIDER_INFERENCE_URL, type ProviderInferenceRequest } from "@gadgets/workshop-shared/provider-inference";
import { getModel } from "../src/ai-models.js";
import { getProviderConnectionModel, type ProviderModelAuthority } from "../src/provider-model.js";
import { getModelTokenLimits } from "../src/agent-compaction.js";
import { completeText } from "../src/ai-invoke.js";

const config: AiConnectionModelConfig = { provider: "provider-connection", connectionId: "79a6ad29-95e1-447e-b35d-e19f21e9be48",
  generation: 1, model: "fixture-model", transport: "openai-api-responses", billing: "openai-platform-api" };
const context: Context = { systemPrompt: "Synthetic instruction", messages: [{ role: "user", content: "Synthetic request", timestamp: 1 }],
  tools: [{ name: "syntheticTool", description: "Fixture", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }] };
const ownerId = "a".repeat(64);
function authority(): ProviderModelAuthority {
  return { ownerId, requesterUserId: ownerId, workspaceOwnerId: ownerId, purpose: "ownerInteractive",
    session: { workspaceId: "b".repeat(64), chatId: 0, turnId: crypto.randomUUID() }, authorize: vi.fn(async () => {}) };
}
function terminal(output: unknown[], status = "completed") {
  return { type: "response.completed", response: { id: "resp_fixture", status, output,
    usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } } };
}
function textFrames(terminalStatus = "completed"): unknown[] {
  const item = { type: "message", id: "msg_fixture", role: "assistant", phase: "final_answer",
    content: [{ type: "output_text", text: "Fixture answer", annotations: [] }] };
  return [{ type: "response.created", response: { id: "resp_fixture" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", output_index: 0, delta: "Fixture answer" },
    { type: "response.output_item.done", output_index: 0, item }, terminal([item], terminalStatus)];
}
function toolFrames(): unknown[] {
  const reasoning = { type: "reasoning", id: "rs_fixture", summary: [{ type: "summary_text", text: "Synthetic reasoning" }], encrypted_content: "fixture-opaque" };
  const call = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "syntheticTool", arguments: '{"value":"fixture"}' };
  return [{ type: "response.output_item.added", output_index: 0, item: { ...reasoning, summary: [] } },
    { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "Synthetic reasoning" },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 1, delta: call.arguments },
    { type: "response.output_item.done", output_index: 1, item: call }, terminal([reasoning, call])];
}
function response(frames: unknown[], marker = PROVIDER_INFERENCE_PROTOCOL) {
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream", "x-plexus-provider-protocol": marker } });
}
function fixture(frames = textFrames()) {
  const captured: ProviderInferenceRequest[] = [];
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(url, init);
    expect(request.url).toBe(PROVIDER_INFERENCE_URL);
    expect([...request.headers.keys()]).toEqual(["content-type"]);
    captured.push(await request.json() as ProviderInferenceRequest);
    return response(frames);
  });
  return { captured, fetch, env: { AI_PROVIDER_ADAPTER: { fetch } } as Cloudflare.Env };
}

beforeEach(() => { vi.stubEnv("OPENAI_LOG", "off"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("locked personal Responses handle", () => {
  it("uses the fixed private envelope before gateway routing and preserves instructions", async () => {
    const f = fixture();
    const auth = authority();
    const handle = getModel({ ...f.env, CF_AI_GATEWAY: "would-be-invalid" }, config,
      { type: "user", id: "display-profile", name: "Owner" }, { connection: auth, userGateway: { accountId: "ignored", apiKey: "ignored" } });
    expect((await handle.stream(handle.model, context).result()).stopReason).toBe("stop");
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(handle.aiGatewayLogRoute).toBeUndefined();
    expect(f.captured[0]).toMatchObject({ version: 1, ownerId, requesterUserId: ownerId, workspaceOwnerId: ownerId,
      connectionId: config.connectionId, generation: 1, purpose: "ownerInteractive", model: config.model, session: auth.session });
    expect(f.captured[0].payload).toMatchObject({ stream: true, store: false, max_output_tokens: 4096,
      input: expect.arrayContaining([{ role: "developer", content: context.systemPrompt }]) });
    expect(JSON.stringify(f.captured)).not.toContain("plexus-private-noncredential-shim");
    expect(f.captured[0].payload).not.toHaveProperty("prompt_cache_key");
    expect(getModelTokenLimits(config)).toEqual({ inputBudget: 28672, maxOutputTokens: 4096 });
  });

  it("requires diagnostics off and rejects transport or payload overrides before SDK/fetch", async () => {
    const f = fixture();
    const handle = getProviderConnectionModel(f.env, config, authority());
    vi.stubEnv("OPENAI_LOG", "debug");
    expect((await handle.stream(handle.model, context).result()).errorMessage).toBe("adapter_disabled");
    vi.stubEnv("OPENAI_LOG", "off");
    for (const options of [{ fetch: f.fetch }, { headers: { authorization: "injected" } }, { samplingParams: { store: true } }, { maxRetries: 2 }]) {
      expect((await handle.stream(handle.model, context, options).result()).errorMessage).toBe("unsupported_feature");
    }
    expect(f.fetch).not.toHaveBeenCalled();
    expect(() => getModel(f.env, config, { type: "gadget", id: ownerId, name: "Gadget" })).toThrow("connection_forbidden");
  });

  it("rechecks effective diagnostics after asynchronous authority resolution", async () => {
    const f = fixture();
    const auth = authority();
    auth.authorize = async () => { vi.stubEnv("OPENAI_LOG", "debug"); };
    const handle = getProviderConnectionModel(f.env, config, auth);
    expect((await handle.stream(handle.model, context).result()).errorMessage).toBe("adapter_disabled");
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("preserves call/result IDs and scopes opaque reasoning across connection generations and models", async () => {
    const first = fixture(toolFrames());
    const handle = getProviderConnectionModel(first.env, config, authority());
    const message = await handle.stream(handle.model, context).result();
    expect(message.stopReason).toBe("toolUse");
    expect(message.provider).toBe(`provider-connection/${config.connectionId}/1`);
    expect(message.content).toContainEqual({ type: "toolCall", id: "call_fixture|fc_fixture", name: "syntheticTool", arguments: { value: "fixture" } });
    const replay: Context = { ...context, messages: [...context.messages, message,
      { role: "toolResult", toolCallId: "call_fixture|fc_fixture", toolName: "syntheticTool", content: [{ type: "text", text: "Fixture result" }], isError: false, timestamp: 2 }] };
    const before = structuredClone(replay);
    for (const changed of [config, { ...config, generation: 2 }, { ...config, model: "other-model" }]) {
      const next = fixture();
      const h = getProviderConnectionModel(next.env, changed, authority());
      await h.stream(h.model, replay).result();
      const serialized = JSON.stringify(next.captured[0].payload);
      expect(serialized.includes("fixture-opaque")).toBe(changed.generation === 1 && changed.model === config.model);
      if (changed === config) {
        expect(next.captured[0].payload).toMatchObject({ input: expect.arrayContaining([
          expect.objectContaining({ type: "function_call", call_id: "call_fixture", id: "fc_fixture" }),
          expect.objectContaining({ type: "function_call_output", call_id: "call_fixture" }),
        ]) });
      }
    }
    expect(replay).toEqual(before);
  });

  it("uses the same session for compaction and surfaces consent denial without alternate inference", async () => {
    const f = fixture();
    const auth = authority();
    const handle = getProviderConnectionModel(f.env, config, auth);
    await completeText(handle, { prompt: "Synthetic summary", purpose: "sessionCompaction" });
    expect(f.captured[0]).toMatchObject({ purpose: "sessionCompaction", session: auth.session, connectionId: config.connectionId });
    auth.authorize = async () => { throw new Error("connection_forbidden"); };
    await expect(completeText(handle, { prompt: "Synthetic summary", purpose: "sessionCompaction" })).rejects.toThrow("connection_forbidden");
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed on protocol, EOF and safe HTTP errors without retry or diagnostic leakage", async () => {
    for (const reply of [response(textFrames(), "unknown"), response(textFrames().slice(0, -1)),
      Response.json({ error: { code: "rate_limited", message: "PRIVATE_BODY" } }, { status: 429 })]) {
      const fetch = vi.fn(async () => reply);
      const handle = getProviderConnectionModel({ AI_PROVIDER_ADAPTER: { fetch } } as Cloudflare.Env, config, authority());
      const result = await handle.stream(handle.model, context).result();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).not.toContain("PRIVATE_BODY");
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("settles user cancellation even when private fetch ignores abort", async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    const handle = getProviderConnectionModel({ AI_PROVIDER_ADAPTER: { fetch } } as Cloudflare.Env, config, authority());
    const cancel = new AbortController();
    const stream = handle.stream(handle.model, context, { signal: cancel.signal });
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(1); });
    cancel.abort();
    expect((await stream.result()).stopReason).toBe("aborted");
  });

  it("explicitly cancels the adapter reader after user cancellation", async () => {
    const readerCancelled = vi.fn();
    const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      cancel: readerCancelled,
    }), { headers: { "content-type": "text/event-stream", "x-plexus-provider-protocol": PROVIDER_INFERENCE_PROTOCOL } }));
    const handle = getProviderConnectionModel({ AI_PROVIDER_ADAPTER: { fetch } } as Cloudflare.Env, config, authority());
    const cancel = new AbortController();
    const stream = handle.stream(handle.model, context, { signal: cancel.signal });
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(1); });
    cancel.abort();
    expect((await stream.result()).stopReason).toBe("aborted");
    await vi.waitFor(() => { expect(readerCancelled).toHaveBeenCalledTimes(1); });
  });
});

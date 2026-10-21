import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { Context } from "@earendil-works/pi-ai";
import type { AiConnectionModelConfig } from "@gadgets/workshop-shared/api";
import { PROVIDER_INFERENCE_PROTOCOL, type ProviderInferenceRequest } from "@gadgets/workshop-shared/provider-inference";
import { getProviderConnectionModel, type ProviderModelAuthority } from "../../src/provider-model.js";
import { validateInference } from "../../../../../packages/ai-provider-adapter/src/inference-request";
import { inferencePolicy, providerResponse, textEvents, toolEvents } from "../../../../../packages/ai-provider-adapter/src/fixtures/inference";

const owner = "a".repeat(64);
const config: AiConnectionModelConfig = { provider: "provider-connection", connectionId: "79a6ad29-95e1-447e-b35d-e19f21e9be48",
  generation: 1, model: "fixture-model", transport: "openai-api-responses", billing: "openai-platform-api" };
const authority: ProviderModelAuthority = { ownerId: owner, requesterUserId: owner, workspaceOwnerId: owner,
  purpose: "ownerInteractive", session: { workspaceId: "b".repeat(64), chatId: 0, turnId: "1bda112e-4a91-4500-86ba-5ff281f2d421" }, authorize: async () => {} };
beforeEach(() => { vi.stubEnv("OPENAI_LOG", "off"); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("QA pinned serializer compatibility with the strict production input validator", () => {
  it("preserves instructions, scoped opaque reasoning, two-part call IDs and 1MiB input/tool-result images without mutating context", async () => {
    const captured: ProviderInferenceRequest[] = [];
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const envelope = await new Request(url, init).json() as ProviderInferenceRequest;
      validateInference(envelope, inferencePolicy()); captured.push(envelope);
      const upstream = providerResponse(captured.length === 1 ? toolEvents() : textEvents(), 256).response;
      return new Response(upstream.body, { headers: { "content-type": "text/event-stream", "x-plexus-provider-protocol": PROVIDER_INFERENCE_PROTOCOL } });
    });
    const handle = getProviderConnectionModel({ ...env, AI_PROVIDER_ADAPTER: { fetch: fetcher } }, config, authority);
    const rawImage = new Uint8Array(1024 * 1024);
    rawImage.set([0x89, 0x50, 0x4e, 0x47]);
    const imageData = rawImage.toBase64();
    const context: Context = { systemPrompt: "QA instruction role sentinel", messages: [{ role: "user", timestamp: 1,
      content: [{ type: "text", text: "QA request" }, { type: "image", mimeType: "image/png", data: imageData }] }],
      tools: [{ name: "fixtureTool", description: "QA fixture", parameters: { type: "object", properties: { value: { type: "string" } } } }] };
    const first = await handle.stream(handle.model, context).result();
    expect(first.stopReason).toBe("toolUse");
    const replay: Context = { ...context, messages: [...context.messages, first, { role: "toolResult", toolName: "fixtureTool",
      toolCallId: "call_fixture|fc_fixture", timestamp: 2, isError: false,
      content: [{ type: "text", text: "QA result" }, { type: "image", mimeType: "image/png", data: imageData }] }] };
    const original = structuredClone(replay);
    expect((await handle.stream(handle.model, replay).result()).stopReason).toBe("stop");
    const payload = captured[1].payload as { input: Record<string, unknown>[] };
    expect(payload.input).toContainEqual({ role: "developer", content: context.systemPrompt });
    expect(payload.input.find(item => item.type === "function_call")).toMatchObject({ call_id: "call_fixture", id: "fc_fixture" });
    expect(payload.input.find(item => item.type === "function_call_output")).toMatchObject({ call_id: "call_fixture" });
    expect(JSON.stringify(payload)).toContain("synthetic-opaque");
    expect(JSON.stringify(payload).match(/data:image\/png;base64,/g)).toHaveLength(2);
    const encodedBytes = new TextEncoder().encode(JSON.stringify(captured[1])).byteLength;
    expect(imageData.length).toBe(1398104);
    expect(encodedBytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(encodedBytes).toBeLessThan(inferencePolicy().limits.maxInputBytes);
    expect(replay).toEqual(original);
  });

  it("SDK diagnostic debug mode fails before context serialization or any network/log content exposure", async () => {
    const logs: unknown[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation((...args) => { logs.push(args); });
    const fetcher = vi.fn(async () => { throw new Error("QA must not issue"); });
    const handle = getProviderConnectionModel({ ...env, AI_PROVIDER_ADAPTER: { fetch: fetcher } }, config, authority);
    vi.stubEnv("OPENAI_LOG", "debug");
    const result = await handle.stream(handle.model, { systemPrompt: "QA_PRIVATE_SDK_PROMPT",
      messages: [{ role: "user", content: "QA_PRIVATE_SDK_BODY", timestamp: 1 }] }).result();
    expect(result.errorMessage).toBe("adapter_disabled"); expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(logs)).not.toContain("QA_PRIVATE_SDK_PROMPT");
    expect(JSON.stringify(logs)).not.toContain("QA_PRIVATE_SDK_BODY");
  });
});

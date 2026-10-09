import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SUGGESTED_MODELS, type AiModelConfig } from "@gadgets/workshop-shared/api";
import { getModel } from "../src/ai-models.js";
import { completeText, zeroUsage } from "../src/ai-invoke.js";
import { getAiGatewayConfig } from "../src/ai-gateway.js";
import { getModelTokenLimits } from "../src/agent-compaction.js";
import { readDeploymentOpenAiConfig } from "../src/deployment-openai.js";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv { TEST_USER: DurableObjectNamespace<UserDurableObject>; }
}

const descriptor = { model: "synthetic-model", name: "Synthetic private model", baseUrl: "https://inference.example.test/v1",
  transport: "vpc-service", contextWindow: 65536, outputLimit: 4096, timeoutMs: 1000, maxConcurrent: 1 };
const reference: AiModelConfig = { provider: "deployment-openai-compatible", model: descriptor.model, apiToken: "caller-secret",
  apiUrl: "https://untrusted.example.test/v1", contextWindow: 1_000_000, outputLimit: 1_000_000 };
const author = { type: "user" as const, id: "synthetic-user", name: "Synthetic user" };
const azureModel = Object.keys(SUGGESTED_MODELS["azure-foundry"])[0];
const context = { systemPrompt: "Synthetic system prompt", messages: [{ role: "user" as const, content: "Synthetic question", timestamp: 0 }] };

function sse(deltas: unknown[], finish = "stop") {
  const chunks = [...deltas.map(delta => ({ id: "synthetic-response", choices: [{ index: 0, delta, finish_reason: null }] })),
    { choices: [{ index: 0, delta: {}, finish_reason: finish }] }];
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } });
}
function environment(fetcher = vi.fn(async (_request: Request) => sse([{ content: "Synthetic answer" }])),
    overrides: Partial<Cloudflare.Env> = {}) {
  return { CF_AI_GATEWAY: "synthetic-gateway", CF_AI_GATEWAY_ACCOUNT_ID: "synthetic-account",
    CF_AI_GATEWAY_PROVIDERS: "cloudflare", CF_AI_GATEWAY_API_TOKEN: "synthetic-gateway-key",
    AZURE_FOUNDRY_ENDPOINT: "https://azure.example.test/openai/v1", AZURE_FOUNDRY_MODEL: azureModel,
    AZURE_FOUNDRY_API_KEY: "synthetic-azure-key", OPENAI_COMPATIBLE_CONFIG: JSON.stringify(descriptor),
    OPENAI_COMPATIBLE_API_KEY: "synthetic-origin-key", OPENAI_COMPATIBLE_VPC_SERVICE: { fetch: fetcher },
    ...overrides } as Cloudflare.Env;
}

describe("deployment-owned OpenAI-compatible inference", () => {
  it("is disabled by default, appends to the catalog and never displaces Azure or quick defaults", () => {
    const off = environment(undefined, { OPENAI_COMPATIBLE_CONFIG: undefined });
    expect(readDeploymentOpenAiConfig(off)).toBeUndefined();
    const before = getAiGatewayConfig(off)!;
    const after = getAiGatewayConfig(environment())!;
    expect(after.getModelList().slice(0, -1)).toEqual(before.getModelList());
    expect(after.getQuickModelConfig()).toEqual(before.getQuickModelConfig());
    expect(after.resolveModel(azureModel)).toEqual(before.resolveModel(azureModel));
    expect(() => getModel(off, reference, author)).toThrow("unavailable");
    const resolved = after.resolveModel(`deployment-openai-compatible/${descriptor.model}`)!;
    expect(JSON.stringify(resolved.config)).not.toMatch(/synthetic-origin|inference\.example|caller-secret/);
    expect(getModelTokenLimits(resolved.config)).toEqual({ inputBudget: 61440, maxOutputTokens: 4096 });
  });

  it("completes a plain response and streams text using the real pi adapter", async () => {
    const fetcher = vi.fn(async (_request: Request) => sse([{ content: "Synthetic " }, { content: "answer" }]));
    const handle = getModel(environment(fetcher), reference, author);
    const events = [];
    const stream = handle.stream({ ...handle.model, baseUrl: "https://untrusted.example.test" }, context);
    for await (const event of stream) events.push(event);
    expect(events.filter(event => event.type === "text_delta").map(event => event.delta)).toEqual(["Synthetic ", "answer"]);
    expect((await stream.result()).stopReason).toBe("stop");
    expect(await completeText(handle, { prompt: "Synthetic question" })).toBe("Synthetic answer");
    expect(handle.model.contextWindow).toBe(65536);
    expect(handle.aiGatewayLogRoute).toBeUndefined();
  });

  it("preserves function tool calls and tool-result replay without granting connector authority", async () => {
    const fetcher = vi.fn(async (_request: Request) => sse([
      { tool_calls: [{ index: 0, id: "call_synthetic", type: "function", function: { name: "syntheticTool", arguments: '{"value":' } }] },
      { tool_calls: [{ index: 0, function: { arguments: '7}' } }] },
    ], "tool_calls"));
    const handle = getModel(environment(fetcher), reference, author);
    const stream = handle.stream(handle.model, { ...context,
      tools: [{ name: "syntheticTool", description: "Synthetic tool", parameters: { type: "object", properties: { value: { type: "number" } } } }] });
    const result = await stream.result();
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toContainEqual({ type: "toolCall", id: "call_synthetic", name: "syntheticTool", arguments: { value: 7 } });
    fetcher.mockImplementationOnce(async request => {
      const payload = await request.json() as { messages: Array<{ role: string; tool_call_id?: string }> };
      expect(payload.messages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "call_synthetic" }));
      return sse([{ content: "Synthetic tool complete" }]);
    });
    const replay = handle.stream(handle.model, { ...context, messages: [...context.messages,
      { ...result, usage: zeroUsage() }, { role: "toolResult", toolCallId: "call_synthetic", toolName: "syntheticTool",
        content: [{ type: "text", text: "Synthetic result" }], isError: false, timestamp: 1 }] });
    expect((await replay.result()).stopReason).toBe("stop");
  });

  it("owns URL, model, fetch and all headers; caps output and suppresses unsupported fields", async () => {
    const forbiddenFetch = vi.fn();
    const fetcher = vi.fn(async request => {
      expect(request.url).toBe(`${descriptor.baseUrl}/chat/completions`);
      expect(request.redirect).toBe("manual");
      expect([...request.headers.keys()].toSorted()).toEqual(["accept", "authorization", "content-type"]);
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-origin-key");
      const payload = await request.json() as Record<string, unknown>;
      expect(payload.model).toBe(descriptor.model);
      expect(payload.max_tokens).toBe(4096);
      expect(payload.stream).toBe(true);
      for (const key of ["store", "reasoning_effort", "stream_options", "max_completion_tokens", "prompt_cache_key"]) expect(payload).not.toHaveProperty(key);
      expect(payload.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "system" })]));
      return sse([{ content: "Synthetic answer" }]);
    });
    const handle = getModel(environment(fetcher), reference, author, { userGateway: { accountId: "caller-account", apiKey: "caller-key" } });
    const result = await handle.stream({ ...handle.model, id: "wrong-model" }, context,
      { maxTokens: 1_000_000, fetch: forbiddenFetch, headers: { cookie: "caller-cookie", "cf-access-jwt-assertion": "caller-jwt",
        authorization: "caller-auth", "api-key": "caller-azure", "cf-aig-authorization": "caller-gateway" } }).result();
    expect(result.stopReason).toBe("stop");
    expect(forbiddenFetch).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 429, 500, 503, 302])("sanitizes HTTP %i without retry, redirect or paid fallback", async status => {
    const fetcher = vi.fn(async (_request: Request) => new Response("SYNTHETIC_PRIVATE_ECHO", { status,
      headers: { location: "https://untrusted.example.test/admin" } }));
    const handle = getModel(environment(fetcher), reference, author);
    const result = await handle.stream(handle.model, context, { maxRetries: 9 }).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).not.toContain("SYNTHETIC_PRIVATE_ECHO");
    expect(handle.lastResponse?.status).toBe(status);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses only backend credentials over the fixed HTTPS route", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const request = new Request(input);
      expect(request.url).toBe(`${descriptor.baseUrl}/chat/completions`);
      expect(request.headers.get("cf-access-client-id")).toBe("synthetic-access-id");
      expect(request.headers.get("cf-access-client-secret")).toBe("synthetic-access-secret");
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-origin-key");
      expect(request.headers.get("cookie")).toBeNull();
      expect(request.headers.get("cf-access-jwt-assertion")).toBeNull();
      return sse([{ content: "Synthetic HTTPS answer" }]);
    });
    try {
      const runtime = environment(undefined, { OPENAI_COMPATIBLE_CONFIG: JSON.stringify({ ...descriptor, transport: "https" }),
        OPENAI_COMPATIBLE_VPC_SERVICE: undefined, OPENAI_COMPATIBLE_ACCESS_CLIENT_ID: "synthetic-access-id",
        OPENAI_COMPATIBLE_ACCESS_CLIENT_SECRET: "synthetic-access-secret" });
      const handle = getModel(runtime, reference, author);
      expect(await completeText(handle, { prompt: "Synthetic question" })).toBe("Synthetic HTTPS answer");
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { fetcher.mockRestore(); }
  });

  it("bounds a malicious response and sanitizes malformed stream data", async () => {
    const fetcher = vi.fn(async (_request: Request) => new Response("x".repeat(2_097_153),
      { headers: { "content-type": "text/event-stream" } }));
    const handle = getModel(environment(fetcher), reference, author);
    expect((await handle.stream(handle.model, context).result()).stopReason).toBe("error");
    fetcher.mockImplementationOnce(async () => new Response("data: SYNTHETIC_PRIVATE_ECHO\n\n",
      { headers: { "content-type": "text/event-stream" } }));
    const logging = vi.spyOn(console, "error");
    try {
      const malformed = await handle.stream(handle.model, context).result();
      expect(malformed.stopReason).toBe("error");
      expect(malformed.errorMessage).not.toContain("SYNTHETIC_PRIVATE_ECHO");
      expect(logging).not.toHaveBeenCalled();
    } finally { logging.mockRestore(); }
  });

  it("validates SSE frames across byte boundaries and CRLF without losing Unicode text", async () => {
    const wire = await sse([{ content: "Synthetic 🌈 answer" }]).text();
    const bytes = new TextEncoder().encode(wire.replaceAll("\n", "\r\n"));
    const fetcher = vi.fn(async (_request: Request) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    const handle = getModel(environment(fetcher), reference, author);
    expect(await completeText(handle, { prompt: "Synthetic question" })).toBe("Synthetic 🌈 answer");
  });

  it("rejects oversized context and invalid output limits before calling the origin", async () => {
    const fetcher = vi.fn(async (_request: Request) => sse([]));
    const handle = getModel(environment(fetcher), reference, author);
    const tooLarge = await handle.stream(handle.model, { messages: [{ role: "user", content: "x".repeat(65536), timestamp: 0 }] }).result();
    expect(tooLarge.stopReason).toBe("error");
    for (const maxTokens of [0, -1, NaN, 1.5]) expect((await handle.stream(handle.model, context, { maxTokens }).result()).stopReason).toBe("error");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds concurrency across handles, cancels an active stream and releases its slot", async () => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let request!: Request;
    const fetcher = vi.fn(async incoming => { request = incoming; started(); return new Response(new ReadableStream(),
      { headers: { "content-type": "text/event-stream" } }); });
    const runtime = environment(fetcher);
    const handle = getModel(runtime, reference, author);
    const abort = new AbortController();
    const first = handle.stream(handle.model, context, { signal: abort.signal });
    await ready;
    const other = getModel(runtime, reference, author);
    expect((await other.stream(other.model, context).result()).errorMessage).toContain("busy");
    abort.abort();
    expect((await first.result()).stopReason).toBe("aborted");
    expect(request.signal.aborted).toBe(true);
    fetcher.mockImplementationOnce(async () => sse([{ content: "Synthetic recovered" }]));
    expect(await completeText(other, { prompt: "Synthetic question" })).toBe("Synthetic recovered");
  });

  it("bounds the entire streaming lifetime and sanitizes an outage", async () => {
    const fetcher = vi.fn(async (_request: Request) => new Response(new ReadableStream(),
      { headers: { "content-type": "text/event-stream" } }));
    const handle = getModel(environment(fetcher), reference, author);
    const result = await handle.stream(handle.model, context).result();
    expect(result.errorMessage).toContain("timed out");
    fetcher.mockImplementationOnce(async () => { throw new Error("SYNTHETIC_PRIVATE_SECRET"); });
    const outage = await handle.stream(handle.model, context).result();
    expect(outage.stopReason).toBe("error");
    expect(outage.errorMessage).not.toContain("SYNTHETIC_PRIVATE_SECRET");
  });

  it("rejects malformed configuration, origin paths and incomplete credentials without echoing input", () => {
    for (const patch of [{ baseUrl: "https://user:pass@example.test/v1" }, { baseUrl: "https://example.test/admin" },
      { baseUrl: "https://example.test/v1?secret=SYNTHETIC_PRIVATE" }, { baseUrl: "https://example.test/v1#fragment" },
      { baseUrl: "https://example.test/v1/" }, { contextWindow: 1024 }, { maxConcurrent: 0 }, { extra: "SYNTHETIC_PRIVATE" }]) {
      expect(() => readDeploymentOpenAiConfig(environment(undefined, { OPENAI_COMPATIBLE_CONFIG: JSON.stringify({ ...descriptor, ...patch }) })))
        .toThrow(/^Invalid deployment OpenAI-compatible/);
    }
    for (const overrides of [{ OPENAI_COMPATIBLE_API_KEY: undefined }, { OPENAI_COMPATIBLE_API_KEY: "synthetic\nprivate" },
      { OPENAI_COMPATIBLE_VPC_SERVICE: undefined }, { OPENAI_COMPATIBLE_ACCESS_CLIENT_ID: "incomplete" }]) {
      expect(() => readDeploymentOpenAiConfig(environment(undefined, overrides))).toThrow();
    }
  });

  it("keeps preferences and Teams Azure selection intact and forbids personal replacement after disablement", async () => {
    const user = env.TEST_USER.getByName(`deployment-model-${crypto.randomUUID()}`);
    await user.createAccount("synthetic-model-user", "Synthetic model user", new Uint8Array(32));
    await runInDurableObject(user, async instance => {
      Reflect.set(instance, "env", environment());
      const id = `deployment-openai-compatible/${descriptor.model}`;
      await instance.setPreferredModel(azureModel);
      expect((await instance.getExternalMessageChatContext(id, azureModel)).aiModel?.config.provider).toBe("azure-foundry");
      expect(await instance.getPreferredModel()).toBe(azureModel);
      expect((await instance.getChatContext(id)).aiModel?.config.provider).toBe("deployment-openai-compatible");
      const chatContext = await instance.getChatContext(id);
      expect(chatContext.quickModel).toEqual(chatContext.aiModel?.config);
      await expect(instance.addModel({ type: "agent", id, name: "Synthetic collision" }, { provider: "openai", model: "synthetic", apiToken: "" })).rejects.toThrow("operator");
      await expect(instance.addModel({ type: "agent", id: "another", name: "Synthetic" }, reference)).rejects.toThrow("operator");
      await instance.setPreferredModel(id);
      Reflect.get(instance, "env").OPENAI_COMPATIBLE_CONFIG = undefined;
      await expect(instance.getChatContext(id)).rejects.toThrow("No such model");
      await expect(instance.getExternalMessageChatContext(id)).rejects.toThrow("unavailable");
      await expect(instance.getExternalMessageChatContext(null)).rejects.toThrow("unavailable");
      // A disabled preference must not replace an existing, explicitly selected Azure chat.
      expect((await instance.getExternalMessageChatContext(azureModel)).aiModel?.config.provider).toBe("azure-foundry");
      expect((await instance.getExternalMessageChatContext(null, id)).aiModel).toBeUndefined();
      expect((await instance.getExternalMessageChatContext(null, azureModel)).aiModel?.config.provider).toBe("azure-foundry");
    });
  });
});

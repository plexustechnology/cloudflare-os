import { env } from "cloudflare:workers";
import { runInDurableObject, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { TestProviderUser } from "../fixtures/provider-connections-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv { TEST_PROVIDER_USER: DurableObjectNamespace<TestProviderUser>; }
}
const consent = { billing: "openai-platform-api", ownerInteractive: true, sessionCompaction: false } as const;
const input = { label: "My account", apiKey: "SYNTHETIC_KEY", consent };
function user() { return env.TEST_PROVIDER_USER.getByName(`selection-${crypto.randomUUID()}`); }
async function rejection(owner: DurableObjectStub<TestProviderUser>, operation: (instance: TestProviderUser) => Promise<unknown>) {
  return runInDurableObject(owner, async instance => {
    try { await operation(instance); return "unexpected success"; }
    catch (error) { return String(error); }
  });
}
async function enable(owner: DurableObjectStub<TestProviderUser>) {
  await runInDurableObject(owner, (_instance, state) => { state.storage.kv.put("fixture.inferenceEnabled", true); });
}

describe("explicit owner personal model selection", () => {
  it("reserves a durable key-free cancellation identity before intake", async () => {
    const owner = user();
    const reserved = await owner.reserveProviderConnection({ label: input.label, consent });
    expect(reserved).toMatchObject({ generation: 0, credentialRevision: 0, credentialConfigured: false });
    await evictDurableObject(owner);
    expect((await owner.listProviderConnections())[0]).toEqual(reserved);
    expect((await owner.disconnectProviderConnection(reserved.connectionId)).status).toBe("disabled");
    await expect(rejection(owner, instance => instance.reconnectProviderConnection(reserved.connectionId, 0, input))).resolves.toContain("reconnect_required");
    await runInDurableObject(owner, (_instance, state) => {
      expect(JSON.stringify([...state.storage.kv.list()])).not.toContain(input.apiKey);
    });
  });

  it("constructs a namespaced token-free model from current owner catalog and retains legacy quick choice", async () => {
    const owner = user();
    const created = await owner.createProviderConnection(input);
    await expect(rejection(owner, instance => instance.selectProviderConnectionModel(created.connectionId, created.generation, "fixture-model"))).resolves.toContain("adapter_disabled");
    await enable(owner);
    await owner.addModel({ type: "agent", id: "legacy", name: "Legacy" }, { provider: "openai", model: "legacy", apiToken: "synthetic-legacy" });
    await owner.setQuickModel("legacy");
    const selected = await owner.selectProviderConnectionModel(created.connectionId, created.generation, "fixture-model");
    expect(selected).toEqual({ type: "agent", id: `provider-connection/${created.connectionId}/fixture-model`, name: "fixture-model (My account · OpenAI API billing)" });
    const context = await owner.getChatContext(selected.id);
    expect(context.aiModel?.config).toEqual({ provider: "provider-connection", model: "fixture-model", connectionId: created.connectionId,
      generation: created.generation, transport: "openai-api-responses", billing: "openai-platform-api" });
    expect(context.quickModel).toBeUndefined();
    await runInDurableObject(owner, async instance => {
      Reflect.set(instance, "env", { ...Reflect.get(instance, "env"), CF_AI_GATEWAY: "invalid-unrelated-gateway" });
      expect((await instance.getChatContext(selected.id)).aiModel?.profile).toEqual(selected);
      Reflect.get(instance, "env").CF_AI_GATEWAY = undefined;
    });
    expect(await owner.getQuickModel()).toBe("legacy");
    await expect(rejection(owner, instance => instance.setQuickModel(selected.id))).resolves.toContain("connection_forbidden");
    await expect(rejection(owner, instance => instance.addModel(selected, { provider: "openai", model: "forged", apiToken: "forged" }))).resolves.toContain("explicit provider connection selection");
    await expect(rejection(user(), instance => instance.selectProviderConnectionModel(created.connectionId, created.generation, "fixture-model"))).resolves.toContain("connection_forbidden");
  });

  it("rejects stale catalog, removed models and old generations after reconnect", async () => {
    const owner = user();
    const created = await owner.createProviderConnection(input);
    await enable(owner);
    await expect(rejection(owner, instance => instance.selectProviderConnectionModel(created.connectionId, created.generation, "not-allowed"))).resolves.toContain("invalid_request");
    await runInDurableObject(owner, (_instance, state) => { state.storage.kv.put("fixture.catalogStatus", "stale"); });
    await expect(rejection(owner, instance => instance.selectProviderConnectionModel(created.connectionId, created.generation, "fixture-model"))).resolves.toContain("invalid_request");
    await owner.reconnectProviderConnection(created.connectionId, created.generation, input);
    await expect(rejection(owner, instance => instance.selectProviderConnectionModel(created.connectionId, created.generation, "fixture-model"))).resolves.toContain("reconnect_required");
  });
});

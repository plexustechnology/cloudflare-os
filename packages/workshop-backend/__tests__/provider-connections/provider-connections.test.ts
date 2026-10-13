import { env } from "cloudflare:workers";
import { runInDurableObject, evictDurableObject } from "cloudflare:test";
import { RpcStub } from "capnweb";
import { describe, expect, it } from "vitest";
import type { TestProviderUser } from "../fixtures/provider-connections-worker.js";
import type { UserDurableObject } from "../../src/user.js";
import { ProviderConnectionsApiImpl } from "../../src/provider-connections.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_PROVIDER_USER: DurableObjectNamespace<TestProviderUser>;
    TEST_PROVIDER_DISABLED: DurableObjectNamespace<UserDurableObject>;
  }
}
const input = { label: "Fixture", apiKey: "SYNTHETIC_PRIVATE_CREDENTIAL", consent: {
  billing: "openai-platform-api", ownerInteractive: true, sessionCompaction: false,
} } as const;
async function rejection(stub: DurableObjectStub<TestProviderUser>, operation: (instance: TestProviderUser) => Promise<unknown>) {
  return runInDurableObject(stub, async instance => {
    try { await operation(instance); return "unexpected success"; }
    catch (error) { return String(error); }
  });
}
function user() { return env.TEST_PROVIDER_USER.getByName(`provider-${crypto.randomUUID()}`); }
async function mode(stub: DurableObjectStub<TestProviderUser>, value: string) {
  await runInDurableObject(stub, (_instance, state) => { state.storage.kv.put("fixture.mode", value); });
}

describe("owner-scoped provider controls in workerd", () => {
  it("provides the immutable operator bootstrap identifier while the adapter is absent", async () => {
    const id = env.TEST_PROVIDER_DISABLED.idFromName(`disabled-provider-${crypto.randomUUID()}`);
    const owner = env.TEST_PROVIDER_DISABLED.get(id);
    await owner.createAccount("profile@example.test", "Profile", new Uint8Array(32));
    const ownerId = await owner.getProviderConnectionOwnerId();
    expect(ownerId).toBe(id.toString());
    expect(ownerId).toMatch(/^[0-9a-f]{64}$/);
    expect(ownerId).not.toBe((await owner.whoami()).id);
    expect(await owner.providerConnectionsAvailable()).toBe(false);
    await owner.setOwnDisplayName("Changed profile");
    expect(await owner.getProviderConnectionOwnerId()).toBe(ownerId);
  });

  it("derives authority from the real UserDO id and persists only a sanitized index", async () => {
    const owner = user();
    const created = await owner.createProviderConnection(input);
    expect(await owner.listProviderConnections()).toEqual([created]);
    expect(JSON.stringify(created)).not.toContain(input.apiKey);
    await runInDurableObject(owner, (_instance, state) => {
      const index = JSON.stringify(Array.from(state.storage.kv.list()));
      expect(index).toContain(created.connectionId);
      expect(index).not.toContain(input.apiKey);
      expect(index).not.toContain("apiKey");
    });
    await expect(rejection(user(), instance => instance.getProviderConnectionStatus(created.connectionId))).resolves.toContain("connection_forbidden");
    await expect(rejection(owner, instance => instance.getProviderConnectionStatus(crypto.randomUUID()))).resolves.toContain("connection_forbidden");
    expect((await owner.disconnectProviderConnection(created.connectionId)).credentialConfigured).toBe(false);
  });

  it("keeps a lost pre-write reservation recoverable only by explicit generation-zero action", async () => {
    const owner = user();
    await mode(owner, "lost-before-write");
    await expect(rejection(owner, instance => instance.createProviderConnection(input))).resolves.toContain("provider_unavailable");
    const [reserved] = await owner.listProviderConnections();
    expect(reserved).toMatchObject({ generation: 0, credentialConfigured: false });
    await mode(owner, "normal");
    expect((await owner.reconnectProviderConnection(reserved.connectionId, 0, input)).generation).toBe(1);
    await expect(rejection(owner, instance => instance.reconnectProviderConnection(reserved.connectionId, 0, input))).resolves.toContain("reconnect_required");
  });

  it("does not replay an uncertain create which already stored a credential", async () => {
    const owner = user();
    await mode(owner, "lost-after-write");
    await expect(rejection(owner, instance => instance.createProviderConnection(input))).resolves.toContain("provider_unavailable");
    const [created] = await owner.listProviderConnections();
    expect(created.generation).toBe(1);
    await expect(rejection(owner, instance => instance.reconnectProviderConnection(created.connectionId, 0, input))).resolves.toContain("reconnect_required");
  });

  it("does not reserve slots for invalid intake or disabled policy", async () => {
    const owner = user();
    await expect(rejection(owner, instance => instance.createProviderConnection({ ...input, apiKey: " contains spaces " }))).resolves.toContain("invalid_request");
    expect(await owner.listProviderConnections()).toEqual([]);
    await mode(owner, "disabled");
    expect(await owner.providerConnectionsAvailable()).toBe(false);
    await expect(rejection(owner, instance => instance.createProviderConnection(input))).resolves.toContain("adapter_disabled");
    await mode(owner, "normal");
    expect(await owner.listProviderConnections()).toEqual([]);
  });

  it("rejects malformed persisted index metadata without returning injected credential fields", async () => {
    const owner = user();
    const created = await owner.createProviderConnection(input);
    await runInDurableObject(owner, (_instance, state) => {
      const index = state.storage.kv.get<Array<Record<string, unknown>>>("providerConnections")!;
      index[0].consent = { ...input.consent, injectedCredential: input.apiKey };
      state.storage.kv.put("providerConnections", index);
    });
    const error = await rejection(owner, instance => instance.getProviderConnectionStatus(created.connectionId));
    expect(error).toContain("provider_unavailable");
    expect(error).not.toContain(input.apiKey);
  });

  it("validates the actual narrow Cap'n Web facade without echoing credential-shaped malformed values", async () => {
    const owner = user();
    using facade = new RpcStub(new ProviderConnectionsApiImpl(() => owner));
    const created = await facade.create(input);
    expect(created.generation).toBe(1);
    const catalog = await facade.discover(created.connectionId);
    expect(catalog.status).toBe("fresh");
    expect(catalog.models[0].id).toBe(`provider-connection/${created.connectionId}/fixture-model`);
    expect(catalog.models[0].capabilities.contextWindow).toBeNull();
    try {
      await facade.create({ ...input, consent: { ...input.consent, ownerInteractive: input.apiKey } } as never);
      throw new Error("validation unexpectedly passed");
    } catch (error) {
      expect(String(error)).toContain("capnweb-validate");
      expect(String(error)).not.toContain(input.apiKey);
    }
    await expect((async () => await (Reflect.get(facade, "getUser")()))()).rejects.toThrow();
  });

  it("settles and cancels a private response which stalls after headers", async () => {
    const owner = user();
    await mode(owner, "stalled-body");
    await expect(rejection(owner, instance => instance.providerConnectionsAvailable())).resolves.toContain("provider_unavailable");
    await runInDurableObject(owner, (_instance, state) => {
      expect(state.storage.kv.get("fixture.cancelled")).toBe(true);
    });
  }, 20_000);

  it("accepts bounded percent-encoded selection identifiers for a maximum-length model slug", async () => {
    const owner = user();
    const created = await owner.createProviderConnection(input);
    await mode(owner, "encoded-model");
    const catalog = await owner.discoverProviderConnectionModels(created.connectionId);
    expect(catalog.models[0].model).toHaveLength(128);
    expect(catalog.models[0].id.length).toBeGreaterThan(200);
    expect(catalog.models[0].id.length).toBeLessThanOrEqual(450);
  });
});


describe("independent QA owner index boundaries", () => {
  it("keeps concurrent server-generated reservations across UserDO eviction", async () => {
    const owner = user();
    const created = await Promise.all(Array.from({ length: 8 }, () => owner.createProviderConnection(input)));
    expect(new Set(created.map(value => value.connectionId)).size).toBe(8);
    await evictDurableObject(owner);
    expect(new Set((await owner.listProviderConnections()).map(value => value.connectionId)))
      .toEqual(new Set(created.map(value => value.connectionId)));
  });

  it("bounds the durable owner index to 32 slots without reserving an extra failed write", async () => {
    const owner = user();
    await Promise.all(Array.from({ length: 32 }, () => owner.createProviderConnection(input)));
    await expect(rejection(owner, instance => instance.createProviderConnection(input))).resolves.toContain("invalid_request");
    expect(await owner.listProviderConnections()).toHaveLength(32);
  });

  it("rechecks adapter enablement for a previously minted validated facade", async () => {
    const owner = user();
    using facade = new RpcStub(new ProviderConnectionsApiImpl(() => owner));
    const connection = await facade.create(input);
    await mode(owner, "disabled");
    for (const operation of [() => facade.list(), () => facade.status(connection.connectionId),
      () => facade.disconnect(connection.connectionId), () => facade.discover(connection.connectionId)]) {
      await expect(operation()).rejects.toThrow("adapter_disabled");
    }
  });
});

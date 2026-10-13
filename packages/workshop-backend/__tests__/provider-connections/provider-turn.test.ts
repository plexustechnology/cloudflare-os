import { env } from "cloudflare:workers";
import { runInDurableObject, evictDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestProviderUser } from "../fixtures/provider-connections-worker.js";
import type { OverseerDurableObject } from "../../src/overseer.js";
import { PROVIDER_INFERENCE_PROTOCOL, type ProviderInferenceRequest } from "@gadgets/workshop-shared/provider-inference";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_PROVIDER_USER: DurableObjectNamespace<TestProviderUser>;
    TEST_PROVIDER_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}
const input = { label: "Fixture", apiKey: "SYNTHETIC_KEY", consent: {
  billing: "openai-platform-api", ownerInteractive: true, sessionCompaction: false } } as const;

beforeEach(() => { vi.stubEnv("OPENAI_LOG", "off"); });
afterEach(() => { vi.unstubAllEnvs(); });

async function setup() {
  const owner = env.TEST_PROVIDER_USER.getByName(`turn-owner-${crypto.randomUUID()}`);
  const created = await owner.createProviderConnection(input);
  await runInDurableObject(owner, (_instance, state) => { state.storage.kv.put("fixture.inferenceEnabled", true); });
  const profile = await owner.selectProviderConnectionModel(created.connectionId, created.generation, "fixture-model");
  const context = await owner.getChatContext(profile.id);
  const workspace = env.TEST_PROVIDER_OVERSEER.getByName(`personal-workspace-${crypto.randomUUID()}`);
  return { owner, workspace, context };
}

describe("personal funding through the production Overseer lifecycle", () => {
  it("authorizes actual owner/session before inference and leaves exhausted Cloudflare quota untouched", async () => {
    const { owner, workspace, context } = await setup();
    const observed: ProviderInferenceRequest[] = [];
    await runInDurableObject(workspace, async (instance, state) => {
      const impl = Reflect.get(instance, "impl");
      impl.ownerId = owner.id.toString();
      impl.storage.ownerId.put(owner.id.toString());
      impl.users = env.TEST_PROVIDER_USER;
      impl.env = { ...env, ENABLE_CLOUDFLARE_LIMITS: "true", DAILY_LLM_CALL_LIMIT: "0", AI_PROVIDER_ADAPTER: {
        async fetch(url: RequestInfo | URL, init?: RequestInit) {
          const request = new Request(url, init);
          observed.push(await request.json() as ProviderInferenceRequest);
          const item = { type: "message", id: "msg_fixture", role: "assistant", content: [{ type: "output_text", text: "Fixture answer", annotations: [] }] };
          const events = [{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
            { type: "response.output_text.delta", output_index: 0, delta: "Fixture answer" },
            { type: "response.output_item.done", output_index: 0, item },
            { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }];
          return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
            { headers: { "content-type": "text/event-stream", "x-plexus-provider-protocol": PROVIDER_INFERENCE_PROTOCOL } });
        },
      } };
      impl.storage.chatMeta.put({ id: 0, title: "Fixture", started: new Date(), lastActive: new Date(), activeAgent: context.aiModel!.profile });
      impl.storage.codeVersion.put(1);
      impl.addChatMessages(0, context.profile, [{ type: "message", message: "Synthetic request" }]);
      impl.startAgent(0, context.aiModel, context.profile, owner.id.toString());
      await impl.waitForAllAgentsToComplete();
      expect([...impl.storage.chats.list()].some(message => message.type === "message" && message.message === "Fixture answer")).toBe(true);
      const meta = impl.storage.chatMeta.get(0);
      expect(meta.totalTokens).toBe(12);
      expect(meta.totalCost).toBeUndefined();
      expect(state.storage.kv.get("totalCost")).toBeUndefined();
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ ownerId: owner.id.toString(), requesterUserId: owner.id.toString(), workspaceOwnerId: owner.id.toString(), purpose: "ownerInteractive" });
    expect(observed[0].session.workspaceId).toBe(workspace.id.toString());
    expect((await owner.checkDailyLlmCount(0)).used).toBe(0);
  });

  it("denies a callback or collaborator before private inference or Cloudflare quota", async () => {
    const { owner, workspace, context } = await setup();
    const called = vi.fn(async () => new Response(null, { status: 500 }));
    await runInDurableObject(workspace, async instance => {
      const impl = Reflect.get(instance, "impl");
      impl.ownerId = owner.id.toString();
      impl.storage.ownerId.put(owner.id.toString());
      impl.users = env.TEST_PROVIDER_USER;
      impl.env = { ...env, ENABLE_CLOUDFLARE_LIMITS: "true", DAILY_LLM_CALL_LIMIT: "0", AI_PROVIDER_ADAPTER: { fetch: called } };
      for (const [chatId, initiator, callbacks] of [[0, owner.id.toString(), true], [1, "c".repeat(64), false], [2, owner.id.toString(), false]] as const) {
        if (chatId === 2) (await impl.getSharingManager()).addCollaborator({
          caller: { profileId: context.profile.id, isOwner: true }, profile: { type: "user", id: "collaborator@example.test", name: "Collaborator" }, role: "build",
        });
        impl.storage.chatMeta.put({ id: chatId, title: "Fixture", started: new Date(), lastActive: impl.getChatTimestamp(), activeAgent: context.aiModel!.profile });
        impl.startAgent(chatId, context.aiModel, context.profile, initiator, callbacks);
        await impl.waitForAllAgentsToComplete();
        expect([...impl.storage.chats.list()].filter(message => message.chatId === chatId).some(message => message.type === "error" &&
          message.code === "connection_forbidden" && message.message.includes("unshared chat"))).toBe(true);
      }
    });
    expect(called).not.toHaveBeenCalled();
    expect((await owner.checkDailyLlmCount(0)).used).toBe(0);
  });

  it("fails necessary compaction without consent instead of making an oversized main request", async () => {
    const { owner, workspace, context } = await setup();
    const called = vi.fn(async () => new Response(null, { status: 500 }));
    await runInDurableObject(workspace, async instance => {
      const impl = Reflect.get(instance, "impl");
      impl.ownerId = owner.id.toString();
      impl.storage.ownerId.put(owner.id.toString());
      impl.users = env.TEST_PROVIDER_USER;
      impl.env = { ...env, AI_PROVIDER_ADAPTER: { fetch: called } };
      impl.storage.chatMeta.put({ id: 0, title: "Fixture", started: new Date(), lastActive: new Date(), activeAgent: context.aiModel!.profile });
      impl.addChatMessages(0, context.profile, [{ type: "message", message: "x".repeat(110000) }]);
      impl.addChatMessages(0, context.aiModel!.profile, [{ type: "message", message: "Old synthetic answer" }]);
      impl.addChatMessages(0, context.profile, [{ type: "message", message: "Continue fixture" }]);
      impl.startAgent(0, context.aiModel, context.profile, owner.id.toString());
      await impl.waitForAllAgentsToComplete();
      expect([...impl.storage.chats.list()].some(message => message.type === "error" && message.code === "connection_forbidden" &&
        message.message.includes("Paid context summaries"))).toBe(true);
      expect([...impl.storage.chatCompactions.list()]).toHaveLength(0);
    });
    expect(called).not.toHaveBeenCalled();
  });

  it("terminates a persisted uncertain personal turn on restart without inference replay", async () => {
    const { owner, workspace, context } = await setup();
    await runInDurableObject(workspace, instance => {
      const impl = Reflect.get(instance, "impl");
      impl.storage.ownerId.put(owner.id.toString());
      const personalTurn = { chatId: 0, initiatorUserId: owner.id.toString(), turnId: crypto.randomUUID(),
        purpose: "ownerInteractive", fromSequence: 0, config: context.aiModel!.config, state: "running" };
      impl.storage.personalTurns.put(personalTurn);
      impl.storage.chatMeta.put({ id: 0, title: "Fixture", started: new Date(), lastActive: new Date(), activeAgent: context.aiModel!.profile });
      impl.storage.activeAgents.put({ chatId: 0, initiatorUserId: owner.id.toString(), modelId: context.aiModel!.profile.id,
        initiator: context.profile, callbackInitiated: false, personalTurn });
    });
    await evictDurableObject(workspace);
    await runInDurableObject(workspace, instance => {
      const impl = Reflect.get(instance, "impl");
      expect(impl.storage.activeAgents.get(0)).toBeUndefined();
      expect(impl.storage.chatMeta.get(0).activeAgent).toBeUndefined();
      expect(impl.storage.personalTurns.get(0).state).toBe("recovery-required");
      expect([...impl.storage.chats.list()].some(message => message.type === "error" && message.code === "reconnect_required")).toBe(true);
    });
  });
});

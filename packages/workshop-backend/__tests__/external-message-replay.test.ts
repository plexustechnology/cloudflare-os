import { env, RpcStub, RpcTarget } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { AiChatAuthorInfo, AiChatMetadata } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { ChatGatewayRpcTarget, GadgetResponse } from
  "@gadgets/workshop-shared/external-message-gateway";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const author: AiChatAuthorInfo = { type: "user", id: "caller", name: "Caller" };
const activeAgent: AiChatAuthorInfo = { type: "agent", id: "model", name: "Model" };

async function withDeliveredReplay(
    run: (impl: ReturnType<typeof Reflect.get>) => Promise<void>): Promise<void> {
  const stub = env.TEST_OVERSEER.getByName(`external-replay-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async instance => {
    // Access the real helper and typed storage inside its DO, without introducing a test-only RPC.
    const impl = Reflect.get(instance, "impl");
    const meta: AiChatMetadata = {
      id: 7,
      title: "Existing chat",
      started: new Date(0),
      lastActive: new Date(0),
      activeAgent,
    };
    impl.storage.chatMeta.put(meta);
    impl.storage.gadgetResponseDeliveries.put({
      idempotencyKey: "message-key",
      chatId: 7,
      promptSequence: 0,
      createdAt: Date.now(),
      status: "delivered",
      deliveredAt: Date.now(),
    });
    await run(impl);
    expect(impl.storage.chatMeta.get(7)).toEqual(meta);
    expect([...impl.storage.chats.list()]).toEqual([]);
    expect(impl.storage.gadgetResponseDeliveries.get("message-key")?.status).toBe("delivered");
  });
}

const caller = { id: { toString: () => "caller-id" } };
const userMeta = { profile: author };
const registration = { idempotencyKey: "message-key", chatGatewayRpcTarget: {} };

describe("external message response-target replay", () => {
  it("returns an owner replay in an active chat without reserving or writing", async () => {
    await withDeliveredReplay(async impl => {
      const reserve = vi.spyOn(impl, "reserveChatMessagePreparation");

      await impl.sendChatMessage(caller, userMeta, 7, "retry", undefined, undefined, registration);

      expect(reserve).not.toHaveBeenCalled();
    });
  });

  it("runs a collaborator guard before replay in an active chat without reserving", async () => {
    await withDeliveredReplay(async impl => {
      const reserve = vi.spyOn(impl, "reserveChatMessagePreparation");
      const guard = vi.fn();

      await impl.sendChatMessage(
        caller, userMeta, 7, "retry", undefined, undefined, registration, undefined, guard,
      );

      expect(guard).toHaveBeenCalledOnce();
      expect(reserve).not.toHaveBeenCalled();
    });
  });

  it("does not touch a replay target or reserve the chat when the guard denies", async () => {
    await withDeliveredReplay(async impl => {
      const reserve = vi.spyOn(impl, "reserveChatMessagePreparation");
      const denied = new Error("access changed");

      await expect(impl.sendChatMessage(
        caller, userMeta, 7, "retry", undefined, undefined, registration, undefined,
        () => { throw denied; },
      )).rejects.toBe(denied);

      expect(reserve).not.toHaveBeenCalled();
    });
  });

  it("returns an owner replay for newChat without allocating another chat", async () => {
    await withDeliveredReplay(async impl => {
      const nextChatId = vi.spyOn(impl, "nextChatId");

      const chatId = await impl.newChat(caller, userMeta, "retry", undefined, undefined,
        registration, "external-chat-key");

      expect(chatId).toBe(7);
      expect(nextChatId).not.toHaveBeenCalled();
    });
  });

  it.each([false, true])("redelivers immutable ready snapshot structured=%s without starting another turn", async structured => {
    const received = vi.fn();
    class ReadyTarget extends RpcTarget implements ChatGatewayRpcTarget {
      async onGadgetResponse(response: GadgetResponse): Promise<void> {
        received(response);
      }
    }

    const stub = env.TEST_OVERSEER.getByName(`ready-replay-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async instance => {
      const impl = Reflect.get(instance, "impl");
      const meta: AiChatMetadata = {
        id: 7, title: "Existing chat", started: new Date(0), lastActive: new Date(0), activeAgent,
      };
      impl.storage.chatMeta.put(meta);
      // A locally constructed RpcStub is not persistable in workerd; keep only this collection's
      // read/write boundary in memory while exercising the real replay and delivery helpers.
      let record = {
        idempotencyKey: "message-key",
        chatId: 7,
        promptSequence: 0,
        createdAt: Date.now(),
        status: "ready",
        chatGatewayRpcTarget: new RpcStub<ChatGatewayRpcTarget>(new ReadyTarget()),
        responseText: "completed",
        ...(structured ? { responseSnapshot: { version: 2, outcome: "action_required", text: "completed",
          actions: ["approval"], sharing: "allowed" } } : {}),
      };
      vi.spyOn(impl.storage.gadgetResponseDeliveries, "get")
        .mockImplementation((key: string) => key === "message-key" ? record : undefined);
      vi.spyOn(impl.storage.gadgetResponseDeliveries, "put")
        .mockImplementation((updated: typeof record) => { record = updated; });
      const reserve = vi.spyOn(impl, "reserveChatMessagePreparation");
      const guard = vi.fn();

      await impl.sendChatMessage(caller, userMeta, 7, "retry", undefined, undefined,
        registration, undefined, guard);

      await vi.waitFor(() => {
        expect(impl.storage.gadgetResponseDeliveries.get("message-key")?.status).toBe("delivered");
      });
      expect(received).toHaveBeenCalledExactlyOnceWith({ text: "completed", ...(structured ? {
        structured: { version: 2, outcome: "action_required", text: "completed", actions: ["approval"], sharing: "allowed" },
      } : {}) });
      expect(guard).toHaveBeenCalledOnce();
      expect(reserve).not.toHaveBeenCalled();
      expect([...impl.storage.chats.list()]).toEqual([]);
      expect(impl.storage.chatMeta.get(7)).toEqual(meta);
    });
  });
});

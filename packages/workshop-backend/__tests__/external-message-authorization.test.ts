import { env, RpcStub, RpcTarget } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { diffFiles } from "@gadgets/workshop-shared/code-change";
import type { GadgetResponse } from "@gadgets/workshop-shared/external-message-gateway";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const callerProfile: AiChatAuthorInfo = { type: "user", id: "caller@example.test", name: "Caller" };
const expectedDenial = {
  accepted: false,
  message: "Open this workspace in the Workshop to verify your access before trying again.",
};
const chatKey = "external-chat";
const privatePrompt = "private external prompt";

class ResponseWitness extends RpcTarget {
  readonly received: GadgetResponse[] = [];
  async onGadgetResponse(response: GadgetResponse): Promise<void> { this.received.push(response); }
}

async function createCaller(allowed = true) {
  const owner = env.TEST_USER.getByName("external-test-owner");
  await owner.createAccount("owner-profile", "Owner", new Uint8Array(32));
  const name = `external-caller-${crypto.randomUUID()}`;
  const user = env.TEST_USER.getByName(name);
  await user.createAccount(callerProfile.id, callerProfile.name, new Uint8Array(32));
  await user.addModel({ type: "agent", id: "test-model", name: "Controlled model" }, {
    provider: "openai", model: "controlled-model", apiToken: "", apiUrl: "https://controlled.invalid",
  });
  const accountId = await runInDurableObject(user, async instance => {
    const ctx = Reflect.get(instance, "ctx");
    const account = ctx.exports.TestObserverAccount({ props: { identity: user.id.toString(), allowed } });
    await instance.linkConnectedAccountFromLogin(account, "test-observer");
    return [...Reflect.get(instance, "storage").connectedAccounts.list()][0].id as number;
  });
  return { name, user, accountId };
}

function installGatekeeper(impl: ReturnType<typeof Reflect.get>, id: number) {
  impl.storage.gatekeepers.put({
    id, resourceTitle: `Controlled source ${id}`,
    class: impl.ctx.exports.TestObserverGatekeeper({ props: { identity: `${impl.ctx.id}:${id}` } }),
    creationSpec: {
      type: "gatekeeper", vendorId: "test-observer", resourceUrl: `https://controlled.example.test/${id}`,
      typeUrlPattern: "https://controlled.example.test/*",
    },
  });
}

function setupWorkspace(impl: ReturnType<typeof Reflect.get>, accountId: number, existing: boolean) {
  impl.ownerId = env.TEST_USER.idFromName("external-test-owner").toString();
  impl.ownerProfileId = "owner-profile";
  impl.storage.collaborators.put({
    profile: callerProfile,
    addedBy: [{ type: "user", sharer: "owner-profile", created: new Date(0), role: "build" }],
  });
  impl.storage.ownerRegistrationPending.put(false);
  installGatekeeper(impl, 1);
  impl.storage.observers.put({ profileId: callerProfile.id, observerId: "controlled-observer", accountChoices: { 1: accountId } });
  impl.storage.chatMeta.put({ id: 7, title: "Existing chat", started: new Date(0), lastActive: new Date(0) });
  if (existing) impl.storage.externalChats.put({ externalChatKey: chatKey, chatId: 7 });
  // Ambient provisioning is separately covered; isolate the external authorization gate here.
  vi.spyOn(impl, "ensureAmbientCapsules").mockResolvedValue(undefined);
}

function input(name: string, target: RpcStub<ResponseWitness>) {
  return {
    callerEmail: name, externalChatKey: chatKey, idempotencyKey: "external-message",
    prompt: privatePrompt, title: "Controlled workspace", chatGatewayRpcTarget: target,
  };
}

function promptState(impl: ReturnType<typeof Reflect.get>) {
  return {
    chatMeta: [...impl.storage.chatMeta.list()], chats: [...impl.storage.chats.list()],
    changes: [...impl.storage.chatChanges.list()], sequences: [...impl.storage.nextChatSequences.list()],
    targets: [...impl.storage.gadgetResponseDeliveries.list()], externalChats: [...impl.storage.externalChats.list()],
    activeAgents: [...impl.storage.activeAgents.list()], callbackArgs: [...impl.storage.agentCallbackArgs.list()],
  };
}

async function seedPendingCodeChange(impl: ReturnType<typeof Reflect.get>) {
  const files = new Map([["app.js", "original\n"]]);
  const commitId = await impl.gitStore.writeFilesAsCommit(files, {
    parents: [], author: { name: "Owner", email: "owner@example.test" }, message: "Initial", timestamp: new Date(0),
  });
  impl.storage.gadgets.put({ id: 1, title: "App", bindingName: "APP", created: new Date(0), bindings: {}, commitId });
  const change = diffFiles(new Map([[1, files]]), new Map([[1, new Map([["app.js", "pending private edit\n"]])]]));
  await impl.submitCodeChange(7, {
    generation: 0, revision: 0, clientId: "controlled", seq: 1, pins: [{ gadgetId: 1, baseCommit: commitId }], change,
  }, callerProfile, impl.ownerId);
  expect(impl.listLiveChatChanges(7, 0)).toHaveLength(1);
}

// Controlled capabilities prove real UserDO lookups/facet RPC, not a vendor's access API.
describe("external collaborator observer authorization", () => {
  it.each(["missing account", "revoked verifier", "new capability"] as const)(
    "denies %s before touching the chat", async scenario => {
      const caller = await createCaller(scenario !== "revoked verifier");
      if (scenario === "missing account") await runInDurableObject(caller.user, instance => {
        Reflect.get(instance, "storage").connectedAccounts.delete(caller.accountId);
      });
      await runInDurableObject(env.TEST_OVERSEER.getByName(`external-precheck-${crypto.randomUUID()}`), async instance => {
        const impl = Reflect.get(instance, "impl");
        setupWorkspace(impl, caller.accountId, true);
        if (scenario === "new capability") installGatekeeper(impl, 2);
        const before = promptState(impl);
        const submit = vi.spyOn(impl, "sendChatMessage");
        const witness = new ResponseWitness();
        using target = new RpcStub(witness);
        expect(await instance.receiveExternalMessage(input(caller.name, target))).toEqual(expectedDenial);
        expect(promptState(impl)).toEqual(before);
        expect(submit).not.toHaveBeenCalled();
        expect(witness.received).toEqual([]);
        expect(await impl.getGatekeeperFacet(1).verificationAttempts()).toBe(scenario === "revoked verifier" ? 1 : 0);
      });
    },
  );

  it("requires the owner to finish registration before a collaborator submits", async () => {
    const caller = await createCaller();
    await runInDurableObject(env.TEST_OVERSEER.getByName(`external-bootstrap-${crypto.randomUUID()}`), async instance => {
      const impl = Reflect.get(instance, "impl");
      setupWorkspace(impl, caller.accountId, false);
      impl.storage.ownerRegistrationPending.put(true);
      const submit = vi.spyOn(impl, "newChat");
      using target = new RpcStub(new ResponseWitness());
      expect(await instance.receiveExternalMessage(input(caller.name, target))).toEqual(expectedDenial);
      expect(impl.storage.ownerRegistrationPending.get()).toBe(true);
      expect(submit).not.toHaveBeenCalled();
    });
  });

  it("rechecks sharing after resolving the model", async () => {
    const caller = await createCaller();
    await runInDurableObject(env.TEST_OVERSEER.getByName(`external-model-${crypto.randomUUID()}`), async instance => {
      const impl = Reflect.get(instance, "impl");
      setupWorkspace(impl, caller.accountId, true);
      const realCaller = impl.users.getByName(caller.name);
      const resolveModel = (model: string | null) => realCaller.getExternalMessageChatContext(model);
      // The real model RPC completes; this local mutation is a deterministic timing hook.
      impl.users = { getByName: () => ({
        id: realCaller.id, whoamiIfExists: () => realCaller.whoamiIfExists(),
        getVerifier: (accountId: number, vendorId: string) => realCaller.getVerifier(accountId, vendorId),
        getExternalMessageChatContext: async (model: string | null) => {
          const result = await resolveModel(model);
          impl.storage.collaborators.delete(callerProfile.id);
          return result;
        },
      }) };
      const before = promptState(impl);
      const submit = vi.spyOn(impl, "sendChatMessage");
      using target = new RpcStub(new ResponseWitness());
      expect(await instance.receiveExternalMessage(input(caller.name, target))).toEqual(expectedDenial);
      expect(promptState(impl)).toEqual(before);
      expect(submit).not.toHaveBeenCalled();
      expect(await impl.getGatekeeperFacet(1).verificationAttempts()).toBe(1);
    });
  });
});

// Each helper reaches #prepareChatMessage's await before the timing hook changes SQLite.
describe.each(["existing", "new"] as const)("external commit guard: %s chat", chatKind => {
  it.each(["sharing", "observer", "account choice", "new capability", "removed capability", "sharing lockdown"] as const)(
    "denies a %s change without prompt, callback, code or agent effects", async mutation => {
      const caller = await createCaller();
      await runInDurableObject(env.TEST_OVERSEER.getByName(`external-commit-${crypto.randomUUID()}`), async instance => {
        const impl = Reflect.get(instance, "impl");
        setupWorkspace(impl, caller.accountId, chatKind === "existing");
        await seedPendingCodeChange(impl);
        const before = promptState(impl);
        const effects = ["registerExternalMessageResponseTarget", "startAgent", "materializeChatChanges", "reserveChatMessagePreparation", "nextChatId"]
          .map(method => vi.spyOn(impl, method));
        const method = chatKind === "existing" ? "sendChatMessage" : "newChat";
        const submit = impl[method].bind(impl);
        vi.spyOn(impl, method).mockImplementation((...args) => {
          const pending = submit(...args);
          switch (mutation) {
            case "sharing": impl.storage.collaborators.delete(callerProfile.id); break;
            case "observer": impl.storage.observers.delete(callerProfile.id); break;
            case "account choice": impl.storage.observers.put({
              profileId: callerProfile.id, observerId: "controlled-observer", accountChoices: { 1: caller.accountId + 1 },
            }); break;
            case "new capability": installGatekeeper(impl, 2); break;
            case "removed capability": impl.storage.gatekeepers.delete(1); break;
            case "sharing lockdown": impl.storage.prohibitAllSharing.put(true); break;
          }
          return pending;
        });
        const witness = new ResponseWitness();
        using target = new RpcStub(witness);
        const result = await instance.receiveExternalMessage(input(caller.name, target));
        expect(result).toEqual(expectedDenial);
        expect(JSON.stringify(result)).not.toContain(privatePrompt);
        expect(promptState(impl)).toEqual(before);
        for (const effect of effects) expect(effect).not.toHaveBeenCalled();
        expect(witness.received).toEqual([]);
        if (mutation !== "removed capability") expect(await impl.getGatekeeperFacet(1).verificationAttempts()).toBe(2);
      });
    },
  );
});

describe("external submission compatibility", () => {
  it.each(["existing", "new"] as const)("commits an authorized collaborator's %s chat with its response target", async kind => {
    const caller = await createCaller();
    await runInDurableObject(env.TEST_OVERSEER.getByName(`external-allowed-${crypto.randomUUID()}`), async instance => {
      const impl = Reflect.get(instance, "impl");
      setupWorkspace(impl, caller.accountId, kind === "existing");
      if (kind === "existing") await seedPendingCodeChange(impl);
      const start = vi.spyOn(impl, "startAgent").mockImplementation(() => {});
      vi.spyOn(impl, "generateThreadTitle").mockImplementation(() => {});
      // Local RpcTargets cannot survive persistence. Keep just the callback collection write
      // in memory; production prompt/change writes and transaction logic still run in SQLite.
      let registration: ReturnType<typeof Reflect.get>;
      vi.spyOn(impl.storage.gadgetResponseDeliveries, "put").mockImplementation(record => { registration = record; });
      using target = new RpcStub(new ResponseWitness());
      try {
        const result = await instance.receiveExternalMessage(input(caller.name, target));
        expect(result.accepted).toBe(true);
        expect(registration).toMatchObject({ idempotencyKey: "external-message", status: "waiting" });
        const prompt = [...impl.storage.chats.list()].find(message => message.sequence === registration.promptSequence && message.chatId === registration.chatId);
        expect(prompt).toMatchObject({ type: "message", message: privatePrompt, author: callerProfile });
        expect(start).toHaveBeenCalledOnce();
        expect(await impl.getGatekeeperFacet(1).verificationAttempts()).toBe(2);
        if (kind === "existing") {
          expect(impl.listLiveChatChanges(7, 0)).toEqual([]);
          expect(impl.getProposedChanges(7)).toHaveLength(1);
        }
      } finally {
        registration?.chatGatewayRpcTarget[Symbol.dispose]();
      }
    });
  });

  it("preserves owner bootstrap and current workspace schema", async () => {
    const caller = await createCaller();
    await runInDurableObject(env.TEST_OVERSEER.getByName(`external-owner-${crypto.randomUUID()}`), async instance => {
      const impl = Reflect.get(instance, "impl");
      const observer = vi.spyOn(impl, "ensureObserver");
      vi.spyOn(impl, "startAgent").mockImplementation(() => {});
      vi.spyOn(impl, "generateThreadTitle").mockImplementation(() => {});
      let registration: ReturnType<typeof Reflect.get>;
      vi.spyOn(impl.storage.gadgetResponseDeliveries, "put").mockImplementation(record => { registration = record; });
      using target = new RpcStub(new ResponseWitness());
      try {
        expect((await instance.receiveExternalMessage(input(caller.name, target))).accepted).toBe(true);
        expect(impl.ownerId).toBe(caller.user.id.toString());
        expect(impl.storage.version.get()).toBe(3);
        expect(impl.storage.ownerRegistrationPending.get()).toBe(false);
        expect(observer).not.toHaveBeenCalled();
        expect(await impl.users.getByName(caller.name).getGadget(impl.ctx.id.toString())).not.toBeNull();
      } finally {
        registration?.chatGatewayRpcTarget[Symbol.dispose]();
      }
    });
  });

  it("does not delete stale conversation mappings when the final guard denies", async () => {
    const caller = await createCaller();
    await runInDurableObject(env.TEST_OVERSEER.getByName(`external-stale-${crypto.randomUUID()}`), async instance => {
      const impl = Reflect.get(instance, "impl");
      setupWorkspace(impl, caller.accountId, true);
      impl.storage.chatMeta.delete(7);
      const submit = impl.newChat.bind(impl);
      vi.spyOn(impl, "newChat").mockImplementation((...args) => {
        const pending = submit(...args);
        impl.storage.collaborators.delete(callerProfile.id);
        return pending;
      });
      const before = promptState(impl);
      using target = new RpcStub(new ResponseWitness());
      expect(await instance.receiveExternalMessage(input(caller.name, target))).toEqual(expectedDenial);
      expect(promptState(impl)).toEqual(before);
    });
  });

  it("preserves ordinary browser message preparation and code materialization", async () => {
    const caller = await createCaller();
    await runInDurableObject(env.TEST_OVERSEER.getByName(`browser-message-${crypto.randomUUID()}`), async instance => {
      const impl = Reflect.get(instance, "impl");
      setupWorkspace(impl, caller.accountId, true);
      await seedPendingCodeChange(impl);
      const reserve = vi.spyOn(impl, "reserveChatMessagePreparation");
      await impl.sendChatMessage(caller.user, { profile: callerProfile }, 7, "ordinary browser prompt");
      expect(reserve).toHaveBeenCalledOnce();
      expect(impl.isPreparingChatMessage(7)).toBe(false);
      expect(impl.listLiveChatChanges(7, 0)).toEqual([]);
      expect(impl.getProposedChanges(7)).toHaveLength(1);
      expect([...impl.storage.chats.list()].at(-1)).toMatchObject({ type: "message", message: "ordinary browser prompt" });
      expect([...impl.storage.gadgetResponseDeliveries.list()]).toEqual([]);
    });
  });
});

// Delivered tombstones are persisted in real SQLite; duplicates may arrive during another turn.
describe.each(["existing", "new"] as const)("external delivered replay: %s chat", kind => {
  it.each(["owner", "authorized collaborator", "revoked collaborator"] as const)("%s leaves the active chat untouched", async principal => {
    const caller = await createCaller();
    await runInDurableObject(env.TEST_OVERSEER.getByName(`external-replay-${crypto.randomUUID()}`), async instance => {
      const impl = Reflect.get(instance, "impl");
      setupWorkspace(impl, caller.accountId, kind === "existing");
      await seedPendingCodeChange(impl);
      impl.storage.chatMeta.put({ ...impl.storage.chatMeta.get(7), activeAgent: { type: "agent", id: "test-model", name: "Model" } });
      impl.storage.gadgetResponseDeliveries.put({
        idempotencyKey: "external-message", chatId: 7, promptSequence: 0, createdAt: Date.now(),
        status: "delivered", deliveredAt: Date.now(),
      });
      const before = promptState(impl);
      const effects = ["reserveChatMessagePreparation", "materializeChatChanges", "registerExternalMessageResponseTarget", "startAgent", "nextChatId"]
        .map(method => vi.spyOn(impl, method));
      const sharing = await impl.getSharingManager();
      const denied = new Error("access changed");
      const guard = principal === "owner" ? undefined : impl.createExternalMessageCommitGuard(callerProfile.id, sharing, denied);
      if (principal === "revoked collaborator") impl.storage.collaborators.delete(callerProfile.id);
      using target = new RpcStub(new ResponseWitness());
      const registration = { idempotencyKey: "external-message", chatGatewayRpcTarget: target };
      const result = kind === "existing"
        ? impl.sendChatMessage(caller.user, { profile: callerProfile }, 7, "duplicate", undefined, undefined, registration, undefined, guard)
        : impl.newChat(caller.user, { profile: callerProfile }, "duplicate", undefined, undefined, registration, chatKey, undefined, guard);
      if (principal === "revoked collaborator") await expect(result).rejects.toBe(denied);
      else expect(await result).toBe(kind === "existing" ? undefined : 7);
      expect(promptState(impl)).toEqual(before);
      for (const effect of effects) expect(effect).not.toHaveBeenCalled();
    });
  });
});

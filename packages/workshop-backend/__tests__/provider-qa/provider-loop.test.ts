import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject, evictDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OverseerDurableObject, QaConnectionStorage, TestProviderUser, QaInferenceSnapshot } from "../fixtures/provider-loop-worker.js";
import { eventBytes, textEvents } from "../../../../../packages/ai-provider-adapter/src/fixtures/inference";

declare global {
  namespace Cloudflare {
    interface Env {
      OverseerDurableObject: DurableObjectNamespace<OverseerDurableObject>;
      TestProviderUser: DurableObjectNamespace<TestProviderUser>;
      QaConnectionStorage: DurableObjectNamespace<QaConnectionStorage>;
    }
  }
}

const consent = { billing: "openai-platform-api", ownerInteractive: true, sessionCompaction: true } as const;
beforeEach(() => { vi.stubEnv("OPENAI_LOG", "off"); });
afterEach(() => { vi.unstubAllEnvs(); });

/** Exact strict function lifecycle, preserving every declared tool/call/item identity. */
function callsEvents(calls: { name: string; arguments: unknown }[], responseId: string) {
  const output = calls.map((call, index) => ({ type: "function_call", id: `fc_${responseId}_${index}`,
    call_id: `call_${responseId}_${index}`, name: call.name, arguments: JSON.stringify(call.arguments), status: "completed" }));
  const events: Record<string, unknown>[] = [{ type: "response.created", response: { id: responseId, status: "in_progress", output: [] } }];
  output.forEach((item, output_index) => {
    events.push({ type: "response.output_item.added", output_index, item: { ...item, status: "in_progress", arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index, item_id: item.id, delta: item.arguments },
      { type: "response.function_call_arguments.done", output_index, item_id: item.id, name: item.name, arguments: item.arguments },
      { type: "response.output_item.done", output_index, item });
  });
  events.push({ type: "response.completed", response: { id: responseId, status: "completed", output } });
  return events.map((event, sequence_number) => ({ ...event, sequence_number }));
}

async function fixture(replies: (Record<string, unknown>[] | null)[], withGatekeeper = true) {
  const profileId = `qa-${crypto.randomUUID()}@example.test`;
  const owner = env.TestProviderUser.getByName(profileId);
  await owner.authenticateFromCfAccess(profileId, true);
  const connection = await owner.createProviderConnection({ label: "QA API", apiKey: "QA_SYNTHETIC_KEY", consent });
  await runInDurableObject(owner, (_instance, state) => { state.storage.kv.put("fixture.inferenceEnabled", true); });
  const selected = await owner.selectProviderConnectionModel(connection.connectionId, connection.generation, "fixture-model");
  const context = await owner.getChatContext(selected.id);
  const connectionStub = env.QaConnectionStorage.getByName(connection.connectionId);
  await connectionStub.configure(owner.id.toString(), connection.connectionId, replies);
  const workspace = env.OverseerDurableObject.getByName(`qa-workspace-${crypto.randomUUID()}`);
  await runInDurableObject(workspace, async instance => {
    const impl = Reflect.get(instance, "impl");
    impl.ownerId = owner.id.toString(); impl.storage.ownerId.put(owner.id.toString());
    impl.ownerProfileId = profileId; impl.users = env.TestProviderUser;
    // Mirror production #initializeNewWorkspace: current-schema workspace, not a legacy migration fixture.
    impl.storage.codeVersion.put(1);
    impl.storage.version.put(3);
    let bindings: Record<string, number> = {};
    if (withGatekeeper) {
      const gatekeeper = await impl.addGatekeeper(Reflect.get(impl.ctx.exports, "QaGatekeeper")({ props: {} }));
      // This is the local implementation object, not a minted RPC stub.
      bindings = { TEST_RESOURCE: await gatekeeper.getId() };
    }
    impl.storage.chatContext.put({ chatId: 0, bindings, alwaysAvailableCapsuleIds: [] });
    impl.storage.chatMeta.put({ id: 0, title: "QA loop", started: new Date(), lastActive: new Date(), activeAgent: context.aiModel!.profile });
    impl.addChatMessages(0, context.profile, [{ type: "message", message: "Synthetic owner request" }]);
  });
  const snapshot = async () => JSON.parse(await env.QaConnectionStorage.getByName(connection.connectionId).snapshot()) as QaInferenceSnapshot;
  return { owner, workspace, context, snapshot, profileId, connectionId: connection.connectionId };
}

async function start(f: Awaited<ReturnType<typeof fixture>>) {
  await runInDurableObject(f.workspace, async instance => {
    const impl = Reflect.get(instance, "impl");
    impl.startAgent(0, f.context.aiModel, f.context.profile, f.owner.id.toString());
    await impl.waitForAllAgentsToComplete();
    expect((await f.snapshot()).errors).toEqual([]);
  });
}

async function assertIdle(workspace: DurableObjectStub<OverseerDurableObject>) {
  await runInDurableObject(workspace, async (instance, state) => {
    const impl = Reflect.get(instance, "impl");
    expect([...impl.storage.activeAgents.list()]).toHaveLength(0);
    expect(await state.storage.getAlarm()).toBeNull();
  });
}

async function boundedEviction(workspace: DurableObjectStub<OverseerDurableObject>) {
  await assertIdle(workspace);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([evictDurableObject(workspace), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("QA workspace eviction did not settle within3000ms")), 3000);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function nativeRestart(workspace: DurableObjectStub<OverseerDurableObject>) {
  if (process.env.QA_GRACEFUL_EVICTION_DIAGNOSTIC === "1") {
    console.info("QA restart oracle: graceful eviction (no native abort)");
    const before = await workspace.getTestIncarnation();
    await boundedEviction(workspace);
    const fresh = env.OverseerDurableObject.get(workspace.id);
    expect(await fresh.getTestIncarnation()).not.toBe(before);
    await assertIdle(fresh);
    return fresh;
  }
  console.info("QA restart oracle: forced native actor abort");
  await assertIdle(workspace);
  const before = await workspace.getTestIncarnation();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([workspace.forceTestRestart().then(() => {
      throw new Error("QA native abort unexpectedly returned normally");
    }, error => { expect(String(error?.message ?? error)).toContain("QA_FORCED_NATIVE_RESTART"); }),
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("QA native abort did not settle within3000ms")), 3000); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
  const fresh = env.OverseerDurableObject.get(workspace.id);
  expect(await fresh.getTestIncarnation()).not.toBe(before);
  await assertIdle(fresh);
  return fresh;
}

const write = `export default async function(self, env) {
  const resource = env.TEST_RESOURCE;
  console.log("Before", await resource.read());
  await resource.write(7);
  console.log("Simulated", await resource.read());
  console.log("Provider authority absent", env.AI_PROVIDER_ADAPTER === undefined);
}`;

describe("QA actual Plexus Pi/executor and strict native transport integration", () => {
  it("eviction control: fresh production Overseer with no model or Gatekeeper drains", async () => {
    const workspace = env.OverseerDurableObject.getByName(`qa-empty-${crypto.randomUUID()}`);
    await runInDurableObject(workspace, instance => {
      expect(Reflect.get(instance, "impl").storage.activeAgents.get(0)).toBeUndefined();
    });
    console.info("QA empty control: before workspace eviction");
    await boundedEviction(workspace);
    console.info("QA empty control: workspace evicted");
  });

  it("eviction control: configured but unused Gatekeeper workspace drains without Pi", async () => {
    const f = await fixture([]);
    console.info("QA unused Gatekeeper control: before workspace eviction");
    await boundedEviction(f.workspace);
    console.info("QA unused Gatekeeper control: workspace evicted");
    expect((await f.snapshot()).captured).toHaveLength(0);
  });

  it("restart control: text-only Pi success survives an actual native actor reset", async () => {
    const f = await fixture([textEvents("QA no tools")], false);
    await start(f);
    const evidence = await f.snapshot();
    expect(evidence.captured).toHaveLength(1);
    expect(evidence.cancellations).toHaveLength(0);
    expect((await env.QaConnectionStorage.getByName(f.connectionId).probe()).issued).toBe(false);
    console.info("QA text-only control: before native workspace restart");
    await nativeRestart(f.workspace);
    console.info("QA text-only control: native workspace restarted");
  });

  it("restart control: legacy Pi success through fixed synthetic fetch survives native actor reset", async () => {
    const f = await fixture([], false);
    let calls = 0;
    await runInDurableObject(f.workspace, async instance => {
      const impl = Reflect.get(instance, "impl");
      const original = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        if (request.url !== "https://fixture.internal/v1/responses" || request.method !== "POST") {
          throw new Error("QA legacy control rejects every other network route.");
        }
        calls++;
        return new Response(eventBytes(textEvents("QA legacy response")), { headers: { "content-type": "text/event-stream" } });
      };
      try {
        const model = { ...f.context.aiModel, profile: { ...f.context.aiModel!.profile, id: "qa-legacy-model" },
          config: { provider: "azure-foundry", model: "gpt-4o", apiToken: "SYNTHETIC_LEGACY_KEY", apiUrl: "https://fixture.internal/v1" } };
        impl.startAgent(0, model, f.context.profile, f.owner.id.toString());
        await impl.waitForAllAgentsToComplete();
        expect(JSON.stringify([...impl.storage.chats.list()])).toContain("QA legacy response");
      } finally { globalThis.fetch = original; }
    });
    expect(calls).toBe(1);
    expect((await f.snapshot()).captured).toHaveLength(0);
    console.info("QA legacy control: before native workspace restart");
    await nativeRestart(f.workspace);
    console.info("QA legacy control: native workspace restarted");
  });

  it("audits observation and simulated write, suspends at barrier, then owner approval resumes captured session exactly once", async () => {
    const f = await fixture([callsEvents([{ name: "describeBinding", arguments: { name: "TEST_RESOURCE" } }], "resp_describe"),
      callsEvents([{ name: "executeCode", arguments: { code: write } }], "resp_write"), textEvents("QA applied answer")]);
    await start(f);
    let turnId = "";
    let gatekeeperId = -1;
    await runInDurableObject(f.workspace, async instance => {
      const impl = Reflect.get(instance, "impl");
      const actions = [...impl.storage.actions.list()];
      expect(actions.filter((action: { type: string }) => action.type === "observation")).toHaveLength(2);
      const pending = actions.find((action: { type: string }) => action.type === "action");
      gatekeeperId = pending.gatekeeperId;
      expect(pending.state).toBe("pending");
      const facet = impl.getGatekeeperFacet(pending.gatekeeperId);
      expect(await facet.evidence()).toEqual({ value: 0, applied: 0, rejected: 0 });
      const log = [...impl.storage.chats.list()];
      expect(JSON.stringify(log)).toContain("Simulated 7");
      expect(JSON.stringify(log)).toContain("Provider authority absent true");
      expect(impl.storage.personalTurns.get(0).state).toBe("suspended");
      expect(impl.storage.activeAgents.get(0)).toBeUndefined();
      turnId = impl.storage.personalTurns.get(0).turnId;
      using notify = new NativeRpcStub<() => void>(() => {});
      const client = await instance.open(f.owner.id.toString(), f.profileId, notify);
      try { await client.approveAction(pending.id); } finally { Reflect.get(client, Symbol.dispose).call(client); }
      await impl.waitForAllAgentsToComplete();
      expect(await facet.evidence()).toEqual({ value: 7, applied: 1, rejected: 0 });
      expect(impl.storage.actions.get(pending.id).state).toBe("approved");
      expect(impl.storage.personalTurns.get(0).state).toBe("ended");
      expect(JSON.stringify([...impl.storage.chats.list()])).toContain("QA applied answer");
    });
    const evidence = await f.snapshot();
    expect(evidence.captured).toHaveLength(3);
    expect(evidence.captured.map(request => request.session.turnId)).toEqual([turnId, turnId, turnId]);
    expect(evidence.captured.map(request => request.purpose)).toEqual(["ownerInteractive", "ownerInteractive", "approvalResume"]);
    const replay = JSON.stringify(evidence.captured[2].payload);
    expect(replay).toContain("call_resp_describe_0"); expect(replay).toContain("fc_resp_describe_0");
    expect(replay).toContain("call_resp_write_0"); expect(replay).toContain("Simulated 7");
    expect(replay).not.toContain("QA_SYNTHETIC_KEY");
    console.info("QA completed control: before native workspace restart");
    f.workspace = await nativeRestart(f.workspace);
    console.info("QA completed control: native workspace restarted");
    await runInDurableObject(f.workspace, async instance => {
      const impl = Reflect.get(instance, "impl");
      expect(impl.storage.activeAgents.get(0)).toBeUndefined();
      expect(impl.storage.personalTurns.get(0).state).toBe("ended");
      expect(await impl.getGatekeeperFacet(gatekeeperId).evidence()).toEqual({ value: 7, applied: 1, rejected: 0 });
    });
    expect((await f.snapshot()).captured).toHaveLength(3);
  });

  it("denial cleans queued state without applying it or making a resumed inference", async () => {
    const f = await fixture([callsEvents([{ name: "executeCode", arguments: { code: write } }], "resp_denied")]);
    await start(f);
    await runInDurableObject(f.workspace, async instance => {
      const impl = Reflect.get(instance, "impl");
      const pending = [...impl.storage.actions.list()].find((action: { type: string }) => action.type === "action");
      using notify = new NativeRpcStub<() => void>(() => {});
      const client = await instance.open(f.owner.id.toString(), f.profileId, notify);
      try { await client.rejectAction(pending.id); } finally { Reflect.get(client, Symbol.dispose).call(client); }
      await impl.waitForAllAgentsToComplete();
      expect(await impl.getGatekeeperFacet(pending.gatekeeperId).evidence()).toEqual({ value: 0, applied: 0, rejected: 1 });
      expect(impl.storage.actions.get(pending.id).state).toBe("rejected");
    });
    expect((await f.snapshot()).captured).toHaveLength(1);
  });

  it("incomplete native function output never grants executeCode or Gatekeeper authority", async () => {
    const broken = callsEvents([{ name: "executeCode", arguments: { code: write } }], "resp_partial").slice(0, -1);
    const f = await fixture([broken]);
    await start(f);
    await runInDurableObject(f.workspace, instance => {
      const impl = Reflect.get(instance, "impl");
      expect([...impl.storage.actions.list()]).toHaveLength(0);
      expect([...impl.storage.chats.list()].some((message: { type: string; code?: string }) => message.type === "error" && message.code === "stream_incomplete")).toBe(true);
    });
    expect((await f.snapshot()).captured).toHaveLength(1);
  });

  it("cancels a resumed inference after an applied effect, retains its barrier and never replays the write on restart", async () => {
    console.info("QA cancellation: setup");
    const f = await fixture([callsEvents([{ name: "executeCode", arguments: { code: write } }], "resp_before_cancel"), null]);
    await start(f);
    let gatekeeperId = -1;
    await runInDurableObject(f.workspace, async instance => {
      const impl = Reflect.get(instance, "impl");
      const pending = [...impl.storage.actions.list()].find((action: { type: string }) => action.type === "action");
      gatekeeperId = pending.gatekeeperId;
      using notify = new NativeRpcStub<() => void>(() => {});
      const client = await instance.open(f.owner.id.toString(), f.profileId, notify);
      try {
        await client.approveAction(pending.id);
        await vi.waitFor(async () => { expect((await f.snapshot()).captured).toHaveLength(2); });
        await vi.waitFor(async () => { expect((await f.snapshot()).headers).toBe(2); });
        console.info("QA cancellation: before stop");
        await client.stopAgent(0);
        console.info("QA cancellation: stopped");
      } finally { Reflect.get(client, Symbol.dispose).call(client); }
      console.info("QA cancellation: before agent settlement");
      await impl.waitForAllAgentsToComplete();
      console.info("QA cancellation: agent settled");
      expect(await impl.getGatekeeperFacet(gatekeeperId).evidence()).toEqual({ value: 7, applied: 1, rejected: 0 });
      expect(impl.storage.actions.get(pending.id).state).toBe("approved");
      expect(impl.storage.activeAgents.get(0)).toBeUndefined();
      expect(JSON.stringify([...impl.storage.chats.list()])).toContain("resp_before_cancel");
    });
    await vi.waitFor(async () => {
      const probe = await env.QaConnectionStorage.getByName(f.connectionId).probe();
      expect(probe).toEqual({ issued: false, aborted: true });
    }, { timeout: 3000, interval: 25 });
    console.info("QA cancellation: durable issuance cleared");
    console.info("QA cancellation: before native workspace restart");
    f.workspace = await nativeRestart(f.workspace);
    console.info("QA cancellation: native workspace restarted");
    await runInDurableObject(f.workspace, async instance => {
      const impl = Reflect.get(instance, "impl");
      expect(impl.storage.activeAgents.get(0)).toBeUndefined();
      expect(await impl.getGatekeeperFacet(gatekeeperId).evidence()).toEqual({ value: 7, applied: 1, rejected: 0 });
    });
    const evidence = await f.snapshot();
    expect(evidence.captured).toHaveLength(2);
    expect(evidence.cancellations).toHaveLength(1);
    expect(evidence.errors).toEqual([]);
    const { version, requestId, ownerId, requesterUserId, workspaceOwnerId, connectionId, generation, expiresAt } = evidence.captured[1];
    expect(evidence.cancellations[0]).toEqual({ version, requestId, ownerId, requesterUserId, workspaceOwnerId, connectionId, generation, expiresAt });
  });
});

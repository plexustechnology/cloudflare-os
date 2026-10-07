import { describe, expect, it } from "vitest";
import type { AiChatMessage, AiChatMessageBody } from "@gadgets/workshop-shared/api";
import type { ActionRecord } from "../src/overseer.js";
import { snapshotExternalMessageResponse } from "../src/external-message-response.js";

function message(body: AiChatMessageBody, sequence = 1): AiChatMessage {
  return { chatId: 7, sequence, timestamp: new Date(), author: { type: "agent", name: "Agent" }, ...body };
}
function hook(enabled: boolean, hookId?: number): ActionRecord {
  return { id: 3, gatekeeperId: 1, caller: { from: "agent", chatId: 7 }, createdAt: new Date(),
    type: "bindHook", state: "approved", description: { description: "synthetic" }, enabled, hookId };
}

describe("D031 current-turn action and failure boundaries", () => {
  it("does not classify action-like prose as tab work", () => {
    const snapshot = snapshotExternalMessageResponse([
      message({ type: "message", message: "Please approve the plan or tell me which permission you want." }),
    ], () => { throw new Error("No action lookup should occur"); }, false);
    expect(snapshot.outcome).toBe("reply"); expect(snapshot.actions).toEqual([]);
  });
  it.each([true, false])("does not include enabled or deleted hook work enabled=%s", enabled => {
    const snapshot = snapshotExternalMessageResponse([message({ type: "action", actionId: 3 })],
      () => hook(enabled, enabled ? 9 : undefined), false);
    expect(snapshot.actions).toEqual([]);
  });
  it("only emits review_changes for a still-pending change created in this turn", () => {
    const oldOnly = new Set([2]);
    const current = [message({ type: "changes", createdGadgets: [{ gadgetId: 1, title: "Synthetic", bindingName: "demo" }] }, 7)];
    expect(snapshotExternalMessageResponse(current, () => undefined, false, oldOnly).actions).toEqual([]);
    expect(snapshotExternalMessageResponse(current, () => undefined, false, new Set([7])).actions).toEqual(["review_changes"]);
  });
  it("recognizes pending Git code edits without treating empty changes as tab work", () => {
    const current = [message({ type: "changes", change: { 1: [["app.js", { set: "Synthetic edit" }]] } }, 7)];
    expect(snapshotExternalMessageResponse(current, () => undefined, false, new Set([7])).actions).toEqual(["review_changes"]);
    expect(snapshotExternalMessageResponse(current, () => undefined, false, new Set()).actions).toEqual([]);
    expect(snapshotExternalMessageResponse([
      message({ type: "changes", change: {}, conversionBoundary: true }, 7),
    ], () => undefined, false, new Set([7])).actions).toEqual([]);
  });
  it("does not let later-turn errors or action requests contaminate the first reply", () => {
    const snapshot = snapshotExternalMessageResponse([
      message({ type: "message", message: "First answer" }),
      { ...message({ type: "message", message: "Next prompt" }), author: { type: "user", id: "u", name: "User" } },
      message({ type: "error", message: "Later sensitive error" }),
      message({ type: "connectionRequest", requestId: "later", vendorId: "v", vendorName: "V", reason: "later", state: "pending" }),
    ], () => undefined, false);
    expect(snapshot).toEqual({ version: 2, outcome: "reply", text: "First answer", actions: [], sharing: "allowed" });
  });
  it.each(["accepted", "denied"] as const)("a %s connection request no longer requires tab action", state => {
    const snapshot = snapshotExternalMessageResponse([
      message({ type: "connectionRequest", requestId: "r", vendorId: "v", vendorName: "V", reason: "synthetic", state }),
    ], () => undefined, false);
    expect(snapshot.actions).toEqual([]);
  });
});

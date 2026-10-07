import { describe, expect, it } from "vitest";
import type { AiChatMessage, AiChatMessageBody } from "@gadgets/workshop-shared/api";
import { snapshotExternalMessageResponse } from "../src/external-message-response.js";
import type { ActionRecord } from "../src/overseer.js";

const message = (body: AiChatMessageBody, sequence = 1): AiChatMessage => ({
  chatId: 7, sequence, timestamp: new Date(), author: { type: "agent", name: "Agent" }, ...body,
});
const answer = message({ type: "message", message: "Answer", reasoning: "PRIVATE REASONING" });
const action = (state: "pending" | "approved" | "rejected"): ActionRecord => ({
  id: 3, gatekeeperId: 1, caller: { from: "agent", chatId: 7 }, createdAt: new Date(),
  type: "action", state, action: 1, description: { description: "private action" },
});

describe("external turn response snapshot", () => {
  it("exports only final agent text, stopping before subsequent prompt or callback turns", () => {
    for (const boundary of [message({ type: "agentCallback", methodName: "later", argsSummary: "private" }),
      { ...answer, author: { type: "user" as const, id: "user", name: "User" } }]) {
      const snapshot = snapshotExternalMessageResponse([answer, boundary, message({ type: "message", message: "wrong turn" })], () => undefined, false);
      expect(snapshot).toEqual({ version: 2, outcome: "reply", text: "Answer", actions: [], sharing: "allowed" });
      expect(JSON.stringify(snapshot)).not.toContain("PRIVATE");
    }
  });
  it.each(["pending", "approved", "rejected"] as const)("uses persisted %s action state, independently of awaitDecision", state => {
    const snapshot = snapshotExternalMessageResponse([answer, message({ type: "action", actionId: 3 })], () => action(state), false);
    expect(snapshot.actions).toEqual(state === "pending" ? ["approval"] : []);
  });
  it("classifies connection yield, turn-local changes and newly disabled hook only", () => {
    const hook: ActionRecord = { id: 4, gatekeeperId: 1, caller: { from: "agent", chatId: 7 }, createdAt: new Date(),
      type: "bindHook", state: "approved", description: { description: "hook" }, enabled: false, hookId: 2 };
    const snapshot = snapshotExternalMessageResponse([
      message({ type: "connectionRequest", requestId: "r", vendorId: "v", vendorName: "V", reason: "need", state: "pending" }),
      message({ type: "changes", createdGadgets: [{ gadgetId: 1, title: "Demo", bindingName: "demo" }] }, 2),
      message({ type: "action", actionId: 4 }, 3),
    ], id => id === 4 ? hook : action("pending"), false, new Set([2]));
    expect(snapshot).toEqual({ version: 2, outcome: "action_required", actions: ["connection", "enable_hook", "review_changes"], sharing: "allowed" });
  });
  it("does not retain settled draft changes or deleted/enabled hooks", () => {
    expect(snapshotExternalMessageResponse([
      message({ type: "changes" }, 2), message({ type: "merge", mergeThrough: 2, version: 3 }, 3),
      message({ type: "changes" }, 4), message({ type: "revert", revertFrom: 4 }, 5),
    ], () => undefined, false).actions).toEqual([]);
  });
  it("never exports raw errors or partial text on failure or sharing prohibition", () => {
    expect(snapshotExternalMessageResponse([answer, message({ type: "error", message: "secret failure" })], () => undefined, false))
      .toEqual({ version: 2, outcome: "failed", actions: [], sharing: "allowed" });
    expect(snapshotExternalMessageResponse([answer], () => undefined, true))
      .toEqual({ version: 2, outcome: "reply", actions: [], sharing: "blocked" });
    expect(snapshotExternalMessageResponse([answer, message({ type: "action", actionId: 3 }),
      message({ type: "error", message: "secret" })], () => action("pending"), false))
      .toEqual({ version: 2, outcome: "failed", actions: ["approval"], sharing: "allowed" });
  });
});

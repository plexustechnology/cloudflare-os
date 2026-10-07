import type { AiChatMessage } from "@gadgets/workshop-shared/api";
import { changedGadgets } from "@gadgets/workshop-shared/code-change";
import type { GadgetResponseSnapshot, GadgetResponseAction } from "@gadgets/workshop-shared/external-message-gateway";
import type { ActionRecord } from "./overseer.js";

/** Selects one originating turn using persisted chat state, without interpreting model prose. */
export function snapshotExternalMessageResponse(
  messagesAfterPrompt: readonly AiChatMessage[],
  getAction: (id: number) => ActionRecord | undefined,
  sharingBlocked: boolean,
  pendingChangeSequences: ReadonlySet<number> = new Set(),
): GadgetResponseSnapshot {
  const actions = new Set<GadgetResponseAction>();
  const changes = new Set<number>();
  let text: string | undefined;
  let failed = false;
  for (const message of messagesAfterPrompt) {
    if (message.type === "agentCallback" || message.type === "slashCommand" ||
        (message.type === "message" && (message.author.type === "user" || message.author.type === "gadget"))) break;
    if (message.type === "message" && message.author.type === "agent" && message.message.trim()) {
      text = message.message;
    } else if (message.type === "error") {
      failed = true;
    } else if (message.type === "connectionRequest" && message.state === "pending") {
      actions.add("connection");
    } else if (message.type === "action") {
      const action = getAction(message.actionId);
      if (action?.type === "action" && action.state === "pending") actions.add("approval");
      if (action?.type === "bindHook" && action.hookId !== undefined && !action.enabled) actions.add("enable_hook");
    } else if (message.type === "changes" && pendingChangeSequences.has(message.sequence) &&
        (changedGadgets(message.change ?? {}).length > 0 || (message.createdGadgets?.length ?? 0) > 0 ||
         (message.addedBindings?.length ?? 0) > 0)) {
      changes.add(message.sequence);
    }
  }
  if (changes.size) actions.add("review_changes");
  return {
    version: 2, outcome: failed ? "failed" : actions.size ? "action_required" : "reply",
    ...(!failed && !sharingBlocked && text !== undefined ? { text } : {}),
    actions: [...actions], sharing: sharingBlocked ? "blocked" : "allowed",
  };
}

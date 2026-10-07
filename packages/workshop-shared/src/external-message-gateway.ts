import type { RpcStub, RpcTarget } from "cloudflare:workers";

/** A tab-only operation identified from persisted state, never from model-written prose. */
export type GadgetResponseAction = "connection" | "approval" | "review_changes" | "enable_hook";

/** Immutable snapshot of the originating external turn, captured before callback delivery. */
export interface GadgetResponseSnapshot {
  /** Envelope schema; legacy responses lack a structured snapshot. */
  version: 2;
  /** Server-derived completion or suspension classification. */
  outcome: "reply" | "action_required" | "failed";
  /** Final agent-authored text only; absent on failure or when sharing is prohibited. */
  text?: string;
  /** Distinct pending operations belonging to this turn. */
  actions: GadgetResponseAction[];
  /** Authoritative Workshop sharing restriction at snapshot creation. */
  sharing: "allowed" | "blocked";
}

/** A completed Gadget response that should be delivered back to the chat gateway. */
export type GadgetResponse = {
  /** Legacy text; consumers must use the structured snapshot for shared answers. */
  text: string;
  /** Optional immutable originating-turn snapshot; absent on legacy deliveries. */
  structured?: GadgetResponseSnapshot;
};

/** RPC target provided by the chat gateway for the backend's eventual response. */
export interface ChatGatewayRpcTarget extends RpcTarget {
  /**
   * Deliver the completed Gadget response. Implementations must be idempotent because delivery is
   * at-least-once when response target acknowledgements fail.
   */
  onGadgetResponse(response: GadgetResponse): Promise<void>;
}

/** External message submission accepted by the backend gateway. */
export type SubmitExternalMessageInput = {
  /**
   * Selects the Gadgets account used to submit the message.
   * The backend trusts the gateway: supplying this email grants access as that account.
   */
  callerEmail: string;
  /** Selects the workspace to create or reuse. */
  gadgetKey: string;
  /** Selects the chat to create or reuse. */
  chatKey: string;
  /** Deduplicates the originating message and correlates the response target. */
  messageKey: string;
  /** Names the workspace if it must be created. */
  gadgetTitle: string;
  /** User text sent to Gadgets. */
  prompt: string;
  /** Persistent target invoked when the Gadget response is ready. */
  chatGatewayRpcTarget: RpcStub<ChatGatewayRpcTarget>;
};

/** Submission result returned by the backend gateway. */
export type SubmitExternalMessageResult =
  | {
      accepted: true;
      chatPath: string;
    }
  | {
      accepted: false;
      /** User-facing explanation of an actionable submission rejection. */
      message: string;
    };

/** Service binding RPC interface used by chat gateway workers. */
export interface ExternalMessageGateway {
  /** Submit an external chat message for Gadget routing and execution. */
  submitExternalMessage(input: SubmitExternalMessageInput): Promise<SubmitExternalMessageResult>;
}

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { AccountDescription } from "@gadgets/workshop-shared/gatekeeper";

// Preserve production loopback discovery; wildcard reexports are not discoverable by the pool.
export {
  default, PendingLogin, LoginConnectCallbackImpl, LanguageModelGatekeeper, AdminSettings,
  UserDurableObject, GatekeeperConnectCallbackImpl, OverseerDurableObject, GatekeeperLoopback,
  GatekeeperHookLoopback, CodeModeTailLoopback, AgentSpawnerGatekeeper, GadgetTailLoopback,
  AgentSelfLoopback, TransientStubLoopback, ExternalMessageGateway,
} from "../../src/server.js";

/** Controlled verifier for testing the real UserDO/account RPC boundary. */
export class TestObserverVerifier extends WorkerEntrypoint<unknown, { allowed: boolean }> {
  /** Supplies a synthetic authorization outcome without external credentials. */
  async isAllowed(): Promise<boolean> { return this.ctx.props.allowed; }
}

/** Persistable connected account for the production UserDO verifier lookup. */
export class TestObserverAccount extends WorkerEntrypoint<unknown, { identity: string; allowed: boolean }> {
  /** Supplies synthetic account metadata. */
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Controlled account", uniqueName: this.ctx.props.identity,
      avatar: { url: "https://controlled.example.test/avatar" },
    };
  }

  /** Mints the test-only verifier through the actual Worker RPC mechanism. */
  async getVerifier(): Promise<Fetcher<TestObserverVerifier>> {
    return Reflect.get(this.ctx.exports, "TestObserverVerifier")({ props: { allowed: this.ctx.props.allowed } });
  }
}

/** Test facet used by the production observer verification path. */
export class TestObserverGatekeeper extends DurableObject<unknown, { identity: string }> {
  /** Records each verification and fails when the account's verifier denies access. */
  async addObserver(id: string, verifier: Fetcher<TestObserverVerifier>): Promise<void> {
    this.ctx.storage.kv.put("attempts", (this.ctx.storage.kv.get<number>("attempts") ?? 0) + 1);
    if (!await verifier.isAllowed()) throw new Error("Controlled observer access revoked");
    this.ctx.storage.kv.put(`observer:${id}`, true);
  }

  /** Removes registration when verification rolls back a new choice. */
  async removeObserver(id: string): Promise<void> { this.ctx.storage.kv.delete(`observer:${id}`); }

  /** Returns bounded verification evidence. */
  async verificationAttempts(): Promise<number> { return this.ctx.storage.kv.get<number>("attempts") ?? 0; }
}

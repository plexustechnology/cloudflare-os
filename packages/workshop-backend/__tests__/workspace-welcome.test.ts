import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv { TEST_USER: DurableObjectNamespace<UserDurableObject>; }
}

const firstWorkspace = "a".repeat(64);
const secondWorkspace = "b".repeat(64);
const owner = { type: "user" as const, id: "owner@example.test", name: "Owner" };

describe("authenticated account workspace welcome preferences", () => {
  it("persists per user and workspace across capability instances without changing account onboarding or metadata", async () => {
    const name = `welcome-${crypto.randomUUID()}`;
    const user = env.TEST_USER.getByName(name);
    await user.recordSharedGadgetOpen(firstWorkspace, "Guide", owner, "build");
    await user.recordSharedGadgetOpen(secondWorkspace, "Other", owner, "build");
    const before = await user.listGadgets();
    expect(await user.hasSeenWorkspaceWelcome(firstWorkspace)).toBe(false);
    await user.markWorkspaceWelcomeSeen(firstWorkspace);
    await user.markWorkspaceWelcomeSeen(firstWorkspace);
    expect(await env.TEST_USER.getByName(name).hasSeenWorkspaceWelcome(firstWorkspace)).toBe(true);
    expect(await user.hasSeenWorkspaceWelcome(secondWorkspace)).toBe(false);
    expect(await env.TEST_USER.getByName(`other-${crypto.randomUUID()}`).hasSeenWorkspaceWelcome(firstWorkspace)).toBe(false);
    expect(await user.isOnboardingCompleted()).toBe(false);
    expect(await user.listGadgets()).toEqual(before);
    const stored = await runInDurableObject(user, instance => [...Reflect.get(instance, "storage").workspaceWelcomes.list()]);
    expect(stored).toEqual([{ workspaceId: firstWorkspace }]);
  });

  it("rejects unknown workspaces and malformed identities without creating arbitrary preferences", async () => {
    const user = env.TEST_USER.getByName(`welcome-deny-${crypto.randomUUID()}`);
    await runInDurableObject(user, async instance => {
      await expect(instance.markWorkspaceWelcomeSeen(firstWorkspace)).rejects.toThrow("Unknown workspace");
      await expect(instance.hasSeenWorkspaceWelcome("invalid")).rejects.toThrow("Invalid workspace");
    });
    expect(await user.hasSeenWorkspaceWelcome(firstWorkspace)).toBe(false);
  });
});

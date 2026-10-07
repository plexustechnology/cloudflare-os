import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const azureModel = "gpt-5.6-sol-1";
const workersModel = "@cf/moonshotai/kimi-k2.7-code";

describe("external message model selection", () => {
  it("overrides old thread models and personal preferences without changing browser defaults", async () => {
    const user = env.TEST_USER.getByName(`external-model-${crypto.randomUUID()}`);
    await user.createAccount("model-user", "Model user", new Uint8Array(32));
    await runInDurableObject(user, async instance => {
      // Synthetic provider configuration; this test resolves models without making inference calls.
      Reflect.set(instance, "env", {
        ...Reflect.get(instance, "env"), CF_AI_GATEWAY: "test-gateway",
        CF_AI_GATEWAY_ACCOUNT_ID: "test-account", CF_AI_GATEWAY_PROVIDERS: "cloudflare",
        CF_AI_GATEWAY_API_TOKEN: "synthetic-gateway-token", WORKERS_AI: undefined,
        AZURE_FOUNDRY_ENDPOINT: "https://synthetic.example.test/openai/v1",
        AZURE_FOUNDRY_MODEL: azureModel, AZURE_FOUNDRY_API_KEY: "synthetic-azure-key",
      });
      await instance.setPreferredModel(workersModel);
      for (const previousModel of [null, workersModel]) {
        const context = await instance.getExternalMessageChatContext(previousModel, azureModel);
        expect(context.aiModel?.profile.id).toBe(azureModel);
        expect(context.aiModel?.config.provider).toBe("azure-foundry");
        expect(context.quickModel).toEqual(context.aiModel?.config);
      }
      expect(await instance.getPreferredModel()).toBe(workersModel);
      expect((await instance.getExternalMessageChatContext(null)).aiModel?.profile.id).toBe(workersModel);
      expect((await instance.getExternalMessageChatContext(azureModel)).aiModel?.profile.id).toBe(azureModel);
      expect((await instance.getChatContext(workersModel)).aiModel?.profile.id).toBe(workersModel);
      expect((await instance.getExternalMessageChatContext(null, "unavailable-model")).aiModel).toBeUndefined();
      Reflect.get(instance, "env").AZURE_FOUNDRY_API_KEY = undefined;
      await instance.addModel({ type: "agent", id: azureModel, name: "Personal collision" }, {
        provider: "cloudflare", model: "personal-model", apiToken: "", apiUrl: "https://synthetic.example.test",
      });
      expect((await instance.getExternalMessageChatContext(workersModel, azureModel)).aiModel).toBeUndefined();
    });
  });

  it("preserves the legacy existing/preferred/first selection order when no override is supplied", async () => {
    const user = env.TEST_USER.getByName(`external-legacy-model-${crypto.randomUUID()}`);
    await user.createAccount("legacy-model-user", "Legacy user", new Uint8Array(32));
    for (const id of ["a-first-model", "b-preferred-model", "c-existing-model"]) {
      await user.addModel({ type: "agent", id, name: id }, {
        provider: "openai", model: id, apiToken: "", apiUrl: "https://synthetic.example.test",
      });
    }
    expect((await user.getExternalMessageChatContext(null)).aiModel?.profile.id).toBe("a-first-model");
    await user.setPreferredModel("b-preferred-model");
    expect((await user.getExternalMessageChatContext(null)).aiModel?.profile.id).toBe("b-preferred-model");
    expect((await user.getExternalMessageChatContext("c-existing-model")).aiModel?.profile.id).toBe("c-existing-model");
  });
});

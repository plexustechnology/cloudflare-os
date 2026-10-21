import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";

export default defineConfig({
  plugins: [capnwebValidate(), cloudflareTest({
    main: "./__tests__/fixtures/provider-connections-worker.ts",
    miniflare: {
      compatibilityDate: "2026-02-02",
      compatibilityFlags: ["experimental", "nodejs_compat", "allow_irrevocable_stub_storage"],
      kvNamespaces: ["BLUEPRINTS", "AVATARS"],
      r2Buckets: ["BLUEPRINT_CONTENT"],
      durableObjects: {
        TEST_USER_DIRECTORY: { className: "UserDirectoryDurableObject", useSQLite: true },
        TEST_PROVIDER_USER: { className: "TestProviderUser", useSQLite: true },
        TEST_PROVIDER_DISABLED: { className: "UserDurableObject", useSQLite: true },
        TEST_PROVIDER_OVERSEER: { className: "OverseerDurableObject", useSQLite: true },
      },
    },
  })],
  test: { include: ["__tests__/provider-connections/*.test.ts"], setupFiles: ["@gadgets/scripts/assert-workerd"] },
});

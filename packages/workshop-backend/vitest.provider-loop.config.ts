import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";

/** QA-only native sandbox/DO fixture; no deployment config, dotenv or provider network. */
export default defineConfig({
  plugins: [capnwebValidate(), cloudflareTest({
    main: "./__tests__/fixtures/provider-loop-worker.ts",
    miniflare: {
      compatibilityDate: "2026-08-04",
      compatibilityFlags: ["experimental", "nodejs_compat", "allow_irrevocable_stub_storage"],
      kvNamespaces: ["BLUEPRINTS", "AVATARS"],
      r2Buckets: ["BLUEPRINT_CONTENT"],
      workerLoaders: { LOADER: {} },
      durableObjects: {
        UserDirectoryDurableObject: { className: "UserDirectoryDurableObject", useSQLite: true },
        OverseerDurableObject: { className: "OverseerDurableObject", useSQLite: true },
        TestProviderUser: { className: "TestProviderUser", useSQLite: true },
        QaGatekeeper: { className: "QaGatekeeper", useSQLite: true },
        QaConnectionStorage: { className: "QaConnectionStorage", useSQLite: true },
      },
    },
  })],
  test: {
    include: ["__tests__/provider-qa/*.test.ts"],
    // Forward only this bounded diagnostic switch; never ambient owner/provider environment.
    env: { QA_GRACEFUL_EVICTION_DIAGNOSTIC: process.env.QA_GRACEFUL_EVICTION_DIAGNOSTIC === "1" ? "1" : "0" },
    setupFiles: ["@gadgets/scripts/assert-workerd"],
    testTimeout: 20000,
  },
});

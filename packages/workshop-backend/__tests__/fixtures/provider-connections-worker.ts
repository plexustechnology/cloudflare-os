import type { ProviderConnectionDescriptor } from "@gadgets/workshop-shared/provider-connections";
import { UserDurableObject } from "../../src/user.js";
export * from "./external-observer-worker.js";

/** Synthetic private service fixture exercising the production UserDO index and owner context. */
export class TestProviderUser extends UserDurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, { ...env, AI_PROVIDER_ADAPTER: {
      async fetch(request: RequestInfo | URL, options?: RequestInit): Promise<Response> {
        const req = new Request(request, options);
        if (req.url !== "https://provider-adapter.internal/internal/v1/connections") throw new Error("unexpected route");
        const body = await req.json() as {
          action: string; ownerId: string; connectionId: string; expectedGeneration?: number;
          input?: { label: string; consent: ProviderConnectionDescriptor["consent"] };
        };
        if (body.ownerId !== ctx.id.toString()) throw new Error("untrusted owner");
        const mode = ctx.storage.kv.get<string>("fixture.mode");
        if (mode === "stalled-body") return new Response(new ReadableStream<Uint8Array>({
          cancel() { ctx.storage.kv.put("fixture.cancelled", true); },
        }));
        if (mode === "disabled") return Response.json({ ok: false, error: { code: "adapter_disabled" } }, { status: 503 });
        if (body.action === "available") return Response.json({ ok: true, available: true });
        const key = `fixture.connection:${body.connectionId}`;
        let connection = ctx.storage.kv.get<ProviderConnectionDescriptor>(key);
        if (mode === "lost-before-write" && body.action === "create") throw new Error("SYNTHETIC_SECRET_ERROR");
        if (body.action === "create" || body.action === "reconnect") {
          if ((body.action === "create" && connection) || (body.action === "reconnect" &&
              connection?.generation !== body.expectedGeneration)) {
            return Response.json({ ok: false, error: { code: "reconnect_required" } }, { status: 409 });
          }
          connection = { connectionId: body.connectionId, label: body.input!.label,
            consent: body.input!.consent, provider: "openai", transport: "openai-api-responses",
            status: "pending", credentialConfigured: true, generation: (connection?.generation ?? 0) + 1,
            credentialRevision: (connection?.credentialRevision ?? 0) + 1, createdAt: Date.now(), updatedAt: Date.now() };
          ctx.storage.kv.put(key, connection);
          if (mode === "lost-after-write") throw new Error("SYNTHETIC_SECRET_ERROR");
        }
        if (!connection) return Response.json({ ok: false, error: { code: "connection_required" } }, { status: 404 });
        if (body.action === "disconnect") {
          connection = { ...connection, status: "disabled", credentialConfigured: false,
            generation: connection.generation + 1, updatedAt: Date.now() };
          ctx.storage.kv.put(key, connection);
        }
        const model = mode === "encoded-model" ? `f${":".repeat(127)}` : "fixture-model";
        return Response.json({ ok: true, connection: { ...connection, extraCredential: "SYNTHETIC_PRIVATE_CREDENTIAL" },
          ...(body.action === "discover" ? { catalog: { status: "fresh", fetchedAt: Date.now(), models: [{
            id: `provider-connection/${body.connectionId}/${encodeURIComponent(model)}`, model, name: model,
            capabilities: { contextWindow: null, maxOutputTokens: null, images: "unknown", reasoning: "unknown" },
          }] } } : {}),
        });
      },
    } });
  }
}

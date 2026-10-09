# Deployment-owned Chat Completions model

An optional `OPENAI_COMPATIBLE_CONFIG` JSON variable configures one fixed text-only model in the
existing Workshop backend. It is available in the deployment-funded AI Gateway catalog, alongside
other configured providers, but inference bypasses AI Gateway billing. The descriptor contains
`model`, `name`, canonical `/v1` `baseUrl`, `transport` (`vpc-service` or `https`), `contextWindow`,
`outputLimit`, `timeoutMs` and `maxConcurrent`. No endpoint, model, service or credential is built in.

Supply `OPENAI_COMPATIBLE_API_KEY` as a backend secret. A `vpc-service` route also requires
`OPENAI_COMPATIBLE_VPC_SERVICE`, a fixed VPC Service fetch binding; never bind an entire network.
An authenticated HTTPS tunnel may additionally use the paired backend secrets
`OPENAI_COMPATIBLE_ACCESS_CLIENT_ID` and `OPENAI_COMPATIBLE_ACCESS_CLIENT_SECRET`.
The origin must restrict inference separately from administrative routes.

The catalog ID is `deployment-openai-compatible/<served-model>`. This prefix is reserved against
personal-model replacement even when disabled. Removing the variable disables catalog discovery
and makes explicit references unavailable. It does not change preferences or provision/delete resources.

Transport owns the exact POST `/v1/chat/completions` URL, auth headers, model descriptor and SDK
options. Caller URLs, credentials, headers and fetch overrides are ignored. Redirects and retries
are disabled. Conservative compatibility uses system role, JSON function tools, `max_tokens`, and
no store/developer/strict/reasoning/cache-affinity/streaming-usage extensions. Validate the actual
server and tool/reasoning parser before enabling it.

`maxConcurrent` is per Worker isolate; enforce global admission at the origin. The deadline bounds
the entire stream and cancellation aborts fetch. Response bytes are limited to 2 MiB. Output is
clamped to the deployment cap. The preflight bounds serialized UTF-8 bytes against the context
window minus response and 1,024 framing reserve; this intentionally conservative guard can reject
before the tokenizer limit. The origin must perform authoritative tokenizer/template validation.
Failures are sanitized and never trigger another provider. Local synthetic workerd tests exercise
the pi adapter; they are not live-origin acceptance evidence.

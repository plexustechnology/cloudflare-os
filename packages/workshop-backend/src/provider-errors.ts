import type { ProviderInferenceErrorCode } from "@gadgets/workshop-shared/provider-inference";

const FAILURES: Record<ProviderInferenceErrorCode, { message: string; statusCode: number; expected: boolean }> = {
  connection_required: { message: "Connect an OpenAI API account and choose its model.", statusCode: 404, expected: true },
  reconnect_required: { message: "Reconnect this OpenAI connection and choose its model again.", statusCode: 409, expected: true },
  connection_forbidden: { message: "Use an unshared chat owned by this connection's account. Paid context summaries also require separate consent.", statusCode: 403, expected: true },
  model_unavailable: { message: "Choose a model available for this OpenAI connection.", statusCode: 404, expected: true },
  usage_limit: { message: "This connection cannot accept another request right now. Wait before explicitly retrying; check your OpenAI account if this persists.", statusCode: 429, expected: true },
  rate_limited: { message: "A rate or usage limit prevented this request. Check your OpenAI account, then explicitly retry when available.", statusCode: 429, expected: true },
  invalid_request: { message: "This personal inference request was rejected.", statusCode: 400, expected: true },
  unsupported_feature: { message: "The selected OpenAI route does not support this request.", statusCode: 400, expected: true },
  adapter_disabled: { message: "Personal OpenAI inference is disabled for this deployment.", statusCode: 503, expected: true },
  cancelled: { message: "OpenAI inference was cancelled.", statusCode: 499, expected: true },
  stream_incomplete: { message: "OpenAI returned an incomplete response. You may explicitly retry.", statusCode: 502, expected: false },
  provider_unavailable: { message: "OpenAI inference is unavailable. Retry explicitly when the connection is available.", statusCode: 503, expected: false },
};

/** Classifies only fixed personal categories; unknown diagnostics and their causes are discarded. */
export function classifyPersonalProviderFailure(caught: unknown, upstreamStatus?: number, cancelled = false) {
  const candidate = caught instanceof Error ? caught.message : undefined;
  const code: ProviderInferenceErrorCode = cancelled ? "cancelled" :
    candidate && Object.hasOwn(FAILURES, candidate) ? candidate as ProviderInferenceErrorCode : "provider_unavailable";
  const failure = FAILURES[code];
  return { ...failure, code, error: new Error(code),
    // A category status classifies the failure; only a bounded observed error status overrides it.
    statusCode: Number.isSafeInteger(upstreamStatus) && upstreamStatus! >= 400 && upstreamStatus! <= 599
      ? upstreamStatus! : failure.statusCode };
}

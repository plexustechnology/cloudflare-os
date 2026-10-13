import type { RpcStub } from 'capnweb'
import type { ProviderConnectionsApi, ProviderConnectionInput } from '@gadgets/workshop-shared/provider-connections-api'
import type { ProviderConnectionDescriptor, ProviderConnectionCatalog } from '@gadgets/workshop-shared/provider-connections'

/** Fixed owner guidance; never render or log arbitrary RPC/provider diagnostics. */
export const providerErrorMessage = (error: unknown): string => {
  const code = error instanceof Error ? error.message : ''
  switch (code) {
    case 'rate_limited': return 'OpenAI is limiting requests. Wait, then refresh or try again.'
    case 'reconnect_required': return 'Reconnect this connection, then choose the model again.'
    case 'connection_forbidden': return 'This connection is unavailable to this account. Refresh your connections.'
    case 'adapter_disabled': return 'Personal inference is unavailable in this deployment.'
    case 'unsupported_feature': return 'This feature is unavailable. Choose a supported model explicitly.'
    case 'connection_required': return 'This connection has no key configured. Reconnect to finish setup.'
    case 'invalid_request': return 'This selection is unavailable. Refresh the connection and model catalog.'
    case 'provider_unavailable': return 'OpenAI is unavailable. Try refreshing later.'
    default: return 'The outcome could not be confirmed. Refresh and inspect your connections before trying again.'
  }
}

/** Catalog freshness is time-bounded and must belong to the displayed authority generation. */
export const canSelectProviderModel = (
  connection: ProviderConnectionDescriptor,
  catalog: { generation: number; value: ProviderConnectionCatalog } | undefined,
  now = Date.now(),
): boolean => connection.inferenceEnabled === true && connection.status === 'pending' &&
  connection.credentialConfigured && connection.generation > 0 && catalog?.generation === connection.generation &&
  catalog.value.status === 'fresh' && catalog.value.fetchedAt !== null &&
  catalog.value.fetchedAt <= now && now - catalog.value.fetchedAt < 300_000

/** Own one cancellable key submission, with durable identity obtained before key admission. */
export const submitProviderCredential = (
  capability: RpcStub<ProviderConnectionsApi>,
  input: ProviderConnectionInput,
  existing?: ProviderConnectionDescriptor,
) => {
  let api: RpcStub<ProviderConnectionsApi>
  try { api = capability.dup() }
  catch (error) {
    return { cancel: () => {}, completion: Promise.resolve({ kind: 'error' as const, message: providerErrorMessage(error) }) }
  }
  let cancelled = false
  let connectionId = existing?.connectionId
  let pendingInput: ProviderConnectionInput | undefined = input
  let invalidation: Promise<void> | undefined
  const invalidate = (): Promise<void> => {
    if (!connectionId) return Promise.resolve()
    invalidation ??= (async () => { await api.disconnect(connectionId!) })()
    return invalidation
  }
  const cancel = () => {
    cancelled = true
    pendingInput = undefined
    input = { ...input, apiKey: '' }
    // The completion promise reports a failed invalidation safely; no unhandled diagnostic escapes.
    if (connectionId) void invalidate().catch(() => {})
  }
  const completion = (async () => {
    try {
      if (!existing) {
        const reserved = await api.reserve({ label: input.label, consent: input.consent })
        connectionId = reserved.connectionId
      }
      if (cancelled || !pendingInput) {
        await invalidate()
        return { kind: 'cancelled' as const }
      }
      const submitted = pendingInput
      pendingInput = undefined
      const connection = await api.reconnect(connectionId!, existing?.generation ?? 0, submitted)
      if (cancelled) {
        await invalidate()
        return { kind: 'cancelled' as const }
      }
      return { kind: 'saved' as const, connection }
    } catch (error) {
      return { kind: 'error' as const, message: providerErrorMessage(error) }
    } finally {
      pendingInput = undefined
      input = { ...input, apiKey: '' }
      api[Symbol.dispose]()
    }
  })()
  return { cancel, completion }
}

/** Personal profiles are minted by the server in this reserved namespace. */
export const isPersonalProviderModel = (id: string): boolean => id.startsWith('provider-connection/')

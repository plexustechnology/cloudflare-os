import { RpcStub, RpcTarget } from 'capnweb'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderConnectionsApi, ProviderConnectionInput } from '@gadgets/workshop-shared/provider-connections-api'
import type { ProviderConnectionDescriptor, ProviderConnectionCatalog } from '@gadgets/workshop-shared/provider-connections'
import { canSelectProviderModel, providerErrorMessage, submitProviderCredential } from './providerConnectionFlow'

const connection: ProviderConnectionDescriptor = {
  connectionId: 'reserved-id', label: 'Personal', provider: 'openai', transport: 'openai-api-responses',
  consent: { billing: 'openai-platform-api', ownerInteractive: true, sessionCompaction: false },
  status: 'pending', credentialConfigured: true, generation: 1, credentialRevision: 1,
  createdAt: 0, updatedAt: 0, inferenceEnabled: true,
}
const input = (): ProviderConnectionInput => ({ label: 'Personal', apiKey: 'synthetic-key', consent: connection.consent })
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}
class Controls extends RpcTarget implements ProviderConnectionsApi {
  reserveCall = vi.fn<ProviderConnectionsApi['reserve']>(async (_input) => ({ ...connection, generation: 0 }))
  reconnectCall = vi.fn<ProviderConnectionsApi['reconnect']>(async (_id, _generation, _input) => connection)
  disconnectCall = vi.fn<ProviderConnectionsApi['disconnect']>(async (_id) => ({ ...connection, status: 'disabled' as const }))
  reserve(_input: Pick<ProviderConnectionInput, 'label' | 'consent'>): Promise<ProviderConnectionDescriptor> { return this.reserveCall(_input) }
  reconnect(id: string, generation: number, value: ProviderConnectionInput): Promise<ProviderConnectionDescriptor> { return this.reconnectCall(id, generation, value) }
  disconnect(id: string): Promise<ProviderConnectionDescriptor> { return this.disconnectCall(id) }
  async list(): Promise<ProviderConnectionDescriptor[]> { return [connection] }
  async create(): Promise<ProviderConnectionDescriptor> { return connection }
  async status(): Promise<ProviderConnectionDescriptor> { return connection }
  async discover(): Promise<ProviderConnectionCatalog> { return { status: 'unknown', models: [], fetchedAt: null } }
  async selectModel(): Promise<import('@gadgets/workshop-shared/api').AiChatAuthorInfo> { return { type: 'agent', id: 'profile', name: 'Profile' } }
}

describe('personal connection intake', () => {
  it('obtains a durable ID without sending the key, then uploads once at generation zero', async () => {
    const controls = new Controls()
    using api = new RpcStub(controls)
    const operation = submitProviderCredential(api, input())
    expect(await operation.completion).toEqual({ kind: 'saved', connection })
    expect(controls.reserveCall).toHaveBeenCalledWith({ label: 'Personal', consent: connection.consent })
    expect(controls.reconnectCall).toHaveBeenCalledExactlyOnceWith('reserved-id', 0, input())
    expect(controls.disconnectCall).not.toHaveBeenCalled()
  })
  it('cancels a late reservation by its exact ID without uploading credentials', async () => {
    const controls = new Controls()
    const reserved = deferred<ProviderConnectionDescriptor>()
    controls.reserveCall.mockImplementation(() => reserved.promise)
    using api = new RpcStub(controls)
    const operation = submitProviderCredential(api, input())
    operation.cancel()
    reserved.resolve({ ...connection, connectionId: 'exact-late-id', generation: 0 })
    expect(await operation.completion).toEqual({ kind: 'cancelled' })
    expect(controls.reconnectCall).not.toHaveBeenCalled()
    expect(controls.disconnectCall).toHaveBeenCalledExactlyOnceWith('exact-late-id')
  })
  it('invalidates the reserved ID when credential admission resolves after cancellation', async () => {
    const controls = new Controls()
    const admitted = deferred<ProviderConnectionDescriptor>()
    controls.reconnectCall.mockImplementation(() => admitted.promise)
    using api = new RpcStub(controls)
    const operation = submitProviderCredential(api, input())
    await vi.waitFor(() => expect(controls.reconnectCall).toHaveBeenCalledTimes(1))
    operation.cancel()
    admitted.resolve(connection)
    expect(await operation.completion).toEqual({ kind: 'cancelled' })
    expect(controls.disconnectCall).toHaveBeenCalledExactlyOnceWith('reserved-id')
  })
  it('does not replay the key after an ambiguous reservation result', async () => {
    const controls = new Controls()
    controls.reserveCall.mockRejectedValue(new Error('synthetic sensitive provider diagnostic'))
    using api = new RpcStub(controls)
    const operation = submitProviderCredential(api, input())
    const outcome = await operation.completion
    expect(outcome.kind).toBe('error')
    expect(JSON.stringify(outcome)).not.toContain('sensitive')
    expect(controls.reconnectCall).not.toHaveBeenCalled()
    expect(controls.disconnectCall).not.toHaveBeenCalled()
  })
  it('captures the observed generation for explicit reconnect', async () => {
    const controls = new Controls()
    using api = new RpcStub(controls)
    await submitProviderCredential(api, input(), { ...connection, generation: 7 }).completion
    expect(controls.reserveCall).not.toHaveBeenCalled()
    expect(controls.reconnectCall).toHaveBeenCalledExactlyOnceWith('reserved-id', 7, input())
  })
})

describe('explicit model admission presentation', () => {
  const catalog = { generation: 1, value: { status: 'fresh' as const, models: [], fetchedAt: 100 } }
  it('requires deployment enablement, configured authority and a fresh current-generation catalog', () => {
    expect(canSelectProviderModel(connection, catalog, 200)).toBe(true)
    expect(canSelectProviderModel({ ...connection, inferenceEnabled: undefined }, catalog, 200)).toBe(false)
    expect(canSelectProviderModel({ ...connection, credentialConfigured: false }, catalog, 200)).toBe(false)
    expect(canSelectProviderModel({ ...connection, status: 'disabled' }, catalog, 200)).toBe(false)
    expect(canSelectProviderModel({ ...connection, status: 'reconnect-required' }, catalog, 200)).toBe(false)
    expect(canSelectProviderModel(connection, { ...catalog, generation: 2 }, 200)).toBe(false)
    expect(canSelectProviderModel(connection, catalog, 300_100)).toBe(false)
    expect(canSelectProviderModel(connection, undefined, 200)).toBe(false)
  })
  it('renders only fixed safe error categories', () => {
    expect(providerErrorMessage(new Error('rate_limited'))).toContain('limiting')
    expect(providerErrorMessage(new Error('reconnect_required'))).toContain('Reconnect')
    expect(providerErrorMessage(new Error('invalid_request'))).toContain('selection is unavailable')
    expect(providerErrorMessage(new Error('secret-marker'))).not.toContain('secret-marker')
  })
})

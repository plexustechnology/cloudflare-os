import { RpcStub, RpcTarget } from 'capnweb'
import type { ProviderSubscriptionAttempt, ProviderSubscriptionConnectionsApi, ProviderSubscriptionHandoff, ProviderSubscriptionInput, ProviderSubscriptionCompletion } from '@gadgets/workshop-shared/provider-connections-api'
import type { ProviderSubscriptionDescriptor } from '@gadgets/workshop-shared/provider-connections'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startSubscriptionConnection } from './subscriptionConnectionFlow'

const input: ProviderSubscriptionInput = { label: 'Subscription', consent: { billing: 'chatgpt-plan', ownerInteractive: true, sessionCompaction: false, acceptsProviderControlledOutput: true, acceptsSharedPlanAndCreditUsage: true } }
const connection: ProviderSubscriptionDescriptor = { ...input, connectionId: 'fixture', provider: 'openai', transport: 'openai-chatgpt-responses', status: 'pending', credentialConfigured: false, generation: 0, credentialRevision: 0, createdAt: 0, updatedAt: 0 }
const handoff: ProviderSubscriptionHandoff = { attemptId: '11111111-1111-4111-8111-111111111111', authorizationUrl: 'https://auth.openai.com/api/accounts/authorize', receiver: 'public', expiresAt: Date.now() + 60000 }
class Attempt extends RpcTarget implements ProviderSubscriptionAttempt {
  beginCall = vi.fn<() => Promise<ProviderSubscriptionHandoff>>(async () => handoff)
  completeCall = vi.fn<ProviderSubscriptionAttempt['complete']>(async (_text: string) => ({ outcome: 'saved', connection: { ...connection, credentialConfigured: true, generation: 2 } }))
  cancelCall = vi.fn<ProviderSubscriptionAttempt['cancel']>(async () => ({ ...connection, generation: 1 }))
  disposed = 0
  begin(): Promise<ProviderSubscriptionHandoff> { return this.beginCall() }
  complete(text: string): Promise<ProviderSubscriptionCompletion> { return this.completeCall(text) }
  cancel(): Promise<ProviderSubscriptionDescriptor> { return this.cancelCall() }
  [Symbol.dispose]() { this.disposed++ }
}
class Api extends RpcTarget implements ProviderSubscriptionConnectionsApi {
  attempt = new Attempt()
  async reserve(): Promise<ProviderSubscriptionDescriptor> { return connection }
  async prepare(): Promise<RpcStub<ProviderSubscriptionAttempt>> { return new RpcStub(this.attempt) }
  async list(): Promise<ProviderSubscriptionDescriptor[]> { return [connection] }
  async status(): Promise<ProviderSubscriptionDescriptor> { return connection }
  async cancelPending(): Promise<ProviderSubscriptionDescriptor> { return connection }
  async disconnect(): Promise<ProviderSubscriptionDescriptor> { return connection }
}
afterEach(() => vi.unstubAllGlobals());
describe('independent QA subscription transport outcomes', () => {
  it('a lost exact cancellation response while begin is pending remains outcome unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ready: true, port: 1455 })))
    const target = new Api(); let release!: (v: ProviderSubscriptionHandoff) => void
    target.attempt.beginCall.mockImplementation(() => new Promise(resolve => { release = resolve }))
    target.attempt.cancelCall.mockRejectedValue(new Error('SYNTHETIC_TRANSPORT_SECRET'))
    using api = new RpcStub(target)
    const flow = startSubscriptionConnection(api, input, undefined, 1455, 'p'.repeat(43), { onReady: () => {}, onCompleting: () => {} })
    await vi.waitFor(() => expect(target.attempt.beginCall).toHaveBeenCalledOnce())
    await flow.cancel(); release(handoff)
    const result = await flow.completion
    expect(result.kind).toBe('error')
    expect(JSON.stringify(result)).toContain('unknown')
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_TRANSPORT_SECRET')
    expect(target.attempt.completeCall).not.toHaveBeenCalled()
    expect(target.attempt.disposed).toBe(1)
    expect(target.attempt.cancelCall).toHaveBeenCalledOnce()
  })
  it('a lost exact cancellation response while waiting remains outcome unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/health') ? { ready: true, port: 1455 } : {})))
    const target = new Api(); target.attempt.cancelCall.mockRejectedValue(new Error('SYNTHETIC_SECRET'))
    using api = new RpcStub(target)
    const ready = vi.fn()
    const flow = startSubscriptionConnection(api, input, undefined, 1455, 'p'.repeat(43), { onReady: ready, onCompleting: () => {} })
    await vi.waitFor(() => expect(ready).toHaveBeenCalled())
    await flow.cancel()
    const result = await flow.completion
    expect(result.kind).toBe('error')
    expect(JSON.stringify(result)).toContain('unknown')
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET')
    expect(target.attempt.disposed).toBe(1)
    expect(target.attempt.completeCall).not.toHaveBeenCalled()
    expect(target.attempt.cancelCall).toHaveBeenCalledOnce()
  })
  it('setup success followed by blocked polling enables manual without a second begin or setup', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { requests.push(url); if (url.endsWith('/result')) throw Error('restricted'); return Response.json(url.endsWith('/health') ? { ready: true, port: 1455 } : { callbackState: 'waiting' }) }))
    const target = new Api(); using api = new RpcStub(target); const ready = vi.fn()
    const flow = startSubscriptionConnection(api, input, undefined, 1455, 'p'.repeat(43), { onReady: ready, onCompleting: () => {} })
    await vi.waitFor(() => expect(ready).toHaveBeenLastCalledWith(handoff, false))
    flow.submitManual('encrypted-recovery')
    expect((await flow.completion).kind).toBe('saved')
    expect(ready.mock.calls.map(v => v[1])).toEqual([true, false])
    expect(requests.filter(v => v.endsWith('/setup'))).toHaveLength(1)
    expect(target.attempt.beginCall).toHaveBeenCalledOnce()
    expect(target.attempt.completeCall).toHaveBeenCalledExactlyOnceWith('encrypted-recovery')
    expect(target.attempt.disposed).toBe(1)
  })
  it('confirmed cancellation during waiting fences once and sends no cloud complete', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/health') ? { ready: true, port: 1455 } : {})))
    const target = new Api(); using api = new RpcStub(target); const ready = vi.fn()
    const flow = startSubscriptionConnection(api, input, undefined, 1455, 'p'.repeat(43), { onReady: ready, onCompleting: () => {} })
    await vi.waitFor(() => expect(ready).toHaveBeenCalled())
    await Promise.all([flow.cancel(), flow.cancel()])
    expect((await flow.completion).kind).toBe('cancelled')
    expect(target.attempt.cancelCall).toHaveBeenCalledOnce()
    expect(target.attempt.completeCall).not.toHaveBeenCalled()
    expect(target.attempt.disposed).toBe(1)
  })
})

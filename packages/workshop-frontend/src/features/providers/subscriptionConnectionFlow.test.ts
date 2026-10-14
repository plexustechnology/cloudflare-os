import { RpcStub, RpcTarget } from 'capnweb'
import type { ProviderSubscriptionAttempt, ProviderSubscriptionConnectionsApi, ProviderSubscriptionHandoff, ProviderSubscriptionInput, ProviderSubscriptionCompletion } from '@gadgets/workshop-shared/provider-connections-api'
import type { ProviderSubscriptionDescriptor } from '@gadgets/workshop-shared/provider-connections'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startSubscriptionConnection, subscriptionManualLink } from './subscriptionConnectionFlow'

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
  async discover(): Promise<never> { throw new Error("unused") }
  async selectModel(): Promise<never> { throw new Error("unused") }
  attempt = new Attempt()
  async reserve(): Promise<ProviderSubscriptionDescriptor> { return connection }
  async prepare(): Promise<RpcStub<ProviderSubscriptionAttempt>> { return new RpcStub(this.attempt) }
  async list(): Promise<ProviderSubscriptionDescriptor[]> { return [connection] }
  async status(): Promise<ProviderSubscriptionDescriptor> { return connection }
  async cancelPending(): Promise<ProviderSubscriptionDescriptor> { return connection }
  async disconnect(): Promise<ProviderSubscriptionDescriptor> { return connection }
}
afterEach(() => vi.unstubAllGlobals());
describe('one-shot owner subscription browser flow', () => {
  it('automatically relays only ciphertext once and releases its retained attempt', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/health') ? { ready: true, port: 1455 } : url.endsWith('/result') ? { capsule: 'encrypted-fixture' } : {})))
    const target = new Api(); using api = new RpcStub(target)
    const ready = vi.fn<(handoff: ProviderSubscriptionHandoff, automatic: boolean) => void>(), completing = vi.fn<() => void>()
    const flow = startSubscriptionConnection(api, input, undefined, 1455, 'p'.repeat(43), { onReady: ready, onCompleting: completing })
    expect((await flow.completion).kind).toBe('saved')
    expect(ready).toHaveBeenCalledWith(handoff, true); expect(completing).toHaveBeenCalledOnce()
    expect(target.attempt.completeCall).toHaveBeenCalledExactlyOnceWith('encrypted-fixture'); expect(target.attempt.disposed).toBe(1)
  })
  it('restricted local networking enables encrypted manual recovery without cloud replay', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('sensitive browser diagnostic') }))
    const target = new Api(); using api = new RpcStub(target)
    const ready = vi.fn<(handoff: ProviderSubscriptionHandoff, automatic: boolean) => void>()
    const flow = startSubscriptionConnection(api, input, undefined, 1455, 'p'.repeat(43), { onReady: ready, onCompleting: () => {} })
    await vi.waitFor(() => expect(ready).toHaveBeenCalledWith(handoff, false))
    flow.submitManual('opaque-manual'); flow.submitManual('second')
    expect((await flow.completion).kind).toBe('saved'); expect(target.attempt.completeCall).toHaveBeenCalledOnce()
    const link = subscriptionManualLink('https://fixture.test', 1455, 'p'.repeat(43), handoff)
    expect(new URL(link).search).toBe(''); expect(new URL(link).pathname).toBe('/setup'); expect(link).not.toContain('sensitive')
  })
  it('unknown cloud completion never retries and fences the exact intent before disposal', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/health') ? { ready: true, port: 1455 } : url.endsWith('/result') ? { capsule: 'encrypted-fixture' } : {})))
    const target = new Api(); target.attempt.completeCall.mockRejectedValue(new Error('SYNTHETIC_SECRET'))
    using api = new RpcStub(target)
    const flow = startSubscriptionConnection(api, input, undefined, 1455, 'p'.repeat(43), { onReady: () => {}, onCompleting: () => {} })
    const result = await flow.completion
    expect(result.kind).toBe('error'); expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET')
    expect(target.attempt.completeCall).toHaveBeenCalledOnce(); expect(target.attempt.cancelCall).toHaveBeenCalledOnce(); expect(target.attempt.disposed).toBe(1)
  })
  it('cancellation during delayed begin reports confirmed cancellation and never completes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ready: true, port: 1455 })))
    const target = new Api(); let release!: (v: ProviderSubscriptionHandoff) => void
    target.attempt.beginCall.mockImplementation(() => new Promise(resolve => { release = resolve }))
    using api = new RpcStub(target)
    const flow = startSubscriptionConnection(api, input, undefined, 1455, 'p'.repeat(43), { onReady: () => {}, onCompleting: () => {} })
    await vi.waitFor(() => expect(target.attempt.beginCall).toHaveBeenCalledOnce())
    await flow.cancel(); release(handoff)
    expect((await flow.completion).kind).toBe('cancelled'); expect(target.attempt.completeCall).not.toHaveBeenCalled(); expect(target.attempt.disposed).toBe(1)
  })
  it.each([false, true])('reports explicit declined sign-in with prior grant=%s instead of inferring from generation', async prior => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async url => Response.json(String(url).endsWith('/health') ? { ready: true, port: 1455 } : String(url).endsWith('/result') ? { capsule: 'encrypted-fixture' } : {})))
    const target = new Api(); using api = new RpcStub<ProviderSubscriptionConnectionsApi>(target)
    const current = { ...connection, generation: prior ? 2 : 0, credentialConfigured: prior }
    // Even advanced metadata from another tab cannot turn this exact denied callback into success.
    target.attempt.completeCall.mockResolvedValue({ outcome: 'denied', connection: { ...current, generation: prior ? 3 : 1 } })
    const flow = startSubscriptionConnection(api, input, prior ? current : undefined, 1455, 'p'.repeat(43), { onReady: () => {}, onCompleting: () => {} })
    const result = await flow.completion
    expect(result.kind).toBe('declined'); expect(result.connection?.credentialConfigured).toBe(prior)
    expect(target.attempt.completeCall).toHaveBeenCalledOnce(); expect(target.attempt.cancelCall).not.toHaveBeenCalled()
  })
})

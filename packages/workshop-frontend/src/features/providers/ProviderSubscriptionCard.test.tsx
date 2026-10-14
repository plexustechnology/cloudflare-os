// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { RpcStub, RpcTarget } from 'capnweb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderSubscriptionConnectionsApi, ProviderSubscriptionDiscovery, ProviderSubscriptionSelection } from '@gadgets/workshop-shared/provider-connections-api'
import type { ProviderSubscriptionDescriptor } from '@gadgets/workshop-shared/provider-connections'
import { ProviderSubscriptionCard } from './ProviderSubscriptionCard'
import { personalProviderFunding } from './providerConnectionFlow'
import { ComposerModelSelector } from '../chat/composer/ComposerModelSelector'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
class ResizeObserverFixture { observe() {} disconnect() {} unobserve() {} }
vi.stubGlobal('ResizeObserver', ResizeObserverFixture)
vi.stubGlobal('PointerEvent', MouseEvent)
Element.prototype.scrollIntoView ??= () => {}
const connection: ProviderSubscriptionDescriptor = { connectionId: '11111111-1111-4111-8111-111111111111', label: 'Plan',
  provider: 'openai', transport: 'openai-chatgpt-responses', status: 'pending', credentialConfigured: true, generation: 2, credentialRevision: 2,
  createdAt: 1, updatedAt: 1, inferenceEnabled: true, registration: { status: 'verified', clientId: 'fixture-client' },
  consent: { billing: 'chatgpt-plan', ownerInteractive: true, sessionCompaction: true, acceptsProviderControlledOutput: true, acceptsSharedPlanAndCreditUsage: true } }
const discovery = (): ProviderSubscriptionDiscovery => ({ connection: { ...connection, credentialRevision: 3 },
  catalog: { status: 'fresh', fetchedAt: Date.now(), models: [{ id: `provider-connection/${connection.connectionId}/fixture-model`, model: 'fixture-model', name: 'Plan model',
    capabilities: { contextWindow: null, maxOutputTokens: null, images: 'unknown', reasoning: 'unknown' } }] } })
class Controls extends RpcTarget implements ProviderSubscriptionConnectionsApi {
  disposed = 0
  discoverCall = vi.fn<ProviderSubscriptionConnectionsApi['discover']>(async () => discovery())
  selectCall = vi.fn<ProviderSubscriptionConnectionsApi['selectModel']>(async () => ({ profile: { type: 'agent', id: `provider-connection/${connection.connectionId}/fixture-model`, name: 'Plan model', funding: 'chatgpt-plan' }, showPlanWelcome: true }))
  discover(id: string): Promise<ProviderSubscriptionDiscovery> { return this.discoverCall(id) }
  selectModel(id: string, generation: number, revision: number, model: string): Promise<ProviderSubscriptionSelection> { return this.selectCall(id, generation, revision, model) }
  async list() { return [connection] }
  async reserve() { return connection }
  async prepare(): Promise<never> { throw new Error('unused') }
  async status() { return connection }
  async cancelPending() { return connection }
  async disconnect() { return connection }
  [Symbol.dispose]() { this.disposed++ }
}
describe('explicit current-revision subscription model selection', () => {
  const container = document.createElement('div')
  let root: ReturnType<typeof createRoot> | undefined
  const stubs: RpcStub<Controls>[] = []
  afterEach(async () => { await act(async () => root?.unmount()); for (const stub of stubs.splice(0)) stub[Symbol.dispose](); container.remove() })
  const stub = (target: Controls) => { const api = new RpcStub(target); stubs.push(api); return api }
  it('retains a renewed catalog after one refresh, selects explicitly and offers the owner welcome', async () => {
    const target = new Controls(); const api = stub(target); const modelsChanged = vi.fn<() => Promise<void>>(async () => {})
    let current = connection
    const changed = async () => { current = { ...connection, credentialRevision: 3 }; render() }
    const render = () => root!.render(<ProviderSubscriptionCard api={api} connection={current} onReconnect={() => {}} onChanged={changed} onModelsChanged={modelsChanged} />)
    document.body.append(container); root = createRoot(container); await act(async () => render())
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Refresh model catalog')!.click())
    const choose = container.querySelector<HTMLButtonElement>('button[aria-label="Choose Plan model"]')!
    expect(choose.disabled).toBe(false); expect(target.discoverCall).toHaveBeenCalledOnce(); expect(target.selectCall).not.toHaveBeenCalled()
    await act(async () => choose.click())
    expect(target.selectCall).toHaveBeenCalledWith(connection.connectionId, 2, 3, 'fixture-model'); expect(modelsChanged).toHaveBeenCalledOnce()
    expect(document.body.textContent).toContain('You’re using your ChatGPT plan'); expect(document.body.textContent).toContain('Eligible requests')
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Got it')!.click())
    expect(document.body.textContent).not.toContain('You’re using your ChatGPT plan')
  })
  it('drops delayed old-capability discovery and keeps the replacement capability usable', async () => {
    const old = new Controls(); let release!: (value: ProviderSubscriptionDiscovery) => void
    old.discoverCall.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const oldApi = stub(old); const fresh = new Controls(); const freshApi = stub(fresh); const changed = vi.fn<() => Promise<void>>(async () => {})
    document.body.append(container); root = createRoot(container)
    const render = (api: RpcStub<Controls>) => root!.render(<ProviderSubscriptionCard api={api} connection={connection} onReconnect={() => {}} onChanged={changed} />)
    await act(async () => render(oldApi))
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Refresh model catalog')!.click())
    await act(async () => render(freshApi)); await act(async () => release(discovery()))
    expect(changed).not.toHaveBeenCalled(); expect(container.textContent).not.toContain('Plan model')
    expect([...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Refresh model catalog')!.disabled).toBe(false)
  })
  it('uses only server personal funding for the selected composer indication', async () => {
    expect(personalProviderFunding({ id: 'custom-model', funding: 'chatgpt-plan' })).toBeUndefined()
    const plan = { type: 'agent' as const, id: `provider-connection/${connection.connectionId}/fixture-model`, name: 'Plan', funding: 'chatgpt-plan' as const }
    document.body.append(container); root = createRoot(container)
    await act(async () => root!.render(<ComposerModelSelector models={[plan, { type: 'agent', id: 'deployment', name: 'Deployment' }]} selectedModel={plan.id} onModelChange={() => {}} />))
    expect(container.textContent).toContain('Using ChatGPT plan'); expect(container.querySelector('a')!.rel).toBe('noopener noreferrer')
    await act(async () => root!.render(<ComposerModelSelector models={[plan]} selectedModel="deployment" onModelChange={() => {}} />))
    expect(container.textContent).not.toContain('Using ChatGPT plan')
  })
  it.each(['generation', 'revision', 'source'] as const)('drops delayed selection success after an external %s change without replay', async change => {
    const target = new Controls(); const api = stub(target)
    target.discoverCall.mockResolvedValue({ ...discovery(), connection })
    let release!: (value: ProviderSubscriptionSelection) => void
    target.selectCall.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const changed = vi.fn<() => Promise<void>>(async () => {})
    const modelsChanged = vi.fn<() => Promise<void>>(async () => {})
    document.body.append(container); root = createRoot(container)
    const render = (source: RpcStub<Controls>, current: ProviderSubscriptionDescriptor) => root!.render(<ProviderSubscriptionCard api={source} connection={current} onReconnect={() => {}} onChanged={changed} onModelsChanged={modelsChanged} />)
    await act(async () => render(api, connection))
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Refresh model catalog')!.click())
    changed.mockClear()
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Choose Plan model"]')!.click())
    const replacement = change === 'source' ? stub(new Controls()) : api
    await act(async () => render(replacement, { ...connection, generation: change === 'generation' ? 3 : 2, credentialRevision: change === 'revision' ? 3 : 2 }))
    if (change === 'source') api[Symbol.dispose]()
    await act(async () => release({ profile: { type: 'agent', id: `provider-connection/${connection.connectionId}/fixture-model`, name: 'Plan', funding: 'chatgpt-plan' }, showPlanWelcome: true }))
    expect(target.selectCall).toHaveBeenCalledOnce(); expect(changed).not.toHaveBeenCalled(); expect(modelsChanged).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('You’re using your ChatGPT plan'); expect(container.textContent).not.toContain('Model added')
    expect([...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Refresh model catalog')!.disabled).toBe(false)
    expect(target.disposed).toBe(change === 'source' ? 1 : 0)
  })
  it('hides selection feedback after revision changes during model refresh and suppresses its late failure', async () => {
    const target = new Controls(); const api = stub(target)
    target.discoverCall.mockResolvedValue({ ...discovery(), connection })
    const changed = vi.fn<() => Promise<void>>(async () => {})
    let reject!: (reason: Error) => void
    const modelsChanged = vi.fn<() => Promise<void>>(() => new Promise((_resolve, decline) => { reject = decline }))
    document.body.append(container); root = createRoot(container)
    const render = (revision: number) => root!.render(<ProviderSubscriptionCard api={api} connection={{ ...connection, credentialRevision: revision }} onReconnect={() => {}} onChanged={changed} onModelsChanged={modelsChanged} />)
    await act(async () => render(2))
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Refresh model catalog')!.click())
    changed.mockClear()
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Choose Plan model"]')!.click())
    expect(document.body.textContent).toContain('You’re using your ChatGPT plan')
    await act(async () => render(3))
    expect(document.body.textContent).not.toContain('You’re using your ChatGPT plan'); expect(container.textContent).not.toContain('Model added')
    await act(async () => reject(new Error('OLD_MODEL_REFRESH')))
    expect(changed).not.toHaveBeenCalled(); expect(container.querySelector('[role="alert"]')).toBeNull()
    expect([...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Refresh model catalog')!.disabled).toBe(false)
  })
  it.each([false, true])('reports its own follow-up failure under the matched displayed scope; renewed props=%s', async alreadyUpdated => {
    const target = new Controls(); const api = stub(target)
    let current = connection
    let reject!: (reason: Error) => void
    const changed = () => {
      if (alreadyUpdated) { current = { ...connection, credentialRevision: 3 }; render() }
      return new Promise<void>((_resolve, decline) => { reject = decline })
    }
    const render = () => root!.render(<ProviderSubscriptionCard api={api} connection={current} onReconnect={() => {}} onChanged={changed} />)
    document.body.append(container); root = createRoot(container); await act(async () => render())
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Refresh model catalog')!.click())
    await act(async () => reject(new Error('CURRENT_STATUS_REFRESH')))
    expect(target.discoverCall).toHaveBeenCalledOnce(); expect(target.selectCall).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Refresh status and the model catalog'); expect(container.textContent).not.toContain('CURRENT_STATUS_REFRESH'); expect(container.textContent).not.toContain('fresh sign-in')
    await act(async () => { current = { ...connection, credentialRevision: 3 }; render() })
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Choose Plan model"]')!.disabled).toBe(false)
    expect(container.querySelectorAll('[role="alert"]').length).toBe(alreadyUpdated ? 1 : 0)
  })
  it.each(['invalid_request', 'reconnect_required'])('uses model-specific safe guidance for %s without replay', async code => {
    const target = new Controls(); const api = stub(target)
    target.discoverCall.mockRejectedValue(new Error(code))
    document.body.append(container); root = createRoot(container)
    await act(async () => root!.render(<ProviderSubscriptionCard api={api} connection={connection} onReconnect={() => {}} onChanged={async () => {}} />))
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Refresh model catalog')!.click())
    const message = container.querySelector('[role="alert"]')?.textContent ?? ''
    expect(message).toContain(code === 'invalid_request' ? 'model catalog' : 'Reconnect this connection')
    expect(message).not.toMatch(/helper|sign-in handoff|fresh sign-in/)
    expect(target.discoverCall).toHaveBeenCalledOnce(); expect(target.selectCall).not.toHaveBeenCalled()
  })
})

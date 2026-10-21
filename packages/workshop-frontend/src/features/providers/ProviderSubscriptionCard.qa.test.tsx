// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { RpcStub, RpcTarget } from 'capnweb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderSubscriptionConnectionsApi, ProviderSubscriptionDiscovery, ProviderSubscriptionSelection } from '@gadgets/workshop-shared/provider-connections-api'
import type { ProviderSubscriptionDescriptor } from '@gadgets/workshop-shared/provider-connections'
import { ProviderSubscriptionCard } from './ProviderSubscriptionCard'

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
}
describe('independent QA current-revision subscription UI failures', () => {
  const container = document.createElement('div')
  let root: ReturnType<typeof createRoot> | undefined
  let api: RpcStub<Controls> | undefined
  afterEach(async () => { await act(async () => root?.unmount()); api?.[Symbol.dispose](); container.remove() })
  it.each(['discover', 'select'] as const)('does not publish a delayed old-revision %s failure after current revision changes', async operation => {
    const target = new Controls(); api = new RpcStub(target)
    target.discoverCall.mockResolvedValue({ ...discovery(), connection })
    let reject!: (error: Error) => void
    if (operation === 'discover') target.discoverCall.mockImplementation(() => new Promise((_resolve, decline) => { reject = decline }))
    else target.selectCall.mockImplementation(() => new Promise((_resolve, decline) => { reject = decline }))
    document.body.append(container); root = createRoot(container)
    const render = (revision: number) => root!.render(<ProviderSubscriptionCard api={api!} connection={{ ...connection, credentialRevision: revision }} onReconnect={() => {}} onChanged={async () => {}} />)
    await act(async () => render(2))
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Refresh model catalog')!.click())
    if (operation === 'select') await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Choose Plan model"]')!.click())
    await act(async () => render(3))
    await act(async () => reject(new Error('SYNTHETIC_OLD_REVISION_ERROR')))
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.textContent).not.toContain('The outcome is unknown')
    expect(container.textContent).not.toContain('SYNTHETIC_OLD_REVISION_ERROR')
  })
})

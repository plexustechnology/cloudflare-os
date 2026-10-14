// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { RpcStub, RpcTarget } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { ProviderSubscriptionConnectionsApi, ProviderSubscriptionAttempt } from '@gadgets/workshop-shared/provider-connections-api'
import { describe, expect, it } from 'vitest'
import { useProviderSubscriptions } from './useProviderSubscriptions'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
class Controls extends RpcTarget implements ProviderSubscriptionConnectionsApi {
  disposed = 0
  async list() { return [] }
  async reserve(): Promise<never> { throw new Error('unused') }
  async prepare(): Promise<RpcStub<ProviderSubscriptionAttempt>> { throw new Error('unused') }
  async status(): Promise<never> { throw new Error('unused') }
  async cancelPending(): Promise<never> { throw new Error('unused') }
  async disconnect(): Promise<never> { throw new Error('unused') }
  [Symbol.dispose]() { this.disposed++ }
}
type Source = Pick<RpcStub<AuthenticatedApi>, 'getProviderSubscriptionConnectionsApi'>
const Probe = ({ source, retain }: { source: Source; retain?: (refresh: () => Promise<void>) => void }) => { const state = useProviderSubscriptions(source); retain?.(state.refresh); return <p>{state.loading ? 'loading' : state.api ? 'available' : 'unavailable'}</p> }
describe('subscription owner capability lifetime', () => {
  it('disposes late source capability and current capability exactly once', async () => {
    const previous = new Controls(), current = new Controls()
    let release!: (stub: RpcStub<ProviderSubscriptionConnectionsApi>) => void
    const late = new Promise<RpcStub<ProviderSubscriptionConnectionsApi>>(resolve => { release = resolve })
    const source1 = new RpcStub({ getProviderSubscriptionConnectionsApi: () => late })
    const source2 = new RpcStub({ getProviderSubscriptionConnectionsApi: () => new RpcStub(current) })
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
    try {
      await act(async () => root.render(<Probe source={source1} />))
      await act(async () => root.render(<Probe source={source2} />))
      await act(async () => { release(new RpcStub(previous)); await Promise.resolve() })
      expect(container.textContent).toBe('available'); expect(previous.disposed).toBe(1)
      await act(async () => root.unmount()); expect(current.disposed).toBe(1)
    } finally { source1[Symbol.dispose](); source2[Symbol.dispose](); container.remove() }
  })
  it('a retained old refresh cannot invalidate a replacement factory still loading', async () => {
    const previous = new Controls(), current = new Controls()
    let release!: (stub: RpcStub<ProviderSubscriptionConnectionsApi>) => void
    const pending = new Promise<RpcStub<ProviderSubscriptionConnectionsApi>>(resolve => { release = resolve })
    using source1 = new RpcStub({ getProviderSubscriptionConnectionsApi: () => new RpcStub(previous) })
    using source2 = new RpcStub({ getProviderSubscriptionConnectionsApi: () => pending })
    let oldRefresh!: () => Promise<void>
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
    try {
      await act(async () => root.render(<Probe source={source1} retain={refresh => { oldRefresh = refresh }} />))
      expect(container.textContent).toBe('available')
      await act(async () => root.render(<Probe source={source2} />))
      await act(async () => oldRefresh())
      await act(async () => { release(new RpcStub(current)); await Promise.resolve() })
      expect(container.textContent).toBe('available'); expect(previous.disposed).toBe(1)
    } finally { await act(async () => root.unmount()); container.remove() }
    expect(current.disposed).toBe(1)
  })
})

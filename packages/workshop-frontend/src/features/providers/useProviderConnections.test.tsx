// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RpcStub, RpcTarget } from 'capnweb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthenticatedApi, AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import type { ProviderConnectionsApi, ProviderConnectionInput } from '@gadgets/workshop-shared/provider-connections-api'
import type { ProviderConnectionDescriptor, ProviderConnectionCatalog } from '@gadgets/workshop-shared/provider-connections'
import { useProviderConnections } from './useProviderConnections'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
class Controls extends RpcTarget implements ProviderConnectionsApi {
  disposed = vi.fn<() => void>()
  async list(): Promise<ProviderConnectionDescriptor[]> { return [] }
  async reserve(_input: Pick<ProviderConnectionInput, 'label' | 'consent'>): Promise<ProviderConnectionDescriptor> { throw new Error('unused') }
  async create(): Promise<ProviderConnectionDescriptor> { throw new Error('unused') }
  async reconnect(): Promise<ProviderConnectionDescriptor> { throw new Error('unused') }
  async status(): Promise<ProviderConnectionDescriptor> { throw new Error('unused') }
  async discover(): Promise<ProviderConnectionCatalog> { throw new Error('unused') }
  async disconnect(): Promise<ProviderConnectionDescriptor> { throw new Error('unused') }
  async selectModel(): Promise<AiChatAuthorInfo> { throw new Error('unused') }
  [Symbol.dispose]() { this.disposed() }
}
type SourceApi = Pick<AuthenticatedApi, 'getProviderConnectionsApi'> & RpcTarget
class Source extends RpcTarget implements SourceApi {
  constructor(private obtain: () => Promise<RpcStub<ProviderConnectionsApi> | null>) { super() }
  getProviderConnectionsApi(): Promise<RpcStub<ProviderConnectionsApi> | null> { return this.obtain() }
}
const Probe = ({ source }: { source: Pick<RpcStub<AuthenticatedApi>, 'getProviderConnectionsApi'> }) => {
  const state = useProviderConnections(source)
  return <div>{state.api ? 'eligible' : state.loading ? 'loading' : state.error ? 'failed' : 'hidden'}</div>
}

describe('connection capability ownership', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined
  let source: RpcStub<SourceApi> | undefined
  afterEach(async () => {
    await act(async () => root?.unmount())
    source?.[Symbol.dispose]()
    container?.remove()
  })
  const mount = async (obtain: () => Promise<RpcStub<ProviderConnectionsApi> | null>) => {
    source = new RpcStub<SourceApi>(new Source(obtain))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<Probe source={source!} />))
  }
  it('hides the section when the server withholds the eligible capability', async () => {
    await mount(async () => null)
    expect(container?.textContent).toBe('hidden')
  })
  it('disposes the acquired RPC capability on cleanup', async () => {
    const controls = new Controls()
    await mount(async () => new RpcStub<ProviderConnectionsApi>(controls))
    expect(container?.textContent).toBe('eligible')
    await act(async () => root!.unmount())
    root = undefined
    expect(controls.disposed).toHaveBeenCalledTimes(1)
  })
  it('disposes a late capability without restoring access after cleanup', async () => {
    const controls = new Controls()
    let resolve!: (value: RpcStub<ProviderConnectionsApi>) => void
    await mount(() => new Promise(accept => { resolve = accept }))
    await act(async () => root!.unmount())
    root = undefined
    await act(async () => resolve(new RpcStub<ProviderConnectionsApi>(controls)))
    expect(controls.disposed).toHaveBeenCalledTimes(1)
    expect(container?.textContent).toBe('')
  })
})

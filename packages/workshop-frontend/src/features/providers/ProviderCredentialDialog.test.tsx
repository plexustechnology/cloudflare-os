// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RpcStub, RpcTarget } from 'capnweb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConnectionsApi, ProviderConnectionInput } from '@gadgets/workshop-shared/provider-connections-api'
import type { ProviderConnectionDescriptor, ProviderConnectionCatalog } from '@gadgets/workshop-shared/provider-connections'
import type { AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { ProviderCredentialDialog } from './ProviderCredentialDialog'
import { ProviderConnectionCard } from './ProviderConnectionCard'

const toast = vi.hoisted(() => vi.fn<(input: unknown) => void>());
vi.mock('@cloudflare/kumo', async importOriginal => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: toast }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
class TestResizeObserver { observe() {} disconnect() {} unobserve() {} }
vi.stubGlobal('ResizeObserver', TestResizeObserver)
vi.stubGlobal('PointerEvent', MouseEvent)
Element.prototype.scrollIntoView ??= () => {}
const record: ProviderConnectionDescriptor = {
  connectionId: 'synthetic-id', label: 'My OpenAI', provider: 'openai', transport: 'openai-api-responses',
  consent: { billing: 'openai-platform-api', ownerInteractive: true, sessionCompaction: false },
  status: 'pending', credentialConfigured: true, generation: 1, credentialRevision: 1,
  createdAt: 0, updatedAt: 0,
}
class Controls extends RpcTarget implements ProviderConnectionsApi {
  reserveCall = vi.fn<ProviderConnectionsApi['reserve']>(async (_input) => ({ ...record, generation: 0 }))
  reconnectCall = vi.fn<ProviderConnectionsApi['reconnect']>(async (_id, _generation, _input) => record)
  disconnectCall = vi.fn<ProviderConnectionsApi['disconnect']>(async (_id) => ({ ...record, status: 'disabled' as const }))
  reserve(input: Pick<ProviderConnectionInput, 'label' | 'consent'>): Promise<ProviderConnectionDescriptor> { return this.reserveCall(input) }
  reconnect(id: string, generation: number, input: ProviderConnectionInput): Promise<ProviderConnectionDescriptor> { return this.reconnectCall(id, generation, input) }
  disconnect(id: string): Promise<ProviderConnectionDescriptor> { return this.disconnectCall(id) }
  async list(): Promise<ProviderConnectionDescriptor[]> { return [record] }
  async create(): Promise<ProviderConnectionDescriptor> { return record }
  async status(): Promise<ProviderConnectionDescriptor> { return record }
  discoverCall = vi.fn<ProviderConnectionsApi['discover']>(async () => ({ status: 'unknown', models: [], fetchedAt: null }))
  selectCall = vi.fn<ProviderConnectionsApi['selectModel']>(async () => ({ type: 'agent', id: 'profile', name: 'Profile' }))
  discover(id: string): Promise<ProviderConnectionCatalog> { return this.discoverCall(id) }
  selectModel(id: string, generation: number, model: string): Promise<AiChatAuthorInfo> { return this.selectCall(id, generation, model) }
}
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!
const edit = async (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})

describe('explicit API credential dialog', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  let api: RpcStub<ProviderConnectionsApi> | undefined
  afterEach(async () => {
    await act(async () => root?.unmount())
    api?.[Symbol.dispose]()
    container?.remove()
    vi.restoreAllMocks()
    toast.mockClear()
  })
  const mount = async (controls: Controls) => {
    api = new RpcStub<ProviderConnectionsApi>(controls)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<ProviderCredentialDialog api={api!} onClose={() => {}} onSaved={() => {}} onSettled={async () => {}} />))
    return {
      key: document.querySelector<HTMLInputElement>('input[type="password"]')!,
      label: document.querySelector<HTMLInputElement>('input:not([type="password"]):not([type="hidden"])')!,
      consent: document.querySelector<HTMLButtonElement>('[role="checkbox"]')!,
      form: document.querySelector<HTMLFormElement>('form')!,
    }
  }
  it('requires unchecked billing consent and clears the masked key on every submit attempt', async () => {
    const controls = new Controls()
    const elements = await mount(controls)
    expect(elements.consent.getAttribute('aria-checked')).toBe('false')
    await edit(elements.label, 'Personal')
    await edit(elements.key, 'synthetic-private-key')
    await act(async () => elements.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(elements.key.value).toBe('')
    expect(controls.reserveCall).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Accept API billing')
  })
  it('sends explicit consent with optional summaries off and never reports raw failure diagnostics', async () => {
    const controls = new Controls()
    controls.reconnectCall.mockRejectedValue(new Error('synthetic-private-key upstream diagnostic'))
    const logged = vi.spyOn(console, 'error')
    const elements = await mount(controls)
    await edit(elements.label, 'Personal')
    await edit(elements.key, 'synthetic-private-key')
    await act(async () => elements.consent.click())
    await act(async () => {
      elements.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(elements.key.value).toBe('')
    expect(controls.reserveCall).toHaveBeenCalledWith({ label: 'Personal', consent: record.consent })
    expect(controls.reconnectCall).toHaveBeenCalledExactlyOnceWith('synthetic-id', 0, {
      label: 'Personal', apiKey: 'synthetic-private-key', consent: record.consent,
    })
    expect(document.body.textContent).not.toContain('upstream diagnostic')
    expect(logged).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Refresh and inspect')
  })
  it('adds a model only after explicit fresh-catalog selection and leaves chat selection to the owner', async () => {
    const controls = new Controls()
    controls.discoverCall.mockResolvedValue({ status: 'fresh', fetchedAt: Date.now(), models: [{
      id: 'model-id', model: 'test-model', name: 'test-model',
      capabilities: { contextWindow: null, maxOutputTokens: null, images: 'unknown', reasoning: 'unknown' },
    }] })
    api = new RpcStub<ProviderConnectionsApi>(controls)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const onModelAdded = vi.fn<() => Promise<void>>(async () => {})
    await act(async () => root!.render(<ProviderConnectionCard api={api!} connection={{ ...record, inferenceEnabled: true }}
      onReconnect={() => {}} onChanged={async () => {}} onModelAdded={onModelAdded} />))
    await act(async () => button('Refresh model catalog').click())
    expect(controls.selectCall).not.toHaveBeenCalled()
    expect(button('Use model').disabled).toBe(false)
    await act(async () => button('Use model').click())
    expect(controls.selectCall).toHaveBeenCalledExactlyOnceWith('synthetic-id', 1, 'test-model')
    expect(onModelAdded).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith({ title: 'Model added. Choose it in your chat.', variant: 'success' })
    expect(localStorage.length).toBe(0)
  })
  it('requires a disconnect confirmation and keeps the provider-side revocation distinction visible', async () => {
    const controls = new Controls()
    api = new RpcStub<ProviderConnectionsApi>(controls)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<ProviderConnectionCard api={api!} connection={record}
      onReconnect={() => {}} onChanged={async () => {}} onModelAdded={async () => {}} />))
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Disconnect')!.click())
    expect(controls.disconnectCall).not.toHaveBeenCalled()
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('No other provider or billing route')
    expect(dialog.textContent).toContain('Revoke the API key separately')
    await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Disconnect')!.click())
    expect(controls.disconnectCall).toHaveBeenCalledExactlyOnceWith('synthetic-id')
  })

})

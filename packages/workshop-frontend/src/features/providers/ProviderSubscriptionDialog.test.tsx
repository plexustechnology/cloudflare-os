// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { RpcStub, RpcTarget } from 'capnweb'
import type { ProviderSubscriptionConnectionsApi, ProviderSubscriptionHandoff, ProviderSubscriptionAttempt } from '@gadgets/workshop-shared/provider-connections-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderSubscriptionDialog } from './ProviderSubscriptionDialog'
import { ProviderSubscriptionCard } from './ProviderSubscriptionCard'
import { startSubscriptionConnection } from './subscriptionConnectionFlow'

vi.mock('./subscriptionConnectionFlow', async original => ({ ...await original<object>(), startSubscriptionConnection: vi.fn<typeof startSubscriptionConnection>() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
class ResizeObserverFixture { observe() {} disconnect() {} unobserve() {} }
vi.stubGlobal('ResizeObserver', ResizeObserverFixture)
vi.stubGlobal('PointerEvent', MouseEvent)
Element.prototype.scrollIntoView ??= () => {}
const connection = { connectionId: 'fixture', label: 'My ChatGPT', consent: { billing: 'chatgpt-plan', ownerInteractive: true, sessionCompaction: false,
  acceptsProviderControlledOutput: true, acceptsSharedPlanAndCreditUsage: true }, provider: 'openai', transport: 'openai-chatgpt-responses',
  status: 'pending', credentialConfigured: true, generation: 2, credentialRevision: 2, createdAt: 0, updatedAt: 0, registration: { status: 'verified', clientId: 'oaiapp_fixture' } } as const
class Controls extends RpcTarget implements ProviderSubscriptionConnectionsApi {
  async discover(): Promise<never> { throw new Error("unused") }
  async selectModel(): Promise<never> { throw new Error("unused") }
  async list() { return [connection] }
  async reserve() { return connection }
  async prepare(): Promise<RpcStub<ProviderSubscriptionAttempt>> { throw new Error('unused') }
  async status() { return connection }
  async cancelPending() { return connection }
  async disconnect() { return connection }
}
const edit = async (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
describe('ChatGPT owner settings presentation', () => {
  const container = document.createElement('div')
  let root: ReturnType<typeof createRoot> | undefined
  let api: RpcStub<ProviderSubscriptionConnectionsApi> | undefined
  afterEach(async () => { await act(async () => root?.unmount()); api?.[Symbol.dispose](); container.remove(); vi.clearAllMocks() })
  it.each([{ kind: 'saved' as const, prior: true }, { kind: 'declined' as const, prior: false }, { kind: 'declined' as const, prior: true }, { kind: 'error' as const, prior: true }])('shows exact $kind outcome with prior grant=$prior after encrypted manual recovery', async scenario => {
    const cancel = vi.fn<() => Promise<undefined>>(async () => undefined), manual = vi.fn<(text: string) => void>()
    let resolve!: (value: Awaited<ReturnType<typeof startSubscriptionConnection>['completion']>) => void
    const completion = new Promise<Awaited<ReturnType<typeof startSubscriptionConnection>['completion']>>(accept => { resolve = accept })
    const handoff: ProviderSubscriptionHandoff = { attemptId: '11111111-1111-4111-8111-111111111111', authorizationUrl: 'https://auth.openai.com/api/accounts/authorize', receiver: 'public', expiresAt: Date.now() + 60000 }
    vi.mocked(startSubscriptionConnection).mockImplementation((_api, _input, _existing, _port, _pairing, callbacks) => { callbacks.onReady(handoff, false); return { cancel, submitManual: manual, completion } })
    api = new RpcStub<ProviderSubscriptionConnectionsApi>(new Controls()); document.body.append(container); root = createRoot(container)
    await act(async () => root!.render(<ProviderSubscriptionDialog api={api!} onClose={() => {}} onChanged={async () => {}} />))
    const checkboxes = [...document.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')]
    expect(checkboxes).toHaveLength(4); expect(checkboxes.every(v => v.getAttribute('aria-checked') === 'false')).toBe(true)
    const inputs = [...document.querySelectorAll<HTMLInputElement>('input:not([type="hidden"])')]
    await edit(inputs[0], 'My ChatGPT'); await edit(inputs[1], '1455'); await edit(inputs[2], 'p'.repeat(43))
    await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(startSubscriptionConnection).not.toHaveBeenCalled()
    await act(async () => { checkboxes.slice(0, 3).forEach(v => v.click()) })
    await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(startSubscriptionConnection).toHaveBeenCalledOnce()
    const localLink = document.querySelector<HTMLAnchorElement>('a[href^="http://127.0.0.1"]')!
    expect(localLink.rel).toBe('noopener noreferrer'); expect(new URL(localLink.href).search).toBe(''); expect(document.body.textContent).toContain('restricted the local bridge')
    expect(document.querySelector('a[href^="https://auth.openai.com"]')).toBeNull()
    await act(async () => resolve(scenario.kind === 'error' ? { kind: 'error', message: 'The outcome is unknown. Refresh status before starting a fresh sign-in.' }
      : { kind: scenario.kind, connection: { ...connection, credentialConfigured: scenario.prior } }))
    expect(document.body.textContent).toContain(scenario.kind === 'error' ? 'The outcome is unknown. Refresh status before starting a fresh sign-in.'
      : scenario.kind === 'saved' ? 'Authorization saved. Choose a model explicitly when personal inference is enabled.' : scenario.prior
      ? 'Sign-in declined. Your prior saved authorization remains.' : 'Sign-in declined. No new authorization was saved.')
    expect(document.body.textContent).not.toContain('This sign-in was cancelled')
    expect(document.querySelector('input[type="password"]')?.getAttribute('value')).toBe('')
  })
  it('saved association exposes public client and locally disabled inference without selectable models', async () => {
    api = new RpcStub<ProviderSubscriptionConnectionsApi>(new Controls()); document.body.append(container); root = createRoot(container)
    await act(async () => root!.render(<ProviderSubscriptionCard api={api!} connection={connection} onReconnect={() => {}} onChanged={async () => {}} />))
    expect(document.body.textContent).toContain('oaiapp_fixture'); expect(document.body.textContent).toContain('Personal inference is unavailable in this deployment')
    expect(document.body.textContent).not.toContain('Choose model'); expect(document.body.textContent).toContain('Refresh model catalog')
    expect(document.querySelector('a[href="https://chatgpt.com/settings/usage"]')).not.toBeNull()
  })
})

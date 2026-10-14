// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RpcStub, RpcTarget } from 'capnweb'
import { afterEach, expect, it, vi } from 'vitest'
import { ProviderOwnerSetup } from './ProviderOwnerSetup'

vi.mock('@cloudflare/kumo', () => ({ Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => createElement('button', props, children) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
class Source extends RpcTarget {
  constructor(private getId: () => Promise<string>) { super() }
  getProviderConnectionOwnerId() { return this.getId() }
}
let root: Root | undefined
let container: HTMLDivElement
const stubs: RpcStub<Source>[] = []
const source = (get: () => Promise<string>) => { const stub = new RpcStub(new Source(get)); stubs.push(stub); return stub }
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined
  stubs.splice(0).forEach(stub => stub[Symbol.dispose]())
  container?.remove()
})
const mount = async (api: RpcStub<Source>) => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(<ProviderOwnerSetup authenticatedApi={api} />))
}

it('obtains only the authenticated owner ID on explicit request without an adapter capability', async () => {
  const get = vi.fn<() => Promise<string>>(async () => 'a'.repeat(64))
  await mount(source(get))
  expect(get).not.toHaveBeenCalled()
  await act(async () => container.querySelector('button')!.click())
  expect(container.querySelector('[aria-label="Provider owner ID"]')?.textContent).toBe('a'.repeat(64))
})

it('hides an old account ID and ignores its pending result after account change', async () => {
  let finish!: (id: string) => void
  const first = source(() => new Promise(resolve => { finish = resolve }))
  await mount(first)
  await act(async () => container.querySelector('button')!.click())
  await act(async () => root!.render(<ProviderOwnerSetup authenticatedApi={source(async () => 'b'.repeat(64))} />))
  await act(async () => finish('a'.repeat(64)))
  expect(container.textContent).not.toContain('a'.repeat(64))
  await act(async () => container.querySelector('button')!.click())
  expect(container.textContent).toContain('b'.repeat(64))
})

it('withholds server diagnostics', async () => {
  await mount(source(async () => { throw new Error('sensitive server diagnostic') }))
  await act(async () => container.querySelector('button')!.click())
  expect(container.querySelector('[role="alert"]')).not.toBeNull()
  expect(container.textContent).not.toContain('sensitive server diagnostic')
})

// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, AiChatAuthorInfo } from '@gadgets/workshop-shared/api'

const host = vi.hoisted(() => ({ subPageId: undefined as string | undefined }))
vi.mock('./TeamsHostGate', () => ({ useTeamsHost: () => host }))
vi.mock('@cloudflare/kumo', () => ({
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button>,
  Loader: () => <span />,
}))
import { TeamsTabRoot } from './TeamsTabRoot'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const profile: AiChatAuthorInfo = { type: 'user', id: 'verified@example.test', name: 'Verified' }
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const api = (whoami: AuthenticatedApi['whoami']) => {
  const dispose = vi.fn<() => void>()
  // Borrowed test capability exposes only the real API members exercised here.
  const value: RpcStub<AuthenticatedApi> = Object.assign(Object.create(null), { whoami, [Symbol.dispose]: dispose })
  return { value, dispose }
}
let container: HTMLDivElement
let root: Root
let navigate: Mock<(destination: string) => void>
let retry: Mock<() => void>
const render = async (value: RpcStub<AuthenticatedApi> | null, path = '/teams/workspace/abc', search = '?chat=7', error: string | null = null) => {
  await act(async () => root.render(<TeamsTabRoot authenticatedApi={value} authError={error} isAuthLoading={false}
    pathname={path} search={search} navigateTo={navigate} onRetrySession={retry}><p>Protected Workshop</p></TeamsTabRoot>))
}
beforeEach(() => {
  host.subPageId = undefined
  navigate = vi.fn<(destination: string) => void>(); retry = vi.fn<() => void>()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers() })

describe('ordinary-session Teams tab', () => {
  it('waits for whoami, preserves exact chat, and never disposes the borrowed capability', async () => {
    const check = deferred<AiChatAuthorInfo>()
    const stub = api(() => check.promise)
    await render(stub.value)
    expect(container.textContent).toContain('Checking your Workshop session')
    expect(container.textContent).not.toContain('Protected Workshop')
    expect(navigate).not.toHaveBeenCalled()
    await act(async () => check.resolve(profile))
    expect(container.textContent).toContain('Protected Workshop')
    expect(navigate).not.toHaveBeenCalled()
    await act(async () => root.unmount())
    expect(stub.dispose).not.toHaveBeenCalled()
  })

  it('keeps a failed session private and offers the same exact chat in the browser', async () => {
    const stub = api(async () => { throw new Error('Access cookie unavailable') })
    await render(stub.value)
    expect(container.textContent).not.toContain('Protected Workshop')
    expect(container.querySelector('a')?.getAttribute('href')).toBe(`${window.location.origin}/workspace/abc?chat=7`)
    await act(async () => container.querySelector('button')?.click())
    expect(retry).toHaveBeenCalledOnce()
    expect(stub.dispose).not.toHaveBeenCalled()
  })

  it('does not treat a gadget author as an authenticated account', async () => {
    const stub = api(async () => ({ type: 'gadget', id: 'owner', name: 'App' }))
    await render(stub.value)
    expect(container.textContent).not.toContain('Protected Workshop')
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
  })

  it('ignores an old verification when a replacement capability arrives', async () => {
    const stale = deferred<AiChatAuthorInfo>(); const fresh = deferred<AiChatAuthorInfo>()
    const first = api(() => stale.promise); const second = api(() => fresh.promise)
    await render(first.value); await render(second.value)
    await act(async () => stale.resolve(profile))
    expect(container.textContent).not.toContain('Protected Workshop')
    await act(async () => fresh.resolve(profile))
    expect(container.textContent).toContain('Protected Workshop')
    expect(first.dispose).not.toHaveBeenCalled(); expect(second.dispose).not.toHaveBeenCalled()
  })

  it('bounds a stalled session and ignores its late success', async () => {
    vi.useFakeTimers()
    const check = deferred<AiChatAuthorInfo>(); const stub = api(() => check.promise)
    await render(stub.value)
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000) })
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    await act(async () => check.resolve(profile))
    expect(container.textContent).not.toContain('Protected Workshop')
  })

  it('validates the host hint and lands only after account verification', async () => {
    host.subPageId = '/workspace/target?chat=3'
    const check = deferred<AiChatAuthorInfo>(); const stub = api(() => check.promise)
    await render(stub.value, '/teams/workspaces', '')
    expect(navigate).not.toHaveBeenCalled()
    await act(async () => check.resolve(profile))
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/workspace/target?chat=3')
    await render(stub.value, '/teams/workspace/target', '?chat=3')
    expect(navigate).toHaveBeenCalledOnce()
  })

  it('ignores unsafe host hints and follows the current route after initial landing', async () => {
    host.subPageId = '//attacker.example/path'
    const stub = api(async () => profile)
    await render(stub.value)
    expect(navigate).not.toHaveBeenCalled()
    await render(null, '/teams/workspace/other', '?chat=12', 'Session expired')
    expect(container.querySelector('a')?.getAttribute('href')).toBe(`${window.location.origin}/workspace/other?chat=12`)
  })
})

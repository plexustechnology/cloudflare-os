// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const test = vi.hoisted(() => ({ root: undefined as Root | undefined, initialize: vi.fn<() => Promise<void>>(), socket: vi.fn<(...args: unknown[]) => unknown>() }))
vi.mock('react-dom/client', async importOriginal => {
  const actual = await importOriginal<typeof import('react-dom/client')>()
  return { ...actual, createRoot: (...args: Parameters<typeof actual.createRoot>) => { test.root = actual.createRoot(...args); return test.root } }
})
vi.mock('./teamsSdk', () => ({ teamsSdk: {
  initialize: () => test.initialize(), getContext: async () => ({ app: { theme: 'dark' } }),
  notifySuccess: async () => {}, registerOnThemeChangeHandler: () => {},
} }))
vi.mock('capnweb', () => ({ RpcPromise: class {}, newWebSocketRpcSession: (...args: unknown[]) => test.socket(...args) }))
vi.mock('@tanstack/react-router', () => ({ RouterProvider: () => <p>Workshop mounted</p> }))
vi.mock('../../router', () => ({ createRouter: () => ({}) }))
vi.mock('../../ThemeContext', () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock('../../FrontendErrorBoundary', () => ({ default: ({ children }: { children: ReactNode }) => children }))
vi.mock('../../components/AnnouncementBanner', () => ({ default: () => null }))
vi.mock('../../errorReporting', () => ({ installWorkshopErrorReporting: vi.fn<() => void>(), reportIssue: vi.fn<() => void>() }))
vi.mock('../../siteLogoUtils', () => ({ applySiteFavicon: vi.fn<() => void>(), cacheBustSiteLogoUrl: (url: string) => url }))
vi.mock('../../theme', () => ({ applyAccentColor: vi.fn<() => void>(), applyStoredThemeMode: vi.fn<() => void>() }))
vi.mock('@cloudflare/kumo', () => ({
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button>, Loader: () => <span />,
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
beforeEach(() => {
  vi.resetModules(); test.initialize.mockReset(); test.socket.mockReset()
  test.socket.mockReturnValue({ onRpcBroken: vi.fn<() => void>(), getServerConfig: async () => ({ siteName: 'Workshop' }) })
  container = document.createElement('div'); container.id = 'root'; document.body.append(container)
})
afterEach(async () => { await act(async () => test.root?.unmount()); test.root = undefined; container.remove(); window.history.replaceState(null, '', '/') })
describe('actual Workshop startup', () => {
  it('defers the Teams socket until the host is initialized', async () => {
    window.history.replaceState(null, '', '/teams/workspace/abc?chat=7')
    let resolve!: () => void; test.initialize.mockImplementation(() => new Promise<void>(yes => { resolve = yes }))
    await act(async () => { await import('../../main') }); expect(test.socket).not.toHaveBeenCalled()
    await act(async () => resolve()); expect(test.socket).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Workshop mounted')
  })
  it('starts ordinary browser routes without initializing Teams', async () => {
    window.history.replaceState(null, '', '/workspaces')
    await act(async () => { await import('../../main') })
    expect(test.socket).toHaveBeenCalledOnce(); expect(test.initialize).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Workshop mounted')
  })
  it('does not open an RPC socket when the host rejects initialization', async () => {
    window.history.replaceState(null, '', '/teams/workspaces'); test.initialize.mockRejectedValue(new Error('Host unavailable'))
    await act(async () => { await import('../../main') })
    expect(test.socket).not.toHaveBeenCalled(); expect(container.querySelector('[role="alert"]')).not.toBeNull()
  })
})

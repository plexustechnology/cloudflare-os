// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TeamsHostSession, initializeTeamsHost } from './teamsHost'
vi.mock('./teamsSdk', () => ({ teamsSdk: {} }))
vi.mock('@cloudflare/kumo', () => ({
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button>, Loader: () => <span />,
}))
import { TeamsHostGate, useTeamsHost } from './TeamsHostGate'
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const ready = (): TeamsHostSession => ({ state: { status: 'ready', context: { theme: 'light', isMultiWindow: false } }, dispose: vi.fn<() => void>() })
let container: HTMLDivElement; let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
describe('Teams host boot gate', () => {
  it('starts its application only after host readiness', async () => {
    let resolve!: (session: TeamsHostSession) => void
    const initialize = vi.fn<typeof initializeTeamsHost>(() => new Promise<TeamsHostSession>(yes => { resolve = yes }))
    const startRpc = vi.fn<() => void>()
    const App = () => { useEffect(() => { startRpc() }, []); return <p>Application</p> }
    await act(async () => root.render(<TeamsHostGate pathname="/teams/workspaces" initializeHost={initialize}><App /></TeamsHostGate>))
    expect(startRpc).not.toHaveBeenCalled()
    const session = ready(); await act(async () => resolve(session))
    expect(startRpc).toHaveBeenCalledOnce()
    await act(async () => root.unmount()); expect(session.dispose).toHaveBeenCalledOnce()
  })
  it('bypasses all SDK work outside the exact Teams boundary', async () => {
    const initialize = vi.fn<typeof initializeTeamsHost>()
    await act(async () => root.render(<TeamsHostGate pathname="/teams-other" initializeHost={initialize}><p>Browser application</p></TeamsHostGate>))
    expect(container.textContent).toBe('Browser application'); expect(initialize).not.toHaveBeenCalled()
  })
  it('recovers from host failure without prematurely starting the application', async () => {
    const initialize = vi.fn<typeof initializeTeamsHost>().mockResolvedValueOnce({ state: { status: 'error', reason: 'timeout' }, dispose: vi.fn<() => void>() }).mockResolvedValueOnce(ready())
    await act(async () => root.render(<TeamsHostGate pathname="/teams/workspace/abc" search="?chat=3" initializeHost={initialize}><p>Application</p></TeamsHostGate>))
    expect(container.querySelector('a')?.getAttribute('href')).toBe(`${window.location.origin}/workspace/abc?chat=3`)
    expect(container.textContent).not.toContain('Application')
    await act(async () => container.querySelector('button')?.click())
    expect(container.textContent).toContain('Application'); expect(initialize).toHaveBeenCalledTimes(2)
  })
  it('keeps the current application mounted across navigation and a host theme event', async () => {
    let change: Parameters<typeof initializeTeamsHost>[0]['onThemeChange']
    const initialize = vi.fn<typeof initializeTeamsHost>(async (options) => { change = options.onThemeChange; return ready() })
    const mounts = vi.fn<() => void>(); const unmounts = vi.fn<() => void>()
    const App = () => {
      const host = useTeamsHost(); useEffect(() => { mounts(); return () => { unmounts() } }, [])
      return <p>{host?.theme}</p>
    }
    const render = (path: string) => root.render(<TeamsHostGate pathname={path} initializeHost={initialize}><App /></TeamsHostGate>)
    await act(async () => render('/teams/workspaces')); await act(async () => render('/teams/workspace/other'))
    await act(async () => change?.('dark'))
    expect(container.textContent).toBe('dark'); expect(initialize).toHaveBeenCalledOnce()
    expect(mounts).toHaveBeenCalledOnce(); expect(unmounts).not.toHaveBeenCalled()
  })
})

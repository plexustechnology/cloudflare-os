// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ pathname: '/teams/workspaces' }))
vi.mock('@tanstack/react-router', () => ({ useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => string }) => select({ location: { pathname: state.pathname } }) }))
vi.mock('../../RpcContext', () => ({ useConnectionLost: () => false }))
vi.mock('../../TopBarNotice', () => ({ default: () => null }))
vi.mock('../../components/AppShell/CommandPalette', () => ({ default: () => null }))
vi.mock('../../components/AppShell/Sidebar', () => ({ default: (props: {
  collapsed: boolean; onToggleCollapsed: () => void; layout: { expandedWidth: string; collapsible: boolean }
}) => <aside data-collapsed={props.collapsed} data-expanded-width={props.layout.expandedWidth}>
  {props.layout.collapsible && <button onClick={props.onToggleCollapsed} aria-label={props.collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>Toggle</button>}
  <a href="/teams/workspaces">Workspaces</a><a href="/teams/outputs">Outputs</a>
</aside> }))
vi.mock('@cloudflare/kumo', () => ({ Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button> }))
import { TeamsAppShell } from './TeamsAppShell'
import { TEAMS_SIDEBAR_COLLAPSED_STORAGE_KEY } from './teamsLayout'
import { OPEN_COMMAND_PALETTE_EVENT } from '../../components/AppShell/commandPaletteBus'
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement; let root: Root; let resize: ResizeObserverCallback; let disconnect = vi.fn<() => void>()
beforeEach(() => {
  state.pathname = '/teams/workspaces'
  const values = new Map<string, string>()
  const storage: Storage = {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
  vi.stubGlobal('localStorage', storage)
  disconnect = vi.fn<() => void>()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resize = callback }
    observe() {} disconnect() { disconnect() }
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const render = async () => { await act(async () => root.render(<TeamsAppShell><p>Content</p></TeamsAppShell>)) }
const size = async (width: number) => { await act(async () => resize([Object.assign(Object.create(null), { contentRect: { width } })], Object.create(null))) }
const shell = () => container.querySelector<HTMLElement>('[data-teams-navigation]')!
const click = async (label: string) => { await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.click()) }

describe('Teams container navigation', () => {
  it('responds to container width rather than desktop viewport breakpoints', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1_600 })
    await render(); await size(320)
    expect(shell().dataset.teamsNavigation).toBe('drawer'); expect(container.querySelector('aside')).toBeNull()
    await size(800)
    expect(shell().dataset.teamsNavigation).toBe('rail'); expect(container.querySelector('[aria-label="Expand sidebar"]')).toBeNull()
    await size(1_100)
    expect(shell().dataset.teamsNavigation).toBe('sidebar-collapsed')
    await size(1_500)
    expect(shell().dataset.teamsNavigation).toBe('sidebar-expanded')
    expect(container.querySelector('aside')?.dataset.expandedWidth).toBe('240px')
    await act(async () => root.unmount()); expect(disconnect).toHaveBeenCalledOnce()
  })

  it('stores a Teams collapse choice separately from browser preferences', async () => {
    localStorage.setItem('gadgets:sidebar-collapsed', '0')
    await render(); await size(1_100); await click('Expand sidebar')
    expect(shell().dataset.teamsNavigation).toBe('sidebar-expanded')
    expect(localStorage.getItem(TEAMS_SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('0')
    expect(localStorage.getItem('gadgets:sidebar-collapsed')).toBe('0')
    await size(1_500); expect(shell().dataset.teamsNavigation).toBe('sidebar-expanded')
    await click('Collapse sidebar'); expect(localStorage.getItem(TEAMS_SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('1')
    expect(localStorage.getItem('gadgets:sidebar-collapsed')).toBe('0')
  })

  it('contains keyboard focus, closes on Escape, and restores the menu focus', async () => {
    await render(); await size(320)
    const menu = container.querySelector<HTMLButtonElement>('[aria-label="Open navigation"]')!
    menu.focus(); await click('Open navigation')
    const drawer = container.querySelector<HTMLElement>('[role="dialog"]')!
    expect(document.activeElement).toBe(drawer)
    const last = drawer.querySelectorAll('a')[1]; last.focus()
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })))
    expect(document.activeElement).toBe(drawer.querySelector('button'))
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(container.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(menu)
  })

  it('closes the drawer when the route or container band changes', async () => {
    await render(); await size(320); await click('Open navigation')
    state.pathname = '/teams/outputs'; await render()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    await click('Open navigation'); await size(800)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('closes navigation when its existing command palette control opens', async () => {
    await render(); await size(320); await click('Open navigation')
    await act(async () => window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT)))
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })
})

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { Button } from '@cloudflare/kumo'
import { List, X } from '@phosphor-icons/react'
import Sidebar from '../../components/AppShell/Sidebar'
import CommandPalette from '../../components/AppShell/CommandPalette'
import { OPEN_COMMAND_PALETTE_EVENT } from '../../components/AppShell/commandPaletteBus'
import ReconnectingChip from '../../components/ReconnectingChip'
import TopBarNotice from '../../TopBarNotice'
import { useConnectionLost } from '../../RpcContext'
import { parseTeamsSidebarCollapsed, resolveTeamsShellLayout, TEAMS_SIDEBAR_COLLAPSED_STORAGE_KEY } from './teamsLayout'

const readCollapsed = () => {
  try { return parseTeamsSidebarCollapsed(localStorage.getItem(TEAMS_SIDEBAR_COLLAPSED_STORAGE_KEY)) }
  catch { return null }
}

/** Reuses Workshop navigation while measuring the available Teams tab container. */
export const TeamsAppShell = ({ children }: { children: ReactNode }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const drawerRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const [width, setWidth] = useState(() => window.innerWidth)
  const [collapsedPreference, setCollapsedPreference] = useState(readCollapsed)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const connectionLost = useConnectionLost()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const layout = resolveTeamsShellLayout(width, collapsedPreference)
  const compact = layout.navigation === 'drawer'
  const canCollapse = layout.band === 'standard' || layout.band === 'wide'

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const measure = (next: number) => { if (next > 0) setWidth(next) }
    measure(container.getBoundingClientRect().width || window.innerWidth)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => { if (entry) measure(entry.contentRect.width) })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => { setDrawerOpen(false) }, [pathname, compact])

  useEffect(() => {
    if (!drawerOpen) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : menuButtonRef.current
    const drawer = drawerRef.current
    drawer?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setDrawerOpen(false); return }
      if (event.key !== 'Tab' || !drawer) return
      const items = [...drawer.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      const first = items[0]
      const last = items.at(-1)
      if (!first || !last) { event.preventDefault(); return }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === drawer)) {
        event.preventDefault(); last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      queueMicrotask(() => {
        const target = previousFocus?.isConnected ? previousFocus
          : containerRef.current?.querySelector<HTMLElement>('aside button, aside a[href]')
        target?.focus()
      })
    }
  }, [drawerOpen])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setDrawerOpen(false)
        setPaletteOpen((open) => !open)
      }
    }
    const onOpen = () => { setDrawerOpen(false); setPaletteOpen(true) }
    document.addEventListener('keydown', onKey)
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen)
    }
  }, [])

  const toggleCollapsed = () => {
    const next = !(collapsedPreference ?? layout.band !== 'wide')
    try { localStorage.setItem(TEAMS_SIDEBAR_COLLAPSED_STORAGE_KEY, next ? '1' : '0') } catch {}
    setCollapsedPreference(next)
  }
  const sidebarLayout = { expandedWidth: layout.expandedSidebarWidth ?? '240px', collapsible: canCollapse } as const

  return (
    <div ref={containerRef} className="flex h-full min-h-0 w-full min-w-0 overflow-hidden bg-kumo-base"
      data-teams-container-band={layout.band} data-teams-navigation={layout.navigation}>
      {!compact && <div className="flex h-full">
        <Sidebar collapsed={layout.navigation !== 'sidebar-expanded'} onToggleCollapsed={toggleCollapsed} layout={sidebarLayout} />
      </div>}
      {compact && drawerOpen && <>
        <div aria-hidden="true" className="fixed inset-0 z-40 bg-kumo-overlay/80" onClick={() => setDrawerOpen(false)} />
        <div ref={drawerRef} role="dialog" aria-modal="true" aria-label="Primary navigation" tabIndex={-1}
          className="fixed inset-y-0 left-0 z-50 outline-none">
          <Button onClick={() => setDrawerOpen(false)} aria-label="Close navigation" className="absolute right-2 top-2">
            <X size={16} />
          </Button>
          <Sidebar collapsed={false} onToggleCollapsed={() => setDrawerOpen(false)} layout={{ expandedWidth: '240px', collapsible: false }} />
        </div>
      </>}
      <div className="flex min-w-0 flex-1 flex-col" inert={drawerOpen ? true : undefined} aria-hidden={drawerOpen ? true : undefined}>
        <header className="relative flex shrink-0 items-center justify-between border-b border-kumo-line bg-kumo-base px-3"
          style={{ height: layout.topBarHeight }}>
          {compact && <Button ref={menuButtonRef} variant="secondary" aria-expanded={drawerOpen}
            aria-label="Open navigation" onClick={() => setDrawerOpen(true)}><List size={18} /></Button>}
          <TopBarNotice />
          <div className="ml-auto flex items-center gap-2">{connectionLost && <ReconnectingChip />}</div>
        </header>
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  )
}

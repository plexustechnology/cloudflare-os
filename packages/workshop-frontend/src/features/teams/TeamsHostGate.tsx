import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { initializeTeamsHost, isTeamsRoute, resolveTeamsHostTheme, type TeamsHostContext, type TeamsHostSession } from './teamsHost'
import { buildTeamsBrowserUrl, resolveTeamsDestination } from './teamsNavigation'
import { teamsSdk } from './teamsSdk'
import { TeamsBootScreen, TeamsRecoveryPanel } from './TeamsRecoveryPanel'

const HostContext = createContext<TeamsHostContext | null>(null)

/** Display preferences from the initialized host; never an authenticated principal. */
export const useTeamsHost = () => useContext(HostContext)

type HostInitializer = typeof initializeTeamsHost
type HostState = { status: 'initializing' } | TeamsHostSession['state']

/** Holds RPC/auth boot until the Teams host is ready; ordinary browser routes bypass it. */
export const TeamsHostGate = ({
  children,
  pathname = window.location.pathname,
  search = window.location.search,
  initializeHost = initializeTeamsHost,
}: {
  children: ReactNode
  pathname?: string
  search?: string
  initializeHost?: HostInitializer
}) => {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<HostState>({ status: 'initializing' })
  const isTeams = isTeamsRoute(pathname)

  useEffect(() => {
    if (!isTeams) return
    let cancelled = false
    let session: TeamsHostSession | undefined
    setState({ status: 'initializing' })
    initializeHost({ pathname: '/teams', sdk: teamsSdk, onThemeChange: (theme) => {
      if (!cancelled) setState((current) => current.status === 'ready'
        ? { ...current, context: { ...current.context, theme: resolveTeamsHostTheme(theme) } }
        : current)
    } }).then((next) => {
      if (cancelled) next.dispose()
      else {
        session = next
        setState(next.state)
      }
    }).catch(() => {
      if (!cancelled) setState({ status: 'error', reason: 'initialization-failed' })
    })
    return () => { cancelled = true; session?.dispose() }
  }, [attempt, initializeHost, isTeams])

  const locale = state.status === 'ready' ? state.context.locale : undefined
  useEffect(() => {
    if (!locale) return
    let normalized: string | undefined
    try { normalized = Intl.getCanonicalLocales(locale)[0] } catch { return }
    if (!normalized) return
    const root = document.documentElement
    const previous = root.getAttribute('lang')
    root.lang = normalized
    return () => {
      if (previous === null) root.removeAttribute('lang')
      else root.setAttribute('lang', previous)
    }
  }, [locale])

  if (!isTeams || state.status === 'outside-teams') return <>{children}</>
  if (state.status === 'initializing') return <TeamsBootScreen message="Connecting to Microsoft Teams…" />
  if (state.status === 'error') return <TeamsRecoveryPanel
    browserUrl={buildTeamsBrowserUrl(window.location.origin, resolveTeamsDestination({ pathname, search }))}
    message="Microsoft Teams could not initialize this tab. Retry here or open the same destination in your browser."
    onRetry={() => setAttempt((value) => value + 1)} />
  return <HostContext.Provider value={state.context}>{children}</HostContext.Provider>
}

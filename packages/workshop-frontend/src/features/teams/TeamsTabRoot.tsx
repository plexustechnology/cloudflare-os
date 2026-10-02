import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { useTeamsHost } from './TeamsHostGate'
import { buildTeamsBrowserUrl, resolveTeamsDestination } from './teamsNavigation'
import { TeamsBootScreen, TeamsRecoveryPanel } from './TeamsRecoveryPanel'

/** Verifies the ordinary Workshop session before mounting the authenticated tab experience. */
export const TeamsTabRoot = ({
  authenticatedApi,
  authError,
  isAuthLoading,
  children,
  pathname,
  search,
  navigateTo,
  onRetrySession,
}: {
  authenticatedApi: RpcStub<AuthenticatedApi> | null
  authError: string | null
  isAuthLoading: boolean
  children: ReactNode
  pathname: string
  search: string
  navigateTo: (destination: string) => void
  onRetrySession: () => void
}) => {
  const host = useTeamsHost()
  const [session, setSession] = useState<{ api: RpcStub<AuthenticatedApi>; status: 'ready' | 'failed' } | null>(null)
  const initialDestination = useRef(resolveTeamsDestination({ pathname, search, subPageId: host?.subPageId }))
  const landed = useRef(false)

  useEffect(() => {
    if (!authenticatedApi) return
    let cancelled = false
    const timer = setTimeout(() => {
      if (!cancelled) setSession({ api: authenticatedApi, status: 'failed' })
      cancelled = true
    }, 8_000)
    // Access authentication is pipelined. A stub alone does not prove iframe cookies succeeded.
    authenticatedApi.whoami().then((profile) => {
      if (profile.type !== 'user') throw new Error('Account session required')
      if (!cancelled) setSession({ api: authenticatedApi, status: 'ready' })
    }).catch(() => {
      if (!cancelled) setSession({ api: authenticatedApi, status: 'failed' })
    }).finally(() => clearTimeout(timer))
    return () => { cancelled = true; clearTimeout(timer) }
  }, [authenticatedApi])

  const verified = session?.api === authenticatedApi && session?.status === 'ready'
  useEffect(() => {
    if (!verified || landed.current) return
    landed.current = true
    if (`${pathname}${search}` !== `/teams${initialDestination.current}`) {
      navigateTo(initialDestination.current)
    }
  }, [navigateTo, pathname, search, verified])

  if (isAuthLoading || (authenticatedApi && session?.api !== authenticatedApi)) {
    return <TeamsBootScreen message="Checking your Workshop session…" />
  }
  if (authError || !authenticatedApi || !verified) return <TeamsRecoveryPanel
    browserUrl={buildTeamsBrowserUrl(window.location.origin, landed.current
      ? resolveTeamsDestination({ pathname, search }) : initialDestination.current)}
    message="This Teams frame could not verify your existing sign-in. Sign in through your browser, then retry. Browser sign-in may be required when Teams blocks authentication cookies."
    onRetry={onRetrySession} />
  return <>{children}</>
}

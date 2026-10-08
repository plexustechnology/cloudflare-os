import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, WorkpieceSummary } from '@gadgets/workshop-shared/api'
import { parseTeamsOnboardingVariable, type TeamsOnboardingTarget } from '@gadgets/workshop-shared/teams-onboarding'

const configuredTarget = parseTeamsOnboardingVariable(import.meta.env.VITE_TEAMS_ONBOARDING_TARGET)

/** Opens one accepted guide per account/workspace, preserving explicit navigation and view preferences. */
export const useTeamsWorkspaceWelcome = ({
  api, workspaceId, inTeams, ready, workpieces, chatId, gadgetId, onOpen,
  target = configuredTarget,
}: {
  api: RpcStub<AuthenticatedApi>
  workspaceId?: string
  inTeams: boolean
  ready: boolean
  workpieces: WorkpieceSummary[]
  chatId: number | null
  gadgetId: number | null
  onOpen?: () => void
  target?: TeamsOnboardingTarget | null
}) => {
  const guide = target && workspaceId === target.workspaceId
    ? workpieces.find(item => item.id === target.gadgetId && item.chatId === undefined && item.commitId !== undefined)
    : undefined
  const eligible = inTeams && ready && !!guide && chatId === null && gadgetId === null
  const [visit, setVisit] = useState<{ api: RpcStub<AuthenticatedApi>; workspaceId: string;
    gadgetId: number; status: 'open' | 'shown' } | null>(null)
  const generation = useRef(0)
  const cancelledVisit = useRef<{ api: RpcStub<AuthenticatedApi>; workspaceId?: string } | null>(null)
  const markedGeneration = useRef<number | null>(null)
  const latest = useRef({ api, workspaceId })
  const onOpenRef = useRef(onOpen)
  onOpenRef.current = onOpen
  latest.current = { api, workspaceId }
  const active = visit?.api === api && visit.workspaceId === workspaceId && guide?.id === visit.gadgetId && eligible
    ? visit : null
  const visitGeneration = generation.current

  useEffect(() => {
    const current = ++generation.current
    if (!eligible || !target || !workspaceId ||
        cancelledVisit.current?.api === api && cancelledVisit.current.workspaceId === workspaceId) return
    let cancelled = false
    const timer = setTimeout(() => { cancelled = true }, 8_000)
    api.hasSeenWorkspaceWelcome(workspaceId).then(seen => {
      if (!cancelled && current === generation.current && !seen) {
        onOpenRef.current?.()
        setVisit({ api, workspaceId, gadgetId: target.gadgetId, status: 'open' })
      }
    }).catch(error => {
      if (!cancelled) console.warn('Could not read workspace welcome preference:', error)
    }).finally(() => clearTimeout(timer))
    return () => { cancelled = true; clearTimeout(timer) }
  }, [api, workspaceId, eligible, target?.gadgetId])

  const cancel = useCallback(() => {
    ++generation.current
    cancelledVisit.current = { api: latest.current.api, workspaceId: latest.current.workspaceId }
    setVisit(null)
  }, [])

  const onReady = useCallback(() => {
    if (!active || active.status !== 'open' || visitGeneration !== generation.current ||
        markedGeneration.current === visitGeneration || latest.current.api !== active.api ||
        latest.current.workspaceId !== active.workspaceId) return
    markedGeneration.current = visitGeneration
    const current = generation.current
    const { api: ownerApi, workspaceId: ownerWorkspace } = active
    // Retain this visit's open guide after the write; only navigation dismisses it.
    setVisit({ ...active, status: 'shown' })
    ownerApi.markWorkspaceWelcomeSeen(ownerWorkspace).catch(error => {
      if (current === generation.current && latest.current.api === ownerApi &&
          latest.current.workspaceId === ownerWorkspace) {
        console.warn('Could not save workspace welcome preference:', error)
      }
    })
  }, [active, visitGeneration])

  return { gadgetId: active?.gadgetId ?? null, onReady, cancel }
}

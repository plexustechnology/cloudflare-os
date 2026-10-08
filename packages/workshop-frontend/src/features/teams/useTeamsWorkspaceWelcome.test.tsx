// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, WorkpieceSummary } from '@gadgets/workshop-shared/api'
import { parseTeamsOnboardingVariable } from '@gadgets/workshop-shared/teams-onboarding'
import { useTeamsWorkspaceWelcome } from './useTeamsWorkspaceWelcome'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const target = { workspaceId: 'a'.repeat(64), gadgetId: 7 }
const guide: WorkpieceSummary = { type: 'gadget', id: 7, title: 'Start Here', commitId: 'commit' }
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
const account = (seen = false) => {
  const hasSeenWorkspaceWelcome = vi.fn<AuthenticatedApi['hasSeenWorkspaceWelcome']>(async () => seen)
  const markWorkspaceWelcomeSeen = vi.fn<AuthenticatedApi['markWorkspaceWelcomeSeen']>(async () => { seen = true })
  const dispose = vi.fn<() => void>()
  const api: RpcStub<AuthenticatedApi> = Object.assign(Object.create(null), {
    hasSeenWorkspaceWelcome, markWorkspaceWelcomeSeen, [Symbol.dispose]: dispose,
  })
  return { api, hasSeenWorkspaceWelcome, markWorkspaceWelcomeSeen, dispose }
}
type Props = Parameters<typeof useTeamsWorkspaceWelcome>[0]
let result: ReturnType<typeof useTeamsWorkspaceWelcome>
const Harness = (props: Props) => {
  result = useTeamsWorkspaceWelcome(props)
  return <span>{result.gadgetId ?? 'normal'}</span>
}
let root: Root
let container: HTMLDivElement
let defaults: ComponentProps<typeof Harness>
let user: ReturnType<typeof account>
const render = async (overrides: Partial<Props> = {}) => {
  await act(async () => root.render(<Harness {...defaults} {...overrides} />))
}
beforeEach(() => {
  user = account(); defaults = { api: user.api, workspaceId: target.workspaceId, inTeams: true,
    ready: true, workpieces: [guide], chatId: null, gadgetId: null, target }
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers() })

describe('Teams workspace welcome', () => {
  it('opens an unseen accepted guide, marks only after readiness, and keeps it open for the visit', async () => {
    await render()
    expect(container.textContent).toBe('7')
    expect(user.markWorkspaceWelcomeSeen).not.toHaveBeenCalled()
    await act(async () => { result.onReady(); result.onReady() })
    expect(user.markWorkspaceWelcomeSeen).toHaveBeenCalledExactlyOnceWith(target.workspaceId)
    expect(container.textContent).toBe('7')
    await act(async () => root.render(null)); await render()
    expect(container.textContent).toBe('normal')
    expect(user.dispose).not.toHaveBeenCalled()
  })

  it('preserves explicit chat and gadget destinations and ordinary browser visits', async () => {
    for (const override of [{ chatId: 3 }, { gadgetId: 9 }, { gadgetId: 7 }, { inTeams: false },
      { workspaceId: 'b'.repeat(64) }, { ready: false }, { target: null }, { workpieces: [] },
      { workpieces: [{ ...guide, chatId: 4 }] }, { workpieces: [{ ...guide, commitId: undefined }] }]) {
      await render(override)
      expect(container.textContent).toBe('normal')
    }
    expect(user.hasSeenWorkspaceWelcome).not.toHaveBeenCalled()
    expect(user.markWorkspaceWelcomeSeen).not.toHaveBeenCalled()
  })

  it('never overrides a user choice while a preference read is pending', async () => {
    const pending = deferred<boolean>(); user.hasSeenWorkspaceWelcome.mockImplementation(() => pending.promise)
    await render()
    await act(async () => result.cancel())
    await act(async () => pending.resolve(false))
    expect(container.textContent).toBe('normal')
    expect(user.markWorkspaceWelcomeSeen).not.toHaveBeenCalled()
  })

  it('ignores stale reads and readiness callbacks after account switching or deep-link navigation', async () => {
    await render(); const oldReady = result.onReady
    const second = account(true)
    await render({ api: second.api })
    await act(async () => oldReady())
    expect(second.markWorkspaceWelcomeSeen).not.toHaveBeenCalled()
    expect(user.markWorkspaceWelcomeSeen).not.toHaveBeenCalled()
    expect(container.textContent).toBe('normal')
    const pending = deferred<boolean>(); user.hasSeenWorkspaceWelcome.mockImplementation(() => pending.promise)
    await render(); await render({ chatId: 2 }); await act(async () => pending.resolve(false))
    expect(container.textContent).toBe('normal')
  })

  it('does not mark failed gadget loads or reopen a deleted guide', async () => {
    await render(); expect(container.textContent).toBe('7')
    await render({ workpieces: [] })
    expect(container.textContent).toBe('normal')
    expect(user.markWorkspaceWelcomeSeen).not.toHaveBeenCalled()
  })

  it('bounds stalled reads and leaves normal views usable', async () => {
    vi.useFakeTimers()
    const pending = deferred<boolean>(); user.hasSeenWorkspaceWelcome.mockImplementation(() => pending.promise)
    await render(); await act(async () => vi.advanceTimersByTimeAsync(8_000))
    await act(async () => pending.resolve(false))
    expect(container.textContent).toBe('normal')
  })

  it('fails closed for invalid deployment variables', () => {
    for (const value of [undefined, '', '{', JSON.stringify({ ...target, url: 'https://outside.example' }),
      JSON.stringify({ ...target, gadgetId: 0 }), JSON.stringify({ ...target, workspaceId: 'A'.repeat(64) })]) {
      expect(parseTeamsOnboardingVariable(value)).toBeNull()
    }
    expect(parseTeamsOnboardingVariable(JSON.stringify(target))).toEqual(target)
  })
});

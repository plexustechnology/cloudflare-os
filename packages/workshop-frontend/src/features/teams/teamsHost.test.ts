import { describe, expect, it, vi } from 'vitest'
import {
  initializeTeamsHost,
  isTeamsRoute,
  resolveTeamsHostTheme,
  type TeamsSdkContext,
  type TeamsSdkPort,
} from './teamsHost'

const BASE_CONTEXT: TeamsSdkContext = {
  app: {
    locale: 'en-US',
    theme: 'default',
    host: { name: 'Teams' },
  },
  page: {
    frameContext: 'content',
    subPageId: '/workspaces/example',
    isMultiWindow: false,
  },
}

function createSdk(context: TeamsSdkContext = BASE_CONTEXT): TeamsSdkPort & {
  initialize: ReturnType<typeof vi.fn<() => Promise<void>>>
  getContext: ReturnType<typeof vi.fn<() => Promise<TeamsSdkContext>>>
  notifySuccess: ReturnType<typeof vi.fn<() => Promise<unknown>>>
  registerOnThemeChangeHandler: ReturnType<typeof vi.fn<(handler: (theme: string) => void) => void>>
} {
  return {
    initialize: vi.fn<() => Promise<void>>(async () => {}),
    getContext: vi.fn<() => Promise<TeamsSdkContext>>(async () => context),
    notifySuccess: vi.fn<() => Promise<unknown>>(async () => ({})),
    registerOnThemeChangeHandler: vi.fn<(handler: (theme: string) => void) => void>(() => {}),
  }
}

describe('Teams route detection', () => {
  it.each(['/teams', '/teams/', '/teams/workspaces'])('matches %s', (pathname) => {
    expect(isTeamsRoute(pathname)).toBe(true)
  })

  it.each(['/', '/team', '/teams-other', '/admin'])('rejects %s', (pathname) => {
    expect(isTeamsRoute(pathname)).toBe(false)
  })
})

describe('Teams host initialization', () => {
  it('initializes the SDK and exposes only display and navigation context', async () => {
    const contextWithIdentity = {
      ...BASE_CONTEXT,
      user: { id: 'untrusted-user', tenant: { id: 'untrusted-tenant' } },
    }
    const sdk = createSdk(contextWithIdentity)

    const session = await initializeTeamsHost({ pathname: '/teams/workspaces', sdk })

    expect(sdk.initialize).toHaveBeenCalledOnce()
    expect(sdk.getContext).toHaveBeenCalledOnce()
    expect(sdk.notifySuccess).toHaveBeenCalledOnce()
    expect(sdk.initialize.mock.invocationCallOrder[0]).toBeLessThan(
      sdk.getContext.mock.invocationCallOrder[0]!,
    )
    expect(sdk.getContext.mock.invocationCallOrder[0]).toBeLessThan(
      sdk.notifySuccess.mock.invocationCallOrder[0]!,
    )
    expect(session.state).toEqual({
      status: 'ready',
      context: {
        locale: 'en-US',
        hostName: 'Teams',
        frameContext: 'content',
        subPageId: '/workspaces/example',
        isMultiWindow: false,
        theme: 'light',
      },
    })
    expect(session.state.status === 'ready' && 'user' in session.state.context).toBe(false)
    expect(session.state.status === 'ready' && 'tenantId' in session.state.context).toBe(false)
  })

  it('returns a recoverable failure state when TeamsJS rejects', async () => {
    const sdk = createSdk()
    sdk.initialize.mockRejectedValueOnce(new Error('not hosted'))

    await expect(initializeTeamsHost({ pathname: '/teams', sdk })).resolves.toMatchObject({
      state: { status: 'error', reason: 'initialization-failed' },
    })
    expect(sdk.getContext).not.toHaveBeenCalled()
    expect(sdk.notifySuccess).not.toHaveBeenCalled()
  })

  it('returns a recoverable failure state when Teams rejects the ready signal', async () => {
    const sdk = createSdk()
    sdk.notifySuccess.mockRejectedValueOnce(new Error('host rejected ready signal'))

    await expect(initializeTeamsHost({ pathname: '/teams', sdk })).resolves.toMatchObject({
      state: { status: 'error', reason: 'initialization-failed' },
    })
    expect(sdk.initialize).toHaveBeenCalledOnce()
    expect(sdk.getContext).toHaveBeenCalledOnce()
    expect(sdk.notifySuccess).toHaveBeenCalledOnce()
    expect(sdk.registerOnThemeChangeHandler).not.toHaveBeenCalled()
  })

  it('returns a timeout state without waiting for a stalled SDK', async () => {
    vi.useFakeTimers()
    const sdk = createSdk()
    sdk.initialize.mockImplementationOnce(() => new Promise(() => {}))

    const result = initializeTeamsHost({ pathname: '/teams', sdk, timeoutMs: 50 })
    await vi.advanceTimersByTimeAsync(50)

    await expect(result).resolves.toMatchObject({
      state: { status: 'error', reason: 'timeout' },
    })
    expect(sdk.notifySuccess).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('returns a timeout state when the Teams ready signal stalls', async () => {
    vi.useFakeTimers()
    const sdk = createSdk()
    sdk.notifySuccess.mockImplementationOnce(() => new Promise(() => {}))

    const result = initializeTeamsHost({ pathname: '/teams', sdk, timeoutMs: 50 })
    await vi.advanceTimersByTimeAsync(50)

    await expect(result).resolves.toMatchObject({
      state: { status: 'error', reason: 'timeout' },
    })
    vi.useRealTimers()
  })

  it('falls back outside Teams without touching the SDK', async () => {
    const sdk = createSdk()

    await expect(initializeTeamsHost({ pathname: '/workspaces', sdk })).resolves.toMatchObject({
      state: { status: 'outside-teams' },
    })
    expect(sdk.initialize).not.toHaveBeenCalled()
    expect(sdk.getContext).not.toHaveBeenCalled()
    expect(sdk.notifySuccess).not.toHaveBeenCalled()
    expect(sdk.registerOnThemeChangeHandler).not.toHaveBeenCalled()
  })
})

describe('Teams host theme lifecycle', () => {
  it.each([
    ['default', 'light'],
    ['glass', 'light'],
    ['dark', 'dark'],
    ['contrast', 'contrast'],
    ['unknown', 'light'],
  ] as const)('normalizes %s to %s', (theme, expected) => {
    expect(resolveTeamsHostTheme(theme)).toBe(expected)
  })

  it('forwards theme changes and detaches its callback when disposed', async () => {
    const sdk = createSdk()
    const onThemeChange = vi.fn<(theme: 'light' | 'dark' | 'contrast') => void>()
    const session = await initializeTeamsHost({ pathname: '/teams', sdk, onThemeChange })
    const liveHandler = sdk.registerOnThemeChangeHandler.mock.calls[0]?.[0]

    liveHandler?.('dark')
    liveHandler?.('contrast')
    expect(onThemeChange.mock.calls).toEqual([['dark'], ['contrast']])

    session.dispose()
    session.dispose()
    liveHandler?.('default')

    expect(onThemeChange).toHaveBeenCalledTimes(2)
    expect(sdk.registerOnThemeChangeHandler).toHaveBeenCalledTimes(2)
    expect(sdk.registerOnThemeChangeHandler.mock.calls[1]?.[0]).not.toBe(liveHandler)
  })
})

describe('overlapping Teams host sessions', () => {
  it('does not replace a newer theme handler when an older session is disposed', async () => {
    const sdk = createSdk()
    const oldChange = vi.fn<(theme: string) => void>()
    const newChange = vi.fn<(theme: string) => void>()
    const oldSession = await initializeTeamsHost({ pathname: '/teams', sdk, onThemeChange: oldChange })
    const newSession = await initializeTeamsHost({ pathname: '/teams', sdk, onThemeChange: newChange })
    const liveHandler = sdk.registerOnThemeChangeHandler.mock.calls.at(-1)?.[0]
    oldSession.dispose()
    expect(sdk.registerOnThemeChangeHandler).toHaveBeenCalledTimes(2)
    liveHandler?.('dark')
    expect(newChange).toHaveBeenCalledExactlyOnceWith('dark')
    expect(oldChange).not.toHaveBeenCalled()
    newSession.dispose()
    expect(sdk.registerOnThemeChangeHandler).toHaveBeenCalledTimes(3)
  })
})

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasTeamsAccessSession, mountSignInScreen, signInToTeamsAccess } from './teamsAccessBootstrap'

const sdk = vi.hoisted(() => ({
  initialize: vi.fn<() => Promise<void>>(async () => {}),
  getContext: vi.fn<() => Promise<{ page: { subPageId: undefined } }>>(async () => ({ page: { subPageId: undefined } })),
  notifySuccess: vi.fn<() => Promise<void>>(async () => {}),
  authenticate: vi.fn<() => Promise<string>>(async () => 'wrong'), complete: vi.fn<(state: string) => void>(),
}))
vi.mock('@microsoft/teams-js', () => ({
  app: { initialize: sdk.initialize, getContext: sdk.getContext, notifySuccess: sdk.notifySuccess },
  authentication: { authenticate: sdk.authenticate, notifySuccess: sdk.complete },
}))

const state = '01234567-89ab-4cde-8fab-0123456789ab'

afterEach(() => {
  document.body.innerHTML = ''
  window.history.replaceState(null, '', '/')
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function screen(path: string): void {
  window.history.replaceState(null, '', path)
  document.body.innerHTML = '<p id="teams-access-status"></p><button id="teams-access-sign-in" disabled></button>' +
    '<a id="teams-access-browser"></a>'
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('Not signed in', { status: 401 })))
}

describe('Teams Access popup', () => {
  it('waits for an explicit click and shows a retry when popup correlation fails', async () => {
    screen('/teams/sign-in?destination=https://evil.test/')
    await mountSignInScreen()
    expect(sdk.authenticate).not.toHaveBeenCalled()
    expect(document.getElementById('teams-access-browser')?.getAttribute('href')).toBe('/workspaces')
    const button = document.getElementById('teams-access-sign-in') as HTMLButtonElement
    expect(button.disabled).toBe(false)
    button.click()
    await vi.waitFor(() => expect(button.disabled).toBe(false))
    expect(sdk.authenticate).toHaveBeenCalledOnce()
    expect(document.getElementById('teams-access-status')?.textContent).toContain('could not be verified')
  })

  it('completes the protected popup with only its nonce, without checking a Teams identity', async () => {
    screen(`/teams/auth-complete?state=${state}`)
    await mountSignInScreen()
    expect(sdk.complete).toHaveBeenCalledWith(state)
    expect(sdk.getContext).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not complete a callback containing malformed state', async () => {
    screen('/teams/auth-complete?state=untrusted')
    await mountSignInScreen()
    expect(sdk.complete).not.toHaveBeenCalled()
    expect(document.getElementById('teams-access-status')?.textContent).toContain('Open Plexus OS in your browser')
  })

  it('uses a same-origin protected callback and confirms the tab session after popup completion', async () => {
    const authenticate = vi.fn<() => Promise<string>>(async () => state)
    const checkSession = vi.fn<() => Promise<boolean>>(async () => true)
    await signInToTeamsAccess({ origin: 'https://example.test', authenticate, checkSession, randomState: () => state })
    expect(authenticate).toHaveBeenCalledWith({
      url: `https://example.test/teams/auth-complete?state=${state}`, width: 600, height: 650,
    })
    expect(checkSession).toHaveBeenCalledOnce()
  })

  it('rejects a mismatched popup result before checking or navigating the tab session', async () => {
    const checkSession = vi.fn<() => Promise<boolean>>(async () => true)
    await expect(signInToTeamsAccess({ origin: 'https://example.test', authenticate: async () => 'wrong',
      checkSession, randomState: () => state })).rejects.toThrow('could not be verified')
    expect(checkSession).not.toHaveBeenCalled()
  })

  it('keeps the landing page when the desktop frame cannot use the resulting Access cookie', async () => {
    await expect(signInToTeamsAccess({ origin: 'https://example.test', authenticate: async () => state,
      checkSession: async () => false, randomState: () => state })).rejects.toThrow('could not use your sign-in session')
  })

  it('does not treat a login page or redirect as an authenticated session', async () => {
    expect(await hasTeamsAccessSession(async () => new Response('<html>Sign in</html>'))).toBe(false)
    expect(await hasTeamsAccessSession(async () => { throw new TypeError('Redirect blocked') })).toBe(false)
    const request = vi.fn<typeof fetch>(async () => Response.json({ ready: true }))
    expect(await hasTeamsAccessSession(request)).toBe(true)
    expect(request).toHaveBeenCalledWith('/teams/auth-complete?probe=1', expect.objectContaining({
      credentials: 'include', redirect: 'error', cache: 'no-store', signal: expect.any(AbortSignal),
    }))
  })
})

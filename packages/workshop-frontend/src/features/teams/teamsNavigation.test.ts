import { describe, expect, it } from 'vitest'
import {
  appPathFromTeamsPath,
  buildTeamsBrowserUrl,
  parseTeamsReturnPath,
  pathWithRouterBasepath,
  resolveTeamsDestination,
  routerBasepath,
} from './teamsNavigation'

describe('Teams return-path validation', () => {
  it.each([
    ['/workspaces', '/workspaces'],
    ['/workspace/abc-123?chat=0&w=2', '/workspace/abc-123?chat=0&w=2'],
    ['/blueprint/example', '/blueprint/example'],
    ['/gatekeepers/knowledge-agent', '/gatekeepers/knowledge-agent'],
  ])('accepts the internal route %s', (candidate, expected) => {
    expect(parseTeamsReturnPath(candidate)).toBe(expected)
  })

  it.each([
    'https://attacker.example/workspaces',
    '//attacker.example/workspaces',
    'javascript:alert(1)',
    '/workspace/../admin',
    '/workspace/abc?redirect=https://attacker.example',
    '/workspace/abc?chat=1&chat=2',
    '/admin',
    '/signup',
    '/unknown',
    '/workspaces#token',
  ])('rejects %s', (candidate) => {
    expect(parseTeamsReturnPath(candidate)).toBeNull()
  })

  it('prefers a validated Teams deep link over the current route', () => {
    expect(resolveTeamsDestination({
      pathname: '/teams/workspaces',
      subPageId: '/workspace/abc?chat=3',
    })).toBe('/workspace/abc?chat=3')
  })

  it('ignores an external deep link and preserves the safe current route', () => {
    expect(resolveTeamsDestination({
      pathname: '/teams/workspace/abc',
      search: '?chat=3',
      subPageId: 'https://attacker.example/',
    })).toBe('/workspace/abc?chat=3')
  })

  it('uses Workspaces for a root or invalid Teams route', () => {
    expect(resolveTeamsDestination({ pathname: '/teams' })).toBe('/workspaces')
    expect(resolveTeamsDestination({ pathname: '/teams/admin' })).toBe('/workspaces')
  })

  it('builds a same-origin browser recovery URL and fails closed', () => {
    expect(buildTeamsBrowserUrl('https://cloudflare-os.example', '/workspace/abc?chat=3'))
      .toBe('https://cloudflare-os.example/workspace/abc?chat=3')
    expect(buildTeamsBrowserUrl('https://cloudflare-os.example', 'https://attacker.example/'))
      .toBe('https://cloudflare-os.example/workspaces')
  })
})

describe('Teams base-path removal', () => {
  it.each([
    ['/workspaces', '/teams', '/teams/workspaces'],
    ['/', '/teams', '/teams'],
    ['/workspaces', '/', '/workspaces'],
    ['/teams/workspaces', '/teams', '/teams/workspaces'],
  ])('restores %s under %s to %s', (pathname, basepath, expected) => {
    expect(pathWithRouterBasepath(pathname, basepath)).toBe(expected)
  })

  it.each([
    ['/teams', '/'],
    ['/teams/', '/'],
    ['/teams/workspaces', '/workspaces'],
    ['/teams/workspace/abc', '/workspace/abc'],
  ])('maps %s to %s', (pathname, expected) => {
    expect(appPathFromTeamsPath(pathname)).toBe(expected)
  })

  it.each(['/', '/team', '/teams-other'])('does not map %s', (pathname) => {
    expect(appPathFromTeamsPath(pathname)).toBeNull()
  })

  it.each(['/teams', '/teams/', '/teams/workspaces'])('uses the Teams router base for %s', (pathname) => {
    expect(routerBasepath(pathname)).toBe('/teams')
  })

  it.each(['/', '/team', '/teams-other', '/admin'])('keeps the normal router base for %s', (pathname) => {
    expect(routerBasepath(pathname)).toBe('/')
  })
})

import { describe, expect, it } from 'vitest'
import {
  parseTeamsSidebarCollapsed,
  resolveTeamsShellLayout,
} from './teamsLayout'

describe('Teams shell layout', () => {
  it.each([
    [320, 'compact', 'drawer', '48px'],
    [639, 'compact', 'drawer', '48px'],
    [640, 'medium', 'rail', '56px'],
    [1_023, 'medium', 'rail', '56px'],
    [1_024, 'standard', 'sidebar-collapsed', '56px'],
    [1_439, 'standard', 'sidebar-collapsed', '56px'],
    [1_440, 'wide', 'sidebar-expanded', '56px'],
  ] as const)(
    'maps a %dpx container to the %s band',
    (width, band, navigation, topBarHeight) => {
      expect(resolveTeamsShellLayout(width, null)).toMatchObject({
        band,
        navigation,
        topBarHeight,
      })
    },
  )

  it('uses the approved expanded sidebar widths', () => {
    expect(resolveTeamsShellLayout(1_024, false).expandedSidebarWidth).toBe('216px')
    expect(resolveTeamsShellLayout(1_440, false).expandedSidebarWidth).toBe('240px')
  })

  it('honors a persisted collapse choice at standard and wide widths', () => {
    expect(resolveTeamsShellLayout(1_200, false).navigation).toBe('sidebar-expanded')
    expect(resolveTeamsShellLayout(1_600, true).navigation).toBe('sidebar-collapsed')
  })

  it('keeps compact and medium variants independent of the sidebar preference', () => {
    expect(resolveTeamsShellLayout(320, false).navigation).toBe('drawer')
    expect(resolveTeamsShellLayout(800, false).navigation).toBe('rail')
    expect(resolveTeamsShellLayout(800, true).navigation).toBe('rail')
  })

  it('parses only explicit persisted choices', () => {
    expect(parseTeamsSidebarCollapsed('1')).toBe(true)
    expect(parseTeamsSidebarCollapsed('0')).toBe(false)
    expect(parseTeamsSidebarCollapsed(null)).toBeNull()
    expect(parseTeamsSidebarCollapsed('invalid')).toBeNull()
  })
})

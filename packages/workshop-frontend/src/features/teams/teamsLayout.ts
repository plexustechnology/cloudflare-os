export const TEAMS_SIDEBAR_COLLAPSED_STORAGE_KEY = 'gadgets:teams-sidebar-collapsed'

export type TeamsContainerBand = 'compact' | 'medium' | 'standard' | 'wide'
export type TeamsNavigationVariant = 'drawer' | 'rail' | 'sidebar-collapsed' | 'sidebar-expanded'

export interface TeamsShellLayout {
  band: TeamsContainerBand
  expandedSidebarWidth: '216px' | '240px' | null
  navigation: TeamsNavigationVariant
  topBarHeight: '48px' | '56px'
}

/** Resolves Teams shell chrome from the tab container width and the user's optional preference. */
export function resolveTeamsShellLayout(
  containerWidth: number,
  collapsedPreference: boolean | null,
): TeamsShellLayout {
  if (containerWidth < 640) {
    return {
      band: 'compact',
      expandedSidebarWidth: null,
      navigation: 'drawer',
      topBarHeight: '48px',
    }
  }

  if (containerWidth < 1_024) {
    return {
      band: 'medium',
      expandedSidebarWidth: null,
      navigation: 'rail',
      topBarHeight: '56px',
    }
  }

  const wide = containerWidth >= 1_440
  const collapsed = collapsedPreference ?? !wide
  return {
    band: wide ? 'wide' : 'standard',
    expandedSidebarWidth: wide ? '240px' : '216px',
    navigation: collapsed ? 'sidebar-collapsed' : 'sidebar-expanded',
    topBarHeight: '56px',
  }
}

/** Parses the persisted Teams-only collapse choice without affecting the browser sidebar setting. */
export function parseTeamsSidebarCollapsed(value: string | null): boolean | null {
  if (value === '1') return true
  if (value === '0') return false
  return null
}

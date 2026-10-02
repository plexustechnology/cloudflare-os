import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  applyThemeMode,
  readThemeMode,
  resolveThemeMode,
  writeThemeMode,
  type ResolvedThemeMode,
  type ThemeMode,
} from './theme'

interface ThemeContextValue {
  themeMode: ThemeMode
  resolvedThemeMode: ResolvedThemeMode
  setThemeMode: (mode: ThemeMode) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function getInitialThemeState() {
  const themeMode = readThemeMode()
  return { themeMode, resolvedThemeMode: resolveThemeMode(themeMode) }
}

export function ThemeProvider({ children, hostTheme }: { children: ReactNode; hostTheme?: ResolvedThemeMode }) {
  const [themeState, setThemeState] = useState(getInitialThemeState)
  const { themeMode } = themeState
  const resolvedThemeMode = themeMode === 'system' && hostTheme
    ? hostTheme : themeState.resolvedThemeMode

  useEffect(() => {
    if (themeMode !== 'system') {
      applyThemeMode(themeMode)
      return
    }

    if (hostTheme) {
      applyThemeMode(hostTheme)
      return
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = () => {
      const nextResolved = applyThemeMode('system')
      setThemeState((prev) => prev.resolvedThemeMode === nextResolved
        ? prev
        : { ...prev, resolvedThemeMode: nextResolved })
    }
    // Reapply the browser preference when leaving a host-provided theme.
    handleChange()
    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [themeMode, hostTheme])

  const value = useMemo<ThemeContextValue>(() => ({
    themeMode,
    resolvedThemeMode,
    setThemeMode: (mode) => {
      writeThemeMode(mode)
      setThemeState({ themeMode: mode, resolvedThemeMode: applyThemeMode(mode === 'system' && hostTheme ? hostTheme : mode) })
    },
  }), [themeMode, resolvedThemeMode, hostTheme])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used within ThemeProvider')
  return context
}

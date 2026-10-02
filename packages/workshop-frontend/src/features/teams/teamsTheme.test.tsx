// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider, useTheme } from '../../ThemeContext'
import type { ResolvedThemeMode } from '../../theme'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
let systemDark = false
let mediaChange: (() => void) | undefined
const removeListener = vi.fn<() => void>()
const values = new Map<string, string>()
beforeEach(() => {
  values.clear(); systemDark = false; mediaChange = undefined; removeListener.mockClear()
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } })
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({
    matches: systemDark,
    addEventListener: (_event: string, callback: () => void) => { mediaChange = callback },
    removeEventListener: removeListener,
  }) })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  document.documentElement.removeAttribute('data-mode')
})
const Preferences = () => {
  const theme = useTheme()
  return <><p>{theme.resolvedThemeMode}</p><button onClick={() => theme.setThemeMode('light')}>Light</button></>
}
const render = async (hostTheme?: ResolvedThemeMode) => {
  await act(async () => root.render(<ThemeProvider hostTheme={hostTheme}><Preferences /></ThemeProvider>))
}
describe('Teams host theme preferences', () => {
  it('follows the host for system preferences and retains an explicit Workshop choice', async () => {
    await render('dark')
    expect(document.documentElement.dataset.mode).toBe('dark')
    await act(async () => container.querySelector('button')?.click())
    await render('dark')
    expect(document.documentElement.dataset.mode).toBe('light')
    expect(values.get('gadgets:theme-mode')).toBe('light')
    expect(container.querySelector('p')?.textContent).toBe('light')
  })
  it('restores browser system preferences when host context is removed', async () => {
    await render('dark'); await render()
    expect(document.documentElement.dataset.mode).toBe('light')
    systemDark = true
    await act(async () => mediaChange?.())
    expect(document.documentElement.dataset.mode).toBe('dark')
    await render('light')
    expect(removeListener).toHaveBeenCalledOnce()
    expect(document.documentElement.dataset.mode).toBe('light')
  })
})

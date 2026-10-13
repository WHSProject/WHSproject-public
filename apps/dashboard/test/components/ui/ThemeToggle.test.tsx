import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThemeToggle } from '@/components/ui/ThemeToggle/ThemeToggle'

let dark = false
let media: EventTarget

beforeEach(() => {
  dark = false
  media = new EventTarget()
  localStorage.clear()
  document.documentElement.dataset.theme = 'light'
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    get matches() { return dark }, media: query, onchange: null,
    addEventListener: media.addEventListener.bind(media),
    removeEventListener: media.removeEventListener.bind(media),
    dispatchEvent: media.dispatchEvent.bind(media),
    addListener() {}, removeListener() {},
  }))
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  delete document.documentElement.dataset.theme
  vi.restoreAllMocks()
})

describe('ThemeToggle', () => {
  it('changes the document theme, saves it and retains it after a page remount', () => {
    const { unmount } = render(<ThemeToggle />)
    fireEvent.click(screen.getByRole('switch', { checked: false }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(localStorage.getItem('argus-theme')).toBe('dark')
    expect(screen.getByRole('switch', { checked: true })).toHaveAccessibleName('현재 다크 모드. 라이트 모드로 전환')
    unmount()
    render(<ThemeToggle />)
    expect(screen.getByRole('switch', { checked: true })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch'))
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(localStorage.getItem('argus-theme')).toBe('light')
  })

  it('follows system changes until the user explicitly chooses a theme', () => {
    render(<ThemeToggle />)
    dark = true
    act(() => media.dispatchEvent(new Event('change')))
    expect(screen.getByRole('switch', { checked: true })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch'))
    act(() => media.dispatchEvent(new Event('change')))
    expect(screen.getByRole('switch', { checked: false })).toBeInTheDocument()
  })

  it('synchronizes another tab and works when storage is unavailable', () => {
    render(<ThemeToggle />)
    localStorage.setItem('argus-theme', 'dark')
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'argus-theme', newValue: 'dark' })))
    expect(screen.getByRole('switch', { checked: true })).toBeInTheDocument()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    fireEvent.click(screen.getByRole('switch'))
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(screen.getByRole('switch', { checked: false })).toBeInTheDocument()
  })
})

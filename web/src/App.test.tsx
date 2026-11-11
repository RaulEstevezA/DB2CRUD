// @vitest-environment jsdom
/**
 * Interface tests of the whole screen: what a visitor sees when the tool opens.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.tsx'
import { I18nProvider } from './i18n/I18nProvider.tsx'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  localStorage.clear()
})

function renderApp() {
  return render(
    <I18nProvider>
      <App />
    </I18nProvider>,
  )
}

describe('App', () => {
  it('presents the tool with its name as the main heading', () => {
    renderApp()
    expect(screen.getByRole('heading', { level: 1, name: 'DB2CRUD' })).toBeTruthy()
  })

  it('links the name in the header to the website', () => {
    renderApp()
    expect(within(screen.getByRole('banner')).getByRole('link', { name: 'Raúl Estévez' }).getAttribute('href')).toBe(
      'https://raulesteveza.github.io/',
    )
  })

  it('links to the source code and to the other tools', () => {
    renderApp()
    const links = screen.getByRole('region', { name: 'Downloads and links' })
    expect(within(links).getByRole('link', { name: 'Source code' }).getAttribute('href')).toBe('https://github.com/RaulEstevezA/DB2CRUD')
    expect(within(links).getByRole('link', { name: 'All tools' }).getAttribute('href')).toBe('https://raulesteveza.github.io/tools/')
  })

  it('ends with the license in the footer', () => {
    renderApp()
    expect(within(screen.getByRole('contentinfo')).getByText('MIT License')).toBeTruthy()
  })

  it('shows the models, without tabs while they are the only part', () => {
    renderApp()
    expect(screen.getByRole('region', { name: 'Models' })).toBeTruthy()
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('reads an example and says what it found', () => {
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Online shop' }))
    expect(screen.getByText('TypeScript · 5 models · 29 fields')).toBeTruthy()
  })

  it('reports where the input cannot be read', () => {
    renderApp()
    fireEvent.change(screen.getByRole('combobox', { name: 'Format' }), { target: { value: 'json' } })
    expect(screen.getByText('Paste or open your models to start.')).toBeTruthy()
  })

  it('changes the language of the page and stores it for the whole site', () => {
    localStorage.setItem('lang', 'en')
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'ES' }))
    expect(screen.getByRole('button', { name: 'ES' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('group', { name: 'Idioma' })).toBeTruthy()
    expect(screen.getByText('Procesado en local')).toBeTruthy()
    expect(document.documentElement.lang).toBe('es')
    expect(localStorage.getItem('lang')).toBe('es')
  })
})

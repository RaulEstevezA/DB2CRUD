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
    expect(screen.getByRole('heading', { level: 1, name: 'Model2API' })).toBeTruthy()
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
    expect(within(links).getByRole('link', { name: 'Source code' }).getAttribute('href')).toBe('https://github.com/RaulEstevezA/Model2API')
    expect(within(links).getByRole('link', { name: 'All tools' }).getAttribute('href')).toBe('https://raulesteveza.github.io/tools/')
  })

  it('ends with the license in the footer', () => {
    renderApp()
    expect(within(screen.getByRole('contentinfo')).getByText('MIT License')).toBeTruthy()
  })

  it('shows the models, the endpoints and the project, also as tabs for narrow screens', () => {
    renderApp()
    for (const name of ['Models', 'Endpoints', 'Project']) {
      expect(screen.getByRole('region', { name })).toBeTruthy()
      expect(screen.getByRole('tab', { name })).toBeTruthy()
    }
  })

  it('moves between the tabs with the keyboard', () => {
    renderApp()
    const models = screen.getByRole('tab', { name: 'Models' })
    models.focus()
    fireEvent.keyDown(models, { key: 'ArrowRight' })
    const endpoints = screen.getByRole('tab', { name: 'Endpoints' })
    expect(endpoints.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(endpoints)
    fireEvent.keyDown(endpoints, { key: 'End' })
    expect(screen.getByRole('tab', { name: 'Project' }).getAttribute('aria-selected')).toBe('true')
  })

  it('reads an example and says what it found', () => {
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Online shop' }))
    expect(screen.getByText('TypeScript · 5 models · 29 fields')).toBeTruthy()
  })

  it('proposes the resources and endpoints of the models', () => {
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Online shop' }))
    expect(screen.getByRole('region', { name: 'Customer' })).toBeTruthy()
    expect(screen.getByText('3 resources · 18 endpoints')).toBeTruthy()
    expect(screen.getAllByText('/customers/{id}').length).toBeGreaterThan(0)
  })

  it('applies an edit and undoes it', () => {
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Online shop' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Generate DELETE /customers/{id}' }))
    expect(screen.getByText('3 resources · 17 endpoints')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getByText('3 resources · 18 endpoints')).toBeTruthy()
  })

  it('writes the project and shows its files', () => {
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Online shop' }))
    expect(screen.getByRole('button', { name: /^Download \.zip \(\d+ files\)$/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'main.py' }))
    expect(screen.getByText('app/main.py')).toBeTruthy()
  })

  it('keeps the work in this browser only when asked, and restores it', () => {
    const first = renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Library' }))
    expect(localStorage.getItem('model2api.workspace')).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Remember in this browser' }))
    vi.advanceTimersByTime(700)
    expect(JSON.parse(localStorage.getItem('model2api.workspace')!).format).toBe('model2api-project')
    first.unmount()
    renderApp()
    expect(screen.getByText('Your work kept in this browser has been restored.')).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Book' })).toBeTruthy()
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

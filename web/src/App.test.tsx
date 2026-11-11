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

  it('shows the database, its design and the project, also as tabs for narrow screens', () => {
    renderApp()
    for (const name of ['Database', 'Design', 'Project']) {
      expect(screen.getByRole('region', { name })).toBeTruthy()
      expect(screen.getByRole('tab', { name })).toBeTruthy()
    }
  })

  it('reads an example, proposes its design and writes its project', () => {
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Online shop' }))
    expect(screen.getByText(/Model2DB \(postgresql\) · postgresql · 4 tables/)).toBeTruthy()
    const design = screen.getByRole('region', { name: 'Design' })
    expect(within(design).getByText('CustomerService')).toBeTruthy()
    const project = screen.getByRole('region', { name: 'Project' })
    expect(within(project).getByRole('button', { name: /Download \.zip/ })).toBeTruthy()
    expect(within(project).getByText(/Verified/)).toBeTruthy()
  })

  it('changes a decision and undoes it', () => {
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Online shop' }))
    const design = screen.getByRole('region', { name: 'Design' })
    const box = within(design).getAllByRole('checkbox')[0] as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    expect((within(design).getAllByRole('checkbox')[0] as HTMLInputElement).checked).toBe(false)
    fireEvent.click(within(design).getByRole('button', { name: 'Undo' }))
    expect((within(design).getAllByRole('checkbox')[0] as HTMLInputElement).checked).toBe(true)
  })

  it('says why the input cannot be read', () => {
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Online shop' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.getByText(/Paste or open a Model2DB project to start/)).toBeTruthy()
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

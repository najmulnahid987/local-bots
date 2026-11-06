// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import App from './App'

describe('Renderer: App and Navigation Shell', () => {
  beforeEach(() => {
    window.location.hash = '#/'
  })

  afterEach(() => {
    cleanup()
  })

  it('renders the Home page by default with welcome header and empty state', () => {
    render(<App />)

    expect(
      screen.getByRole('heading', { level: 1, name: /welcome to your ai workspace/i })
    ).toBeTruthy()
    expect(
      screen.getByText(/a focused space for your knowledge, ai teammates, and work\./i)
    ).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: /your workspace is ready/i })).toBeTruthy()
    expect(
      screen.getByText(
        /your knowledge bases and bots will appear here as you build your workspace\./i
      )
    ).toBeTruthy()

    const exploreLink = screen.getByRole('link', { name: /explore knowledge bases/i })
    expect(exploreLink).toBeTruthy()
  })

  it('navigates to Knowledge Bases when clicking the Explore Knowledge Bases action', () => {
    render(<App />)

    const exploreLink = screen.getByRole('link', { name: /explore knowledge bases/i })
    fireEvent.click(exploreLink)

    expect(screen.getByRole('heading', { level: 1, name: /knowledge bases/i })).toBeTruthy()
    expect(
      screen.getByText(/organize your documents and shared knowledge in independent workspaces\./i)
    ).toBeTruthy()
  })

  it('navigates across all four views via the sidebar and updates active status', () => {
    render(<App />)

    // Initially Home is active
    const homeLink = screen.getByRole('link', { name: 'Home' })
    const kbLink = screen.getByRole('link', { name: 'Knowledge Bases' })
    const activityLink = screen.getByRole('link', { name: 'Activity' })
    const settingsLink = screen.getByRole('link', { name: 'Settings' })

    expect(homeLink.className).toContain('active')
    expect(kbLink.className).not.toContain('active')

    // Navigate to Knowledge Bases
    fireEvent.click(kbLink)
    expect(screen.getByRole('heading', { level: 1, name: /knowledge bases/i })).toBeTruthy()
    expect(
      screen.getByText(/organize your documents and shared knowledge in independent workspaces\./i)
    ).toBeTruthy()
    expect(kbLink.className).toContain('active')
    expect(homeLink.className).not.toContain('active')

    // Navigate to Activity
    fireEvent.click(activityLink)
    expect(screen.getByRole('heading', { level: 1, name: /activity/i })).toBeTruthy()
    expect(
      screen.getByText(/keep track of work and activity across your workspace\./i)
    ).toBeTruthy()
    expect(activityLink.className).toContain('active')
    expect(kbLink.className).not.toContain('active')

    // Navigate to Settings
    fireEvent.click(settingsLink)
    expect(screen.getByRole('heading', { level: 1, name: /settings/i })).toBeTruthy()
    expect(screen.getByText(/manage your application preferences\./i)).toBeTruthy()
    expect(settingsLink.className).toContain('active')
    expect(activityLink.className).not.toContain('active')

    // Return to Home
    fireEvent.click(homeLink)
    expect(
      screen.getByRole('heading', { level: 1, name: /welcome to your ai workspace/i })
    ).toBeTruthy()
    expect(homeLink.className).toContain('active')
    expect(settingsLink.className).not.toContain('active')
  })

  it('redirects unknown routes back to Home via fallback route', () => {
    window.location.hash = '#/unknown-route-that-does-not-exist'
    render(<App />)

    expect(
      screen.getByRole('heading', { level: 1, name: /welcome to your ai workspace/i })
    ).toBeTruthy()
  })
})

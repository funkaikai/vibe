// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { m } from '~/paraglide/messages.js'
import { GeneralSection } from './general'
import type { SettingsViewModel } from './shared'

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))
vi.mock('@tauri-apps/plugin-autostart', () => ({ isEnabled: vi.fn(async () => false), enable: vi.fn(), disable: vi.fn() }))
vi.mock('~/components/display-language-input', () => ({ DisplayLanguageInput: () => null }))

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe('product help navigation', () => {
	it('opens this product’s documentation and keeps feedback in the diagnostic action', () => {
		const reportIssue = vi.fn()
		const vm = {
			preference: { displayLanguage: 'zh-CN', theme: 'light', closeToTray: true, preventSleep: false },
			reportIssue,
		} as unknown as SettingsViewModel
		render(<GeneralSection vm={vm} />)

		for (const [label, file] of [
			['项目主页', 'README.md'],
			['使用说明', 'HOMEPAGE.md'],
			['功能总览', 'docs/FEATURE_MAP.md'],
		]) {
			fireEvent.click(screen.getByRole('button', { name: label }))
			expect(openUrl).toHaveBeenLastCalledWith(`https://github.com/funkaikai/vibe/blob/fork/macos-baseline/${file}`)
		}
		fireEvent.click(screen.getByRole('button', { name: m.reportIssue() }))
		expect(reportIssue).toHaveBeenCalledOnce()
		expect(openUrl).toHaveBeenCalledTimes(3)
		expect(screen.queryByText(/Discord|Support the project|赞助|支持项目/i)).toBeNull()
	})
})

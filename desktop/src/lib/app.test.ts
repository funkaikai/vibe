import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { openUrl } from '@tauri-apps/plugin-opener'
import { toast } from 'sonner'
import { issueTitleFrom, openFeedback } from './app'
import { feedbackURL } from './config'

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn() }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

afterEach(() => vi.resetAllMocks())

describe('issueTitleFrom', () => {
	it('takes the message out of a tracing json line', () => {
		const log = '{"timestamp":"2026-08-22T11:05:32Z","level":"ERROR","fields":{"message":"vibe-server process died while loading a model"}}'
		expect(issueTitleFrom(log)).toBe('vibe-server process died while loading a model')
	})

	it('strips the timestamp and level from a plain line', () => {
		expect(issueTitleFrom('2026-08-22T11:05:32Z ERROR: failed to read server event line')).toBe('failed to read server event line')
	})

	it('skips empty and useless lines', () => {
		expect(issueTitleFrom('\n  \nInvalid JSON\nno model loaded')).toBe('no model loaded')
	})

	it('shortens a long line instead of filling the tracker with paragraphs', () => {
		const title = issueTitleFrom('x'.repeat(200))
		expect(title).toHaveLength(90)
		expect(title.endsWith('…')).toBe(true)
	})

	it('falls back when the log says nothing', () => {
		expect(issueTitleFrom('')).toBe('App reports bug')
	})
})

describe('openFeedback', () => {
	it('keeps diagnostic details on the clipboard and opens help without sending them in the URL', async () => {
		const logs = 'ERROR: failed to read /Users/example/private-recording.mp4'
		await openFeedback(logs)
		expect(writeText).toHaveBeenCalledWith(expect.stringContaining(logs))
		expect(openUrl).toHaveBeenCalledExactlyOnceWith(feedbackURL)
		const opened = new URL(vi.mocked(openUrl).mock.calls[0][0])
		expect(opened.hostname).toBe('github.com')
		expect(opened.pathname).toBe('/funkaikai/vibe/blob/fork/macos-baseline/docs/FEEDBACK.md')
		expect(opened.search).toBe('')
		expect(opened.hash).toBe('')
		expect(toast.success).toHaveBeenCalledOnce()
	})

	it('still opens the feedback instructions when the clipboard is unavailable', async () => {
		vi.mocked(writeText).mockRejectedValueOnce(new Error('clipboard unavailable'))
		await expect(openFeedback('ERROR: model failed')).resolves.toBeUndefined()
		expect(toast.error).toHaveBeenCalledOnce()
		expect(toast.success).not.toHaveBeenCalled()
		expect(openUrl).toHaveBeenCalledExactlyOnceWith(feedbackURL)
	})
})

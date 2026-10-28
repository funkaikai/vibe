import { beforeEach, describe, expect, it, vi } from 'vitest'

const downloader = vi.hoisted(() => ({
	exists: vi.fn(),
	getLatestVersion: vi.fn(),
	downloadYtDlp: vi.fn(),
	invoke: vi.fn(),
	emit: vi.fn(),
}))

vi.mock('./ytdlp', () => downloader)
vi.mock('@tauri-apps/api/core', () => ({ invoke: downloader.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ emit: downloader.emit }))

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((finish) => {
		resolve = finish
	})
	return { promise, resolve }
}

beforeEach(() => {
	vi.resetModules()
	vi.resetAllMocks()
	downloader.exists.mockResolvedValue(false)
	downloader.getLatestVersion.mockResolvedValue('2026.10.28')
	downloader.downloadYtDlp.mockResolvedValue(undefined)
})

describe('media downloader preparation', () => {
	it('cancels a caller immediately while a shared installation stays available to other callers', async () => {
		const installation = deferred()
		downloader.downloadYtDlp.mockReturnValue(installation.promise)
		const { ensureMediaDownloader } = await import('./media-download')
		const controller = new AbortController()
		const cancelled = ensureMediaDownloader(controller.signal)
		await vi.waitFor(() => expect(downloader.downloadYtDlp).toHaveBeenCalledOnce())

		controller.abort()
		await expect(cancelled).rejects.toThrow('已取消下载器准备')
		// A local cancellation must never emit the legacy global download cancellation.
		expect(downloader.emit).not.toHaveBeenCalled()
		expect(downloader.invoke).not.toHaveBeenCalled()

		let otherFinished = false
		const other = ensureMediaDownloader().then(() => {
			otherFinished = true
		})
		await vi.waitFor(() => expect(downloader.exists).toHaveBeenCalledTimes(2))
		expect(otherFinished).toBe(false)
		expect(downloader.getLatestVersion).toHaveBeenCalledOnce()
		expect(downloader.downloadYtDlp).toHaveBeenCalledOnce()

		installation.resolve()
		await other
		expect(otherFinished).toBe(true)
	})

	it('does not start installation for an already cancelled preparation', async () => {
		const { ensureMediaDownloader } = await import('./media-download')
		const controller = new AbortController()
		controller.abort()

		await expect(ensureMediaDownloader(controller.signal)).rejects.toThrow('已取消下载器准备')
		expect(downloader.exists).not.toHaveBeenCalled()
		expect(downloader.downloadYtDlp).not.toHaveBeenCalled()
	})

	it('allows a fresh attempt after a shared installation fails', async () => {
		downloader.downloadYtDlp.mockRejectedValueOnce(new Error('network unavailable'))
		const { ensureMediaDownloader } = await import('./media-download')

		await expect(ensureMediaDownloader()).rejects.toThrow('network unavailable')
		await expect(ensureMediaDownloader()).resolves.toBeUndefined()
		expect(downloader.downloadYtDlp).toHaveBeenCalledTimes(2)
	})
})

// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AI } from '~/lib/ai/config'
import type { Preference } from '~/providers/preference'
import type { TranscribeQueue } from './transcribe-queue-types'
import { useMediaComposer } from './use-media-composer'

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), download: vi.fn(), ensure: vi.fn(), cancel: vi.fn(), remove: vi.fn(), listen: vi.fn(), lock: vi.fn() }))
vi.mock('~/lib/media-input', () => ({ resolveMediaInput: mocks.resolve }))
vi.mock('~/lib/media-download', () => ({ downloadMedia: mocks.download, ensureMediaDownloader: mocks.ensure, cancelMediaDownload: mocks.cancel }))
vi.mock('@tauri-apps/plugin-fs', () => ({ remove: mocks.remove }))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
vi.mock('~/lib/model-lock', () => ({ lockModel: mocks.lock }))

function deferred<T>() {
	let resolve!: (result: T) => void
	let reject!: (cause: unknown) => void
	const promise = new Promise<T>((done, fail) => {
		resolve = done
		reject = fail
	})
	return { promise, resolve, reject }
}
const first = 'https://www.youtube.com/watch?v=first'
const second = 'https://www.bilibili.com/video/BVsecond'
const localFile = { name: '本地会议.wav', path: '/Users/example/meeting.wav' }
let preference: Preference
let queue: TranscribeQueue
let progress: ((event: { payload: { requestId: string; stage: string; progress: number | null } }) => void) | undefined

beforeEach(() => {
	vi.clearAllMocks()
	preference = {
		modelPath: '/models/Qwen3-ASR-1.7B',
		modelOptions: { lang: 'auto', init_prompt: '项目术语' },
		ai: { ...DEFAULT_AI, connection: { ...DEFAULT_AI.connection, platform: 'openai', openaiApiKey: 'test-key', model: 'test-model' } },
	} as unknown as Preference
	queue = { running: false, enqueue: vi.fn() } as unknown as TranscribeQueue
	mocks.lock.mockReturnValue(vi.fn())
	mocks.ensure.mockResolvedValue(undefined)
	mocks.remove.mockResolvedValue(undefined)
	mocks.cancel.mockResolvedValue(undefined)
	mocks.listen.mockImplementation(async (_name: string, callback: typeof progress) => {
		progress = callback
		return vi.fn()
	})
	mocks.resolve.mockImplementation(async (text: string) =>
		text === '两个分享链接'
			? [
					{ url: first, platform: 'youtube' },
					{ url: second, platform: 'bilibili' },
				]
			: [{ url: text, platform: 'youtube' }],
	)
	mocks.download.mockImplementation(async (url: string) => ({
		path: `/trusted-temp/${url === first ? 'first' : 'second'}.m4a`,
		title: url === first ? '视频一' : '视频二',
	}))
})
afterEach(cleanup)

function setup() {
	return renderHook(() => useMediaComposer(preference, queue))
}

describe('统一输入任务编排', () => {
	it('preserves share text on API failure and still submits local files independently', async () => {
		mocks.resolve.mockRejectedValue(new Error('请配置在线文本模型'))
		const { result } = setup()
		act(() => {
			result.current.setText('抖音分享文案')
			result.current.addFiles([localFile])
		})
		await act(() => result.current.submit())
		expect(result.current.text).toBe('抖音分享文案')
		expect(result.current.items.find((item) => item.kind === 'text')?.error).toBe('请配置在线文本模型')
		expect(result.current.files).toEqual([])
		expect(queue.enqueue).toHaveBeenCalledOnce()
		expect(vi.mocked(queue.enqueue).mock.calls[0][0]).toEqual([localFile])
		expect(mocks.download).not.toHaveBeenCalled()
		expect(mocks.resolve.mock.calls[0][0]).toBe('抖音分享文案')
	})

	it('does not call the text model for a local-only submission', async () => {
		const { result } = setup()
		act(() => result.current.addFiles([localFile, localFile]))
		await act(() => result.current.submit())
		expect(mocks.resolve).not.toHaveBeenCalled()
		expect(vi.mocked(queue.enqueue).mock.calls[0][0]).toEqual([localFile])
	})

	it('includes newly selected files after a previous share failed', async () => {
		mocks.resolve.mockRejectedValue(new Error('接口失败'))
		const { result } = setup()
		act(() => result.current.setText(first))
		await act(() => result.current.submit())
		act(() => result.current.addFiles([localFile]))
		await act(() => result.current.submit())
		expect(queue.enqueue).toHaveBeenCalledOnce()
		expect(vi.mocked(queue.enqueue).mock.calls[0][0]).toEqual([localFile])
		expect(result.current.text).toBe(first)
	})

	it('allows an explicitly selected file to be transcribed again after its previous submission succeeded', async () => {
		const { result } = setup()
		act(() => result.current.addFiles([localFile]))
		await act(() => result.current.submit())
		expect(result.current.files).toEqual([])
		act(() => result.current.addFiles([localFile, localFile]))
		expect(result.current.files).toEqual([localFile])
		await act(() => result.current.submit())
		expect(queue.enqueue).toHaveBeenCalledTimes(2)
		expect(vi.mocked(queue.enqueue).mock.calls.map((call) => call[0])).toEqual([[localFile], [localFile]])
	})

	it('guards repeated submit calls while a model request is pending', async () => {
		const response = deferred<{ url: string; platform: string }[]>()
		mocks.resolve.mockReturnValue(response.promise)
		const { result } = setup()
		act(() => result.current.setText(first))
		let task!: Promise<void>
		act(() => {
			task = result.current.submit()
			void result.current.submit()
		})
		expect(mocks.resolve).toHaveBeenCalledOnce()
		await act(async () => {
			response.resolve([{ url: first, platform: 'youtube' }])
			await task
		})
		expect(mocks.download).toHaveBeenCalledOnce()
		expect(queue.enqueue).toHaveBeenCalledOnce()
	})

	it('cancels a model request without downloading or enqueueing any file', async () => {
		const response = deferred<{ url: string; platform: string }[]>()
		mocks.resolve.mockReturnValue(response.promise)
		const { result } = setup()
		act(() => {
			result.current.setText(first)
			result.current.addFiles([localFile])
		})
		let task!: Promise<void>
		act(() => {
			task = result.current.submit()
		})
		act(() => result.current.cancel())
		await act(async () => {
			response.resolve([{ url: first, platform: 'youtube' }])
			await task
		})
		expect(mocks.download).not.toHaveBeenCalled()
		expect(queue.enqueue).not.toHaveBeenCalled()
		expect(mocks.remove).not.toHaveBeenCalledWith(localFile.path)
		expect(result.current.files).toEqual([localFile])
		expect(result.current.items.every((item) => item.stage === 'cancelled')).toBe(true)
	})

	it('cleans native staging files when cancellation races with a completed download', async () => {
		const response = deferred<{ path: string; title: string }>()
		mocks.download.mockReturnValue(response.promise)
		const { result } = setup()
		act(() => {
			result.current.setText(first)
			result.current.addFiles([localFile])
		})
		let task!: Promise<void>
		act(() => {
			task = result.current.submit()
		})
		await waitFor(() => expect(mocks.download).toHaveBeenCalledOnce())
		act(() => result.current.cancel())
		const requestId = mocks.download.mock.calls[0][1]
		expect(mocks.cancel).toHaveBeenCalledWith(requestId)
		await act(async () => {
			response.resolve({ path: '/trusted-temp/cancelled.m4a', title: '已下载' })
			await task
		})
		expect(mocks.remove).toHaveBeenCalledExactlyOnceWith('/trusted-temp/cancelled.m4a')
		expect(mocks.remove).not.toHaveBeenCalledWith(localFile.path)
		expect(queue.enqueue).not.toHaveBeenCalled()
	})

	it('retries one failed link through the model and does not repeat successful links', async () => {
		mocks.download.mockImplementation(async (url: string) => {
			if (url === first) throw new Error('下载失败')
			return { path: '/trusted-temp/second.m4a', title: '视频二' }
		})
		const { result } = setup()
		act(() => result.current.setText('两个分享链接'))
		await act(() => result.current.submit())
		const failedId = result.current.items.find((item) => item.stage === 'error')!.id
		const firstRequest = mocks.download.mock.calls[0][1]
		expect(vi.mocked(queue.enqueue).mock.calls[0][0].map((file) => file.path)).toEqual(['/trusted-temp/second.m4a'])
		mocks.download.mockResolvedValue({ path: '/trusted-temp/retried.m4a', title: '视频一' })
		await act(() => result.current.retry(failedId))
		expect(mocks.resolve.mock.calls.map((call) => call[0])).toEqual(['两个分享链接', first])
		expect(mocks.download.mock.calls.map((call) => call[0])).toEqual([first, second, first])
		expect(mocks.download.mock.calls[2][1]).not.toBe(firstRequest)
		expect(mocks.download.mock.calls[2][1]).not.toBe(failedId)
		expect(vi.mocked(queue.enqueue).mock.calls[1][0].map((file) => file.path)).toEqual(['/trusted-temp/retried.m4a'])
		expect(result.current.text).toBe('')
		expect(mocks.remove).not.toHaveBeenCalled()
	})

	it('ignores late progress from a cancelled attempt and uses a new native request id on retry', async () => {
		const response = deferred<{ path: string; title: string }>()
		mocks.download.mockReturnValueOnce(response.promise)
		const { result } = setup()
		act(() => result.current.setText(first))
		let task!: Promise<void>
		act(() => {
			task = result.current.submit()
		})
		await waitFor(() => expect(mocks.download).toHaveBeenCalledOnce())
		const oldRequest = mocks.download.mock.calls[0][1]
		act(() => result.current.cancel())
		await act(async () => {
			response.reject(new Error('已取消'))
			await task
		})
		const cancelledId = result.current.items[0].id
		const retryResponse = deferred<{ path: string; title: string }>()
		mocks.download.mockReturnValueOnce(retryResponse.promise)
		act(() => {
			task = result.current.retry(cancelledId)
		})
		await waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(2))
		const newRequest = mocks.download.mock.calls[1][1]
		expect(newRequest).not.toBe(oldRequest)
		act(() => progress?.({ payload: { requestId: oldRequest, stage: 'downloading', progress: 99 } }))
		expect(result.current.items[0].progress).toBeNull()
		act(() => progress?.({ payload: { requestId: newRequest, stage: 'downloading', progress: 31 } }))
		expect(result.current.items[0].progress).toBe(31)
		await act(async () => {
			retryResponse.resolve({ path: '/trusted-temp/new.m4a', title: '重试成功' })
			await task
		})
	})

	it('removes successful local attachments before editing retained text and submitting again', async () => {
		mocks.resolve.mockRejectedValue(new Error('接口失败'))
		const { result } = setup()
		act(() => {
			result.current.setText(first)
			result.current.addFiles([localFile])
		})
		await act(() => result.current.submit())
		act(() => result.current.setText(second))
		mocks.resolve.mockResolvedValue([{ url: second, platform: 'bilibili' }])
		await act(() => result.current.submit())
		expect(
			vi
				.mocked(queue.enqueue)
				.mock.calls.flatMap((call) => call[0])
				.filter((file) => file.path === localFile.path),
		).toHaveLength(1)
		expect(result.current.files).toEqual([])
	})

	it('freezes the submitted model/options and enqueues Chinese recognition despite settings changes', async () => {
		const response = deferred<{ url: string; platform: string }[]>()
		mocks.resolve.mockReturnValue(response.promise)
		const view = setup()
		act(() => view.result.current.setText(first))
		let task!: Promise<void>
		act(() => {
			task = view.result.current.submit()
		})
		preference = { ...preference, modelPath: '/models/other.bin', modelOptions: { ...preference.modelOptions, lang: 'en', init_prompt: 'changed' } }
		view.rerender()
		await act(async () => {
			response.resolve([{ url: first, platform: 'youtube' }])
			await task
		})
		const snapshot = vi.mocked(queue.enqueue).mock.calls[0][1]!
		expect(snapshot.modelPath).toBe('/models/Qwen3-ASR-1.7B')
		expect(snapshot.modelOptions.lang).toBe('zh')
		expect(snapshot.modelOptions.init_prompt).toBe('项目术语')
	})

	it('does not change previous ready items when a later attempt is cancelled', async () => {
		mocks.download.mockImplementation(async (url: string) => {
			if (url === first) throw new Error('下载失败')
			return { path: '/trusted-temp/second.m4a', title: '视频二' }
		})
		const { result } = setup()
		act(() => result.current.setText('两个分享链接'))
		await act(() => result.current.submit())
		const failedId = result.current.items.find((item) => item.stage === 'error')!.id
		const response = deferred<{ url: string; platform: string }[]>()
		mocks.resolve.mockReturnValueOnce(response.promise)
		let task!: Promise<void>
		act(() => {
			task = result.current.retry(failedId)
		})
		act(() => result.current.cancel())
		await act(async () => {
			response.resolve([{ url: first, platform: 'youtube' }])
			await task
		})
		expect(result.current.items.find((item) => item.label === '视频二')?.stage).toBe('ready')
		expect(queue.enqueue).toHaveBeenCalledOnce()
	})
})

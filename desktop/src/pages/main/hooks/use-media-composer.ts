import { listen } from '@tauri-apps/api/event'
import { remove } from '@tauri-apps/plugin-fs'
import { useEffect, useRef, useState } from 'react'
import { resolveMediaInput } from '~/lib/media-input'
import { cancelMediaDownload, downloadMedia, ensureMediaDownloader } from '~/lib/media-download'
import { lockModel } from '~/lib/model-lock'
import type { NamedPath } from '~/lib/types'
import type { Preference } from '~/providers/preference'
import type { EnqueueItem, TranscribeQueue } from './transcribe-queue-types'

export interface MediaInputItem {
	id: string
	label: string
	kind: 'text' | 'url' | 'file'
	stage: 'queued' | 'parsing' | 'downloading' | 'preparing' | 'ready' | 'error' | 'cancelled'
	progress: number | null
	error?: string
	sourceUrl?: string
}

interface PendingItem extends MediaInputItem {
	input: string
	file?: NamedPath
}

interface DownloadProgress {
	requestId: string
	stage: 'downloading' | 'preparing'
	progress: number | null
}

let counter = 0
function nextId() {
	return `media-${Date.now()}-${++counter}`
}
function errorMessage(cause: unknown) {
	return typeof cause === 'object' && cause !== null && 'message' in cause ? String(cause.message) : String(cause)
}
function retryable(item: MediaInputItem) {
	return item.stage === 'error' || item.stage === 'cancelled'
}

export function useMediaComposer(preference: Preference, queue: TranscribeQueue) {
	const [text, setText] = useState('')
	const [files, setFiles] = useState<NamedPath[]>([])
	const [items, setItems] = useState<PendingItem[]>([])
	const [preparing, setPreparing] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const draftRef = useRef({ text, files })
	const itemsRef = useRef(items)
	const runningRef = useRef(false)
	const mounted = useRef(true)
	const abortRef = useRef<AbortController | null>(null)
	const requestRef = useRef<{ id: string; itemId: string } | null>(null)
	const live = useRef({ preference, queue })
	live.current = { preference, queue }

	function updateDraft(next: typeof draftRef.current) {
		draftRef.current = next
		if (mounted.current) {
			setText(next.text)
			setFiles(next.files)
		}
	}
	function commit(next: PendingItem[]) {
		itemsRef.current = next
		if (mounted.current) setItems(next)
	}
	function patch(id: string, changes: Partial<PendingItem>) {
		commit(itemsRef.current.map((item) => (item.id === id ? { ...item, ...changes } : item)))
	}

	useEffect(() => {
		mounted.current = true
		const unlisten = listen<DownloadProgress>('media-download-progress', ({ payload }) => {
			const request = requestRef.current
			if (!mounted.current || !request || request.id !== payload.requestId || abortRef.current?.signal.aborted) return
			patch(request.itemId, { stage: payload.stage, progress: payload.progress })
		})
		return () => {
			mounted.current = false
			abortRef.current?.abort()
			if (requestRef.current) void cancelMediaDownload(requestRef.current.id).catch(() => undefined)
			void unlisten.then((stop) => stop())
		}
	}, [])

	function addFiles(incoming: NamedPath[]) {
		if (runningRef.current || live.current.queue.running) return
		const combined = [...draftRef.current.files]
		const paths = new Set(combined.map((file) => file.path))
		for (const file of incoming) {
			if (!paths.has(file.path)) {
				paths.add(file.path)
				combined.push(file)
			}
		}
		updateDraft({ ...draftRef.current, files: combined })
		setError(null)
	}

	async function run(pending: PendingItem[], snapshot: Preference) {
		if (runningRef.current || live.current.queue.running || !pending.length) return
		runningRef.current = true
		setPreparing(true)
		setError(null)
		const unlock = lockModel()
		const controller = new AbortController()
		abortRef.current = controller
		const attemptIds = new Set(pending.map((item) => item.id))
		const accepted: EnqueueItem[] = []
		// Only native download results enter this set. User-selected paths are never removed.
		const temporaryPaths = new Set<string>()
		let handedToQueue = false
		try {
			for (const item of pending) {
				if (controller.signal.aborted) break
				if (item.kind === 'file' && item.file) {
					accepted.push(item.file)
					patch(item.id, { stage: 'ready', progress: null, error: undefined })
					continue
				}
				patch(item.id, { stage: 'parsing', progress: null, error: undefined })
				try {
					// Every attempt, including a retry, must receive a valid online model response.
					const links = await resolveMediaInput(item.input, snapshot.ai.connection, controller.signal)
					if (controller.signal.aborted) break
					if (!links.length) throw new Error('文本模型未返回可用链接，请重试。')
					const targets: PendingItem[] =
						item.kind === 'url'
							? [{ ...item, input: links[0].url }]
							: links.map((link) => ({
									id: nextId(),
									label: new URL(link.url).hostname,
									input: link.url,
									kind: 'url',
									stage: 'queued',
									progress: null,
								}))
					for (const target of targets) attemptIds.add(target.id)
					if (item.kind === 'text') commit(itemsRef.current.flatMap((entry) => (entry.id === item.id ? targets : [entry])))
					for (const target of targets) {
						if (controller.signal.aborted) break
						patch(target.id, { stage: 'downloading', progress: null, error: undefined })
						try {
							await ensureMediaDownloader(controller.signal)
							if (controller.signal.aborted) break
							// Native cancellation is scoped to one attempt, never the stable UI item id.
							const requestId = nextId()
							requestRef.current = { id: requestId, itemId: target.id }
							const downloaded = await downloadMedia(target.input, requestId)
							temporaryPaths.add(downloaded.path)
							if (controller.signal.aborted) break
							accepted.push({ path: downloaded.path, name: downloaded.title || '链接音频', source: 'url', sourceUrl: downloaded.sourceUrl })
							patch(target.id, { stage: 'ready', label: downloaded.title || target.label, sourceUrl: downloaded.sourceUrl, progress: null })
						} catch (cause) {
							if (!controller.signal.aborted) patch(target.id, { stage: 'error', error: errorMessage(cause), progress: null })
						} finally {
							requestRef.current = null
						}
					}
				} catch (cause) {
					if (!controller.signal.aborted) patch(item.id, { stage: 'error', error: errorMessage(cause), progress: null })
				}
			}
			if (controller.signal.aborted) {
				commit(
					itemsRef.current.map((item) =>
						attemptIds.has(item.id) && item.stage !== 'error' ? { ...item, stage: 'cancelled', progress: null } : item,
					),
				)
			} else if (accepted.length) {
				live.current.queue.enqueue(accepted, snapshot)
				handedToQueue = true
				const acceptedPaths = new Set(accepted.map((item) => item.path))
				updateDraft({
					text: itemsRef.current.some((item) => retryable(item) && item.kind !== 'file') ? draftRef.current.text : '',
					files: draftRef.current.files.filter((file) => !acceptedPaths.has(file.path)),
				})
			}
		} catch (cause) {
			if (mounted.current) setError(errorMessage(cause))
			commit(
				itemsRef.current.map((item) =>
					attemptIds.has(item.id) && item.stage === 'ready' ? { ...item, stage: 'error', error: '未能加入转写，请重试。' } : item,
				),
			)
		} finally {
			if (!handedToQueue) await Promise.allSettled([...temporaryPaths].map((path) => remove(path)))
			abortRef.current = null
			runningRef.current = false
			if (mounted.current) setPreparing(false)
			unlock()
		}
	}

	function snapshot() {
		const current = live.current.preference
		return { ...current, modelOptions: { ...current.modelOptions, lang: 'zh' }, ai: { ...current.ai, connection: { ...current.ai.connection } } }
	}

	async function submit() {
		if (runningRef.current || live.current.queue.running) return
		if (!live.current.preference.modelPath) {
			setError('请先选择可用的语音识别模型')
			return
		}
		const draft = draftRef.current
		if (!draft.text.trim() && !draft.files.length) return
		const failed = itemsRef.current.filter(retryable)
		// Successful inputs already left the draft. Selecting one again is a new explicit job.
		const existingPaths = new Set(failed.filter((item) => item.kind === 'file').map((item) => item.input))
		const newFiles: PendingItem[] = draft.files
			.filter((file) => !existingPaths.has(file.path))
			.map((file) => ({ id: nextId(), label: file.name, kind: 'file', stage: 'queued', progress: null, input: file.path, file }))
		// Retained text reuses only failed items; successful URLs never enter a retry again.
		const newText: PendingItem[] =
			draft.text.trim() && !itemsRef.current.some((item) => item.kind !== 'file')
				? [{ id: nextId(), label: '解析分享内容', input: draft.text, kind: 'text', stage: 'queued', progress: null }]
				: []
		const pending = [...failed, ...newFiles, ...newText]
		commit([...itemsRef.current, ...newFiles, ...newText])
		await run(pending, snapshot())
	}

	async function retry(id: string) {
		const item = itemsRef.current.find((item) => item.id === id)
		if (!item || !retryable(item) || !live.current.preference.modelPath) return
		await run([item], snapshot())
	}

	function cancel() {
		abortRef.current?.abort()
		if (requestRef.current) void cancelMediaDownload(requestRef.current.id).catch(() => undefined)
	}
	function clear() {
		if (runningRef.current || live.current.queue.running) return
		updateDraft({ text: '', files: [] })
		commit([])
		setError(null)
	}
	function editText(next: string) {
		if (runningRef.current || live.current.queue.running) return
		if (draftRef.current.text !== next) commit([])
		updateDraft({ ...draftRef.current, text: next })
		setError(null)
	}
	function removeFile(path: string) {
		if (runningRef.current || live.current.queue.running) return
		updateDraft({ ...draftRef.current, files: draftRef.current.files.filter((file) => file.path !== path) })
		commit(itemsRef.current.filter((item) => !(item.kind === 'file' && item.input === path && retryable(item))))
	}

	return { text, setText: editText, files, addFiles, removeFile, items, preparing, error, submit, retry, cancel, clear }
}

export type MediaComposer = ReturnType<typeof useMediaComposer>

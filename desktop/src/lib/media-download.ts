import { invoke } from '@tauri-apps/api/core'
import * as ytdlp from './ytdlp'

export interface DownloadedMedia {
	path: string
	title: string
	sourceUrl?: string
}

let installing: Promise<void> | null = null

/** The app owns this tool; installation uses the existing official release downloader. */
export async function ensureMediaDownloader(signal?: AbortSignal) {
	if (signal?.aborted) throw new Error('已取消下载器准备')
	if (await ytdlp.exists()) return
	if (!installing) {
		installing = (async () => {
			let version: string
			try {
				version = await ytdlp.getLatestVersion()
			} catch {
				throw new Error('无法获取下载器版本，请检查网络后重试')
			}
			await ytdlp.downloadYtDlp(version)
		})().finally(() => {
			installing = null
		})
	}
	if (!signal) {
		await installing
		return
	}
	let onAbort = () => {}
	try {
		await Promise.race([
			installing,
			new Promise<never>((_, reject) => {
				onAbort = () => reject(new Error('已取消下载器准备'))
				signal.addEventListener('abort', onAbort, { once: true })
				if (signal.aborted) onAbort()
			}),
		])
	} finally {
		signal.removeEventListener('abort', onAbort)
	}
}

export function downloadMedia(url: string, requestId: string) {
	return invoke<DownloadedMedia>('download_media', { url, requestId })
}

export async function cancelMediaDownload(requestId: string) {
	await invoke('cancel_media_download', { requestId })
}

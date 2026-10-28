import { invoke } from '@tauri-apps/api/core'
import type { InstalledModel } from './model'

export const QWEN_MODEL_NAME = 'Qwen3-ASR-1.7B'

export interface QwenModelStatus {
	path: string
	installed: boolean
	reason: string | null
}

export type QwenDownloadResult = { status: 'completed'; path: string } | { status: 'cancelled' }

export function isQwenModelPath(path: string) {
	return (
		path
			.replace(/[\\/]+$/, '')
			.split(/[\\/]/)
			.pop()
			?.toLowerCase() === QWEN_MODEL_NAME.toLowerCase()
	)
}

export function getQwenModelStatus() {
	return invoke<QwenModelStatus>('qwen_model_status')
}

export function downloadQwenModel() {
	return invoke<QwenDownloadResult>('download_qwen_model')
}

export async function listInstalledQwenModels(folder: string): Promise<InstalledModel[]> {
	try {
		return await invoke<InstalledModel[]>('list_qwen_models', { folder })
	} catch (error) {
		console.error('failed to list Qwen models:', error)
		return []
	}
}

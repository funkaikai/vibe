import { defaultModel, type AiConnection } from './config'

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
export const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const
export type ConnectionPreset = 'deepseek' | 'custom'

/** 预设只是连接表单的默认值，不改变其他 AI 任务的开关。 */
export function connectionPreset(connection: AiConnection): ConnectionPreset {
	try {
		return new URL(connection.openaiBaseUrl).origin === DEEPSEEK_BASE_URL ? 'deepseek' : 'custom'
	} catch {
		return 'custom'
	}
}

export function applyConnectionPreset(connection: AiConnection, preset: ConnectionPreset): AiConnection {
	return {
		...connection,
		platform: 'openai',
		openaiBaseUrl: preset === 'deepseek' ? DEEPSEEK_BASE_URL : 'https://api.openai.com/v1',
		model: preset === 'deepseek' ? DEEPSEEK_MODELS[0] : defaultModel('openai'),
		// 显式更换服务时重新填写凭据，不能把另一家服务的 Key 带过去。
		openaiApiKey: '',
	}
}

export function updateConnectionBaseUrl(connection: AiConnection, baseUrl: string): Partial<AiConnection> {
	return {
		openaiBaseUrl: baseUrl,
		...(baseUrl !== connection.openaiBaseUrl ? { openaiApiKey: '' } : {}),
	}
}

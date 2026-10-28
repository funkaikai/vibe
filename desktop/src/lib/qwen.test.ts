import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getFriendlyModelName, listInstalledModels, withoutUnsupportedOptions, type ModelCapabilities } from './model'
import { isQwenModelPath } from './qwen'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), readDir: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/path', () => ({ join: async (...parts: string[]) => parts.join('/') }))
vi.mock('@tauri-apps/plugin-fs', () => ({ readDir: mocks.readDir }))

const whisper = { name: 'ggml-large-v3.bin', path: '/models/ggml-large-v3.bin', valid: true, reason: null }
const qwen = { name: 'Qwen3-ASR-1.7B', path: '/models/Qwen3-ASR-1.7B', valid: true, reason: null }

beforeEach(() => {
	vi.resetAllMocks()
	mocks.readDir.mockResolvedValue([
		{ name: whisper.name, isFile: true },
		{ name: qwen.name, isFile: false },
		{ name: 'ggml-silero-v6.2.0.bin', isFile: true },
	])
	mocks.invoke.mockImplementation(async (command: string) => {
		if (command === 'list_qwen_models') return [qwen]
		if (command === 'check_model_files') return [{ ...whisper, size: 1024 }]
		throw new Error(`Unexpected command: ${command}`)
	})
})

describe('Qwen model management', () => {
	it('lists a Qwen directory alongside file models and preserves the explicit folder', async () => {
		const models = await listInstalledModels('/models')
		expect(models).toContainEqual(whisper)
		expect(models).toContainEqual(qwen)
		expect(models.filter((model) => model.path === qwen.path)).toHaveLength(1)
		expect(mocks.invoke).toHaveBeenCalledWith('list_qwen_models', { folder: '/models' })
	})

	it('keeps existing models available if the Qwen directory check fails', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		mocks.invoke.mockImplementation(async (command: string) => {
			if (command === 'list_qwen_models') throw new Error('Qwen unavailable')
			return [{ ...whisper, size: 1024 }]
		})
		expect(await listInstalledModels('/models')).toContainEqual(whisper)
		vi.restoreAllMocks()
	})

	it('keeps incomplete Qwen directories marked invalid', async () => {
		mocks.invoke.mockImplementation(async (command: string) => {
			if (command === 'list_qwen_models') return [{ ...qwen, valid: false, reason: '缺少模型分片' }]
			return [{ ...whisper, size: 1024 }]
		})
		expect(await listInstalledModels('/models')).toContainEqual({ ...qwen, valid: false, reason: '缺少模型分片' })
	})

	it('recognizes the exact directory name and keeps its model spelling', () => {
		expect(isQwenModelPath('/models/Qwen3-ASR-1.7B/')).toBe(true)
		expect(isQwenModelPath('/models/Qwen3-ASR-1.7B.bin')).toBe(false)
		expect(getFriendlyModelName(qwen.name)).toBe('Qwen3-ASR-1.7B')
	})

	it('preserves Qwen prompts and language while omitting unsupported Whisper controls', () => {
		const capabilities: ModelCapabilities = {
			engine: 'qwen3-asr',
			requires_vad: false,
			languages: ['zh'],
			language_detection: true,
			streaming: false,
			translation: false,
			timestamps: false,
			text_prompts: true,
		}
		const options = {
			lang: 'zh',
			init_prompt: '专有名词：千问',
			translate: true,
			word_timestamps: true,
			stable_timestamps: true,
			max_sentence_len: 40,
			sampling_strategy: 'beam_search',
			best_of: 3,
			beam_size: 5,
			temperature: 0.5,
			max_text_ctx: 100,
			n_threads: 8,
		}
		expect(withoutUnsupportedOptions(options, capabilities)).toEqual({ lang: 'zh', init_prompt: '专有名词：千问', n_threads: 8 })
		expect(options.word_timestamps).toBe(true)
	})
})

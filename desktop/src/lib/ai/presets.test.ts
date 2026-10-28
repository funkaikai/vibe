import { describe, expect, it } from 'vitest'
import { DEFAULT_AI } from './config'
import { applyConnectionPreset, connectionPreset, DEEPSEEK_BASE_URL, updateConnectionBaseUrl } from './presets'

describe('OpenAI compatible connection presets', () => {
	it('fills DeepSeek without mutating the original connection or borrowing its key', () => {
		const original = { ...DEFAULT_AI.connection, openaiApiKey: 'old-service-key' }
		const selected = applyConnectionPreset(original, 'deepseek')
		expect(selected).toMatchObject({ platform: 'openai', openaiBaseUrl: DEEPSEEK_BASE_URL, model: 'deepseek-flash', openaiApiKey: '' })
		expect(original.openaiApiKey).toBe('old-service-key')
		expect(connectionPreset(selected)).toBe('deepseek')
	})

	it('preserves configured connections unless a preset is deliberately applied', () => {
		const original = { ...DEFAULT_AI.connection, openaiBaseUrl: 'https://custom.example.com/v1', model: 'custom-model', openaiApiKey: 'custom-key' }
		expect(connectionPreset(original)).toBe('custom')
		expect(original).toMatchObject({ model: 'custom-model', openaiApiKey: 'custom-key' })
	})

	it('clears the DeepSeek key when explicitly switching back to a custom service', () => {
		const selected = applyConnectionPreset({ ...DEFAULT_AI.connection, openaiBaseUrl: DEEPSEEK_BASE_URL, openaiApiKey: 'deepseek-key' }, 'custom')
		expect(selected.openaiBaseUrl).toBe('https://api.openai.com/v1')
		expect(selected.openaiApiKey).toBe('')
	})

	it('clears credentials on URL edits, and leaves them intact if the URL did not change', () => {
		const original = { ...DEFAULT_AI.connection, openaiBaseUrl: DEEPSEEK_BASE_URL, openaiApiKey: 'deepseek-key' }
		expect(updateConnectionBaseUrl(original, 'https://another.example.com/v1')).toMatchObject({ openaiApiKey: '' })
		expect(updateConnectionBaseUrl(original, original.openaiBaseUrl)).not.toHaveProperty('openaiApiKey')
	})

	it('does not identify a lookalike host as DeepSeek', () => {
		expect(connectionPreset({ ...DEFAULT_AI.connection, openaiBaseUrl: 'https://api.deepseek.com.attacker.example' })).toBe('custom')
	})
})

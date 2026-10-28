// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '~/components/ui/tooltip'
import { DEFAULT_AI, type AiSettings } from '~/lib/ai/config'
import { DEEPSEEK_BASE_URL } from '~/lib/ai/presets'
import { AiSection } from './ai'
import type { SettingsViewModel } from './shared'

vi.mock('~/components/ui/select', () => ({
	Select: ({ value, onValueChange, children }: { value: string; onValueChange: (value: string) => void; children: ReactNode }) => (
		<select aria-label="文本模型服务" value={value} onChange={(event) => onValueChange(event.target.value)}>
			{children}
		</select>
	),
	SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
	SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
	SelectTrigger: () => null,
	SelectValue: () => null,
}))

afterEach(cleanup)

function openSettings(initial: AiSettings) {
	const onChange = vi.fn()
	function Harness() {
		const [ai, setAi] = useState(initial)
		const vm = {
			preference: {
				ai,
				setAi: (next: AiSettings) => {
					onChange(next)
					setAi(next)
				},
			},
			aiTest: undefined,
			testAi: vi.fn(),
		} as unknown as SettingsViewModel
		return (
			<TooltipProvider>
				<AiSection vm={vm} onOpenPrompt={() => {}} />
			</TooltipProvider>
		)
	}
	const rendered = render(<Harness />)
	return { ...rendered, onChange }
}

describe('AI connection settings', () => {
	it('preserves an existing custom model and key on mount, then deliberately applies DeepSeek', () => {
		const initial = {
			...DEFAULT_AI,
			connection: {
				...DEFAULT_AI.connection,
				platform: 'openai' as const,
				openaiBaseUrl: 'https://custom.example.com/v1',
				model: 'existing-model',
				openaiApiKey: 'old-service-placeholder',
			},
		}
		const { onChange, container } = openSettings(initial)
		expect(onChange).not.toHaveBeenCalled()
		expect(screen.getByDisplayValue('existing-model')).toBeTruthy()
		expect(screen.getByDisplayValue('old-service-placeholder')).toBeTruthy()
		fireEvent.change(screen.getByLabelText('文本模型服务'), { target: { value: 'deepseek' } })
		expect(onChange).toHaveBeenLastCalledWith({
			...initial,
			connection: { ...initial.connection, openaiBaseUrl: DEEPSEEK_BASE_URL, model: 'deepseek-flash', openaiApiKey: '' },
		})
		expect(container.querySelectorAll('datalist option').length).toBe(2)
		expect(screen.getByText(/首页的所有链接都需经过在线文本模型解析/)).toBeTruthy()
	})

	it('clears the old key before the next API address is saved, and keeps a custom model editable', () => {
		const { onChange } = openSettings({
			...DEFAULT_AI,
			connection: {
				...DEFAULT_AI.connection,
				platform: 'openai',
				openaiBaseUrl: DEEPSEEK_BASE_URL,
				model: 'deepseek-flash',
				openaiApiKey: 'placeholder-key',
			},
		})
		fireEvent.change(screen.getByDisplayValue(DEEPSEEK_BASE_URL), { target: { value: 'https://custom.example.com/v1' } })
		expect(onChange.mock.lastCall?.[0].connection).toMatchObject({ openaiBaseUrl: 'https://custom.example.com/v1', openaiApiKey: '' })
		fireEvent.change(screen.getByDisplayValue('deepseek-flash'), { target: { value: 'my-api-model' } })
		expect(onChange.mock.lastCall?.[0].connection.model).toBe('my-api-model')
	})
})

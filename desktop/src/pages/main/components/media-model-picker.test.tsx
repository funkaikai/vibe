// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../session'
import MediaModelPicker from './media-model-picker'

const mocks = vi.hoisted(() => ({
	useSession: vi.fn(),
	listInstalledModels: vi.fn(),
	isModelFileUsable: vi.fn(),
	invoke: vi.fn(),
	openSettingsSection: vi.fn(),
}))
vi.mock('../session', () => ({ useSession: mocks.useSession }))
vi.mock('~/lib/app', () => ({ openSettingsSection: mocks.openSettingsSection }))
vi.mock('~/lib/model', () => ({
	listInstalledModels: mocks.listInstalledModels,
	isModelFileUsable: mocks.isModelFileUsable,
	getFriendlyModelName: (name: string) => name.replace('ggml-', '').replace('.bin', ''),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/path', () => ({ join: (...parts: string[]) => Promise.resolve(parts.join('/')) }))

let session: Session
beforeEach(() => {
	vi.clearAllMocks()
	session = {
		busy: false,
		preference: { modelPath: '/models/ggml-small.bin', modelDisplayNames: {}, setModelPath: vi.fn(), setModelMetadata: vi.fn() },
	} as unknown as Session
	mocks.useSession.mockImplementation(() => session)
	mocks.listInstalledModels.mockResolvedValue([
		{ path: '/models/Qwen3-ASR-1.7B', name: 'Qwen3-ASR-1.7B', valid: true, reason: null },
		{ path: '/models/corrupt.bin', name: 'corrupt.bin', valid: false, reason: 'too small' },
	])
	mocks.invoke.mockResolvedValue({ capabilities: { requires_vad: false } })
})
afterEach(cleanup)

describe('首页语音模型选择', () => {
	it('lists installed models and waits for metadata before changing persisted selection', async () => {
		let finish!: (metadata: unknown) => void
		mocks.invoke.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve
				}),
		)
		const onBusyChange = vi.fn()
		render(<MediaModelPicker onBusyChange={onBusyChange} />)
		fireEvent.click(screen.getByRole('button', { name: '选择语音识别模型' }))
		fireEvent.click(await screen.findByRole('button', { name: /^Qwen3-ASR/ }))
		expect(onBusyChange).toHaveBeenCalledWith(true)
		expect(session.preference.setModelPath).not.toHaveBeenCalled()
		await act(async () => finish({ capabilities: { requires_vad: false } }))
		expect(session.preference.setModelPath).toHaveBeenCalledExactlyOnceWith('/models/Qwen3-ASR-1.7B')
		expect(session.preference.setModelMetadata).toHaveBeenCalledExactlyOnceWith({ capabilities: { requires_vad: false } })
		expect(onBusyChange).toHaveBeenLastCalledWith(false)
		expect(mocks.invoke).not.toHaveBeenCalledWith('load_model', expect.anything())
	})

	it('shows corrupt weights as unavailable and provides model management', async () => {
		render(<MediaModelPicker onBusyChange={vi.fn()} />)
		fireEvent.click(screen.getByRole('button', { name: '选择语音识别模型' }))
		const corrupt = await screen.findByRole('button', { name: /^corrupt/ })
		expect(corrupt.hasAttribute('disabled')).toBe(true)
		fireEvent.click(corrupt)
		expect(session.preference.setModelPath).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole('button', { name: '管理语音模型' }))
		expect(mocks.openSettingsSection).toHaveBeenCalledExactlyOnceWith('models')
	})

	it('cannot change the model while a job is preparing or transcribing', () => {
		session.busy = true
		render(<MediaModelPicker onBusyChange={vi.fn()} />)
		expect(screen.getByRole('button', { name: '选择语音识别模型' }).hasAttribute('disabled')).toBe(true)
		expect(mocks.listInstalledModels).not.toHaveBeenCalled()
	})

	it('does not apply an asynchronous selection if another task has started', async () => {
		let finish!: (metadata: unknown) => void
		mocks.invoke.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve
				}),
		)
		const view = render(<MediaModelPicker onBusyChange={vi.fn()} />)
		fireEvent.click(screen.getByRole('button', { name: '选择语音识别模型' }))
		fireEvent.click(await screen.findByRole('button', { name: /^Qwen3-ASR/ }))
		session.busy = true
		view.rerender(<MediaModelPicker onBusyChange={vi.fn()} />)
		await act(async () => finish({ capabilities: { requires_vad: false } }))
		await waitFor(() => expect(session.preference.setModelPath).not.toHaveBeenCalled())
	})
})

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '~/components/ui/tooltip'
import { QwenModelSection } from './qwen-model'
import type { SettingsViewModel } from './shared'

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	emit: vi.fn(),
	success: vi.fn(),
	setOpen: vi.fn(),
	setProgress: vi.fn(),
	setMessage: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ emit: mocks.emit }))
vi.mock('sonner', () => ({ toast: { success: mocks.success } }))
vi.mock('~/providers/toast', () => ({
	useToastProvider: () => ({ open: false, setOpen: mocks.setOpen, setProgress: mocks.setProgress, setMessage: mocks.setMessage }),
}))

const modelPath = '/models/Qwen3-ASR-1.7B'
const absent = { path: modelPath, installed: false, reason: null }

beforeEach(() => {
	vi.resetAllMocks()
	mocks.emit.mockResolvedValue(undefined)
	mocks.invoke.mockImplementation(async (command: string) => {
		if (command === 'qwen_model_status') return absent
		throw new Error(`Unexpected command: ${command}`)
	})
})
afterEach(cleanup)

function openModel(currentModelPath: string | null = null) {
	const loadModels = vi.fn().mockResolvedValue(undefined)
	const selectModel = vi.fn().mockResolvedValue(undefined)
	const onBusyChange = vi.fn()
	const vm = { models: [], preference: { modelPath: currentModelPath }, loadModels, selectModel } as unknown as SettingsViewModel
	const rendered = render(
		<TooltipProvider>
			<QwenModelSection vm={vm} onBusyChange={onBusyChange} />
		</TooltipProvider>,
	)
	return { ...rendered, loadModels, selectModel, onBusyChange }
}

describe('Qwen model settings', () => {
	it('waits for successful download and refresh before choosing the model', async () => {
		let complete!: (result: { status: 'completed'; path: string }) => void
		mocks.invoke.mockImplementation(async (command: string) =>
			command === 'qwen_model_status'
				? absent
				: new Promise((resolve) => {
						complete = resolve
					}),
		)
		const vm = openModel()
		const button = await screen.findByRole('button', { name: '下载并使用' })
		await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
		fireEvent.click(button)
		expect(vm.selectModel).not.toHaveBeenCalled()
		expect(await screen.findByLabelText('下载中')).toBeTruthy()
		await act(async () => complete({ status: 'completed', path: modelPath }))
		expect(vm.loadModels).toHaveBeenCalledOnce()
		expect(vm.selectModel).toHaveBeenCalledExactlyOnceWith(modelPath)
		expect(vm.loadModels.mock.invocationCallOrder[0]).toBeLessThan(vm.selectModel.mock.invocationCallOrder[0])
		expect(mocks.setOpen).toHaveBeenLastCalledWith(false)
		expect(vm.onBusyChange).toHaveBeenLastCalledWith(false)
	})

	it('does not select a model if cancellation races with a completed download', async () => {
		let complete!: (result: { status: 'completed'; path: string }) => void
		mocks.invoke.mockImplementation(async (command: string) =>
			command === 'qwen_model_status'
				? absent
				: new Promise((resolve) => {
						complete = resolve
					}),
		)
		const vm = openModel()
		const button = await screen.findByRole('button', { name: '下载并使用' })
		await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
		fireEvent.click(button)
		fireEvent.click(await screen.findByRole('button', { name: '取消下载' }))
		expect(mocks.emit).toHaveBeenCalledExactlyOnceWith('abort_download')
		await act(async () => complete({ status: 'completed', path: modelPath }))
		expect(vm.selectModel).not.toHaveBeenCalled()
		expect(mocks.success).not.toHaveBeenCalled()
		expect(mocks.setOpen).toHaveBeenLastCalledWith(false)
	})

	it('keeps a failed download visible and offers a retry without switching models', async () => {
		mocks.invoke.mockImplementation(async (command: string) => {
			if (command === 'qwen_model_status') return absent
			throw new Error('模型下载失败')
		})
		const vm = openModel('/models/ggml-large-v3.bin')
		const button = await screen.findByRole('button', { name: '下载并使用' })
		await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
		fireEvent.click(button)
		expect((await screen.findByRole('alert')).textContent).toContain('模型下载失败')
		expect(screen.getByRole('button', { name: '重新下载并使用' })).toBeTruthy()
		expect(vm.selectModel).not.toHaveBeenCalled()
		expect(mocks.setOpen).toHaveBeenLastCalledWith(false)
	})

	it('uses an installed model without downloading it again', async () => {
		mocks.invoke.mockResolvedValue({ ...absent, installed: true })
		const vm = openModel()
		fireEvent.click(await screen.findByRole('button', { name: '使用此模型' }))
		await waitFor(() => expect(vm.selectModel).toHaveBeenCalledExactlyOnceWith(modelPath))
		expect(mocks.invoke).not.toHaveBeenCalledWith('download_qwen_model')
	})

	it('shows the persisted selection and does not start any download on mount', async () => {
		mocks.invoke.mockResolvedValue({ ...absent, installed: true })
		openModel(modelPath)
		expect(await screen.findByLabelText('当前模型')).toBeTruthy()
		expect(screen.queryByRole('button', { name: '使用此模型' })).toBeNull()
		expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('qwen_model_status')
	})

	it('can repair an installed, selected model even when its files pass the size check', async () => {
		mocks.invoke.mockImplementation(async (command: string) => {
			if (command === 'qwen_model_status') return { ...absent, installed: true }
			if (command === 'download_qwen_model') return { status: 'completed', path: modelPath }
			throw new Error(`Unexpected command: ${command}`)
		})
		const vm = openModel(modelPath)
		fireEvent.click(await screen.findByRole('button', { name: '校验并修复' }))
		await waitFor(() => expect(vm.selectModel).toHaveBeenCalledExactlyOnceWith(modelPath))
		expect(mocks.invoke).toHaveBeenCalledWith('download_qwen_model')
		expect(mocks.success).toHaveBeenCalledWith('Qwen3-ASR-1.7B 已校验并修复')
	})
})

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../session'
import IdleHero, { MediaInputProgress } from './idle-hero'

const mocks = vi.hoisted(() => ({ useSession: vi.fn(), openSettingsSection: vi.fn() }))
vi.mock('../session', () => ({ useSession: mocks.useSession }))
vi.mock('~/lib/app', () => ({ openSettingsSection: mocks.openSettingsSection }))
vi.mock('./media-model-picker', () => ({ default: () => <button type="button">Qwen3-ASR · 1.7B</button> }))
vi.mock('~/components/audio-device-input', () => ({ default: () => null }))

function makeSession() {
	return {
		composer: {
			text: '',
			setText: vi.fn(),
			files: [],
			removeFile: vi.fn(),
			items: [],
			preparing: false,
			error: null,
			submit: vi.fn().mockResolvedValue(undefined),
			retry: vi.fn().mockResolvedValue(undefined),
			cancel: vi.fn(),
			clear: vi.fn(),
		},
		busy: false,
		dragging: false,
		collectingFolder: false,
		panel: 'none',
		setPanel: vi.fn(),
		browse: vi.fn().mockResolvedValue(undefined),
		preference: { modelPath: '/models/Qwen3-ASR-1.7B' },
		recording: { isRecording: false },
	} as unknown as Session
}

let session: Session
beforeEach(() => {
	vi.clearAllMocks()
	session = makeSession()
	mocks.useSession.mockImplementation(() => session)
})
afterEach(cleanup)

describe('统一转写输入框', () => {
	it('keeps local attachments staged until send and permits removal', () => {
		session.composer.files = [{ name: '会议.mp4', path: '/local/meeting.mp4' }]
		render(<IdleHero />)
		expect(screen.getByText('会议.mp4')).toBeTruthy()
		expect(session.composer.submit).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole('button', { name: '选择文件' }))
		expect(session.browse).toHaveBeenCalledOnce()
		expect(session.composer.submit).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole('button', { name: '移除 会议.mp4' }))
		expect(session.composer.removeFile).toHaveBeenCalledExactlyOnceWith('/local/meeting.mp4')
		fireEvent.click(screen.getByRole('button', { name: '开始转写' }))
		expect(session.composer.submit).toHaveBeenCalledOnce()
	})

	it('disables empty submission and guides model setup when no model is selected', () => {
		session.preference.modelPath = null
		session.composer.text = 'https://www.bilibili.com/video/BV123'
		render(<IdleHero />)
		expect(screen.getByRole('button', { name: '开始转写' }).hasAttribute('disabled')).toBe(true)
		fireEvent.click(screen.getByRole('button', { name: '先选择或下载语音模型' }))
		expect(mocks.openSettingsSection).toHaveBeenCalledExactlyOnceWith('models')
	})

	it('preserves share text and submits with Command+Enter after IME composition finishes', () => {
		session.composer.text = '复制此链接 https://v.douyin.com/example/ 打开抖音'
		render(<IdleHero />)
		const input = screen.getByRole('textbox', { name: '链接或分享文案' }) as HTMLTextAreaElement
		expect(input.value).toBe(session.composer.text)
		fireEvent.change(input, { target: { value: `${session.composer.text}，谢谢` } })
		expect(session.composer.setText).toHaveBeenCalledExactlyOnceWith(`${session.composer.text}，谢谢`)
		fireEvent.keyDown(input, { key: 'Enter' })
		fireEvent.compositionStart(input)
		fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
		expect(session.composer.submit).not.toHaveBeenCalled()
		fireEvent.compositionEnd(input)
		fireEvent.keyDown(input, { key: 'Enter', metaKey: true, isComposing: true })
		expect(session.composer.submit).not.toHaveBeenCalled()
		fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
		expect(session.composer.submit).toHaveBeenCalledOnce()
	})

	it('keeps failed input visible, retries one item and opens online model settings', () => {
		session.composer.text = 'https://youtu.be/example'
		session.composer.items = [
			{
				id: 'failed-1',
				input: 'https://youtu.be/example',
				label: 'YouTube 分享',
				kind: 'url',
				stage: 'error',
				progress: null,
				error: '需要登录才能下载',
			},
		]
		render(<IdleHero />)
		expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(session.composer.text)
		expect(screen.getByText('需要登录才能下载')).toBeTruthy()
		fireEvent.click(screen.getByRole('button', { name: '重试 YouTube 分享' }))
		expect(session.composer.retry).toHaveBeenCalledExactlyOnceWith('failed-1')
		expect(session.composer.submit).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole('button', { name: '配置文本模型' }))
		expect(mocks.openSettingsSection).toHaveBeenCalledExactlyOnceWith('ai')
	})

	it('locks input while processing and shows no invented percentage', () => {
		session.busy = true
		session.composer.text = 'https://xhslink.com/example'
		session.composer.preparing = true
		session.composer.items = [
			{ id: 'download', input: 'https://example.com/audio.mp3', label: '小红书分享', kind: 'url', stage: 'downloading', progress: null },
		]
		render(<IdleHero />)
		expect(screen.getByRole('textbox').hasAttribute('disabled')).toBe(true)
		expect(screen.getByRole('button', { name: '选择文件' }).hasAttribute('disabled')).toBe(true)
		expect(screen.getByRole('button', { name: '开始转写' }).hasAttribute('disabled')).toBe(true)
		expect(screen.getByText('正在下载媒体')).toBeTruthy()
		expect(screen.queryByRole('progressbar')).toBeNull()
		fireEvent.click(screen.getByRole('button', { name: '取消准备' }))
		expect(session.composer.cancel).toHaveBeenCalledOnce()
	})

	it('uses actual download progress in the reusable result-page status area', () => {
		session.composer.items = [
			{ id: 'download', input: 'https://example.com/audio.mp3', label: 'B站视频', kind: 'url', stage: 'downloading', progress: 42.2 },
		]
		render(<MediaInputProgress compact />)
		expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42')
		expect(screen.getByText('正在下载媒体 · 42%')).toBeTruthy()
	})
})

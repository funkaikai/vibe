import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AI, type AiConnection } from './ai/config'
import { extractMediaUrls, MEDIA_INPUT_MAX_LENGTH, MEDIA_INPUT_TIMEOUT_MS, mediaPlatform, parseMediaInputResponse, resolveMediaInput } from './media-input'

const fetchMock = vi.fn()
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: (...args: unknown[]) => fetchMock(...args) }))

const connection: AiConnection = {
	...DEFAULT_AI.connection,
	platform: 'openai',
	openaiBaseUrl: 'https://api.deepseek.com',
	openaiApiKey: 'test-placeholder-key',
	model: 'deepseek-flash',
}
const douyin = 'https://v.douyin.com/abc/'
const youtube = 'https://youtu.be/xyz'
const resultFor = (urls: string[]) => JSON.stringify({ links: urls.map((url) => ({ url, platform: mediaPlatform(url) })) })
function respond(reply: string) {
	fetchMock.mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: reply } }] }) })
}

afterEach(() => {
	fetchMock.mockReset()
	vi.useRealTimers()
})

describe('extractMediaUrls', () => {
	it('extracts a full Douyin share, strips surrounding punctuation and preserves first encounter order', () => {
		expect(extractMediaUrls(`5.28 打开抖音看看【例子】 ${douyin}。复制此链接，打开抖音！\n(${youtube}) ${douyin}`)).toEqual([douyin, youtube])
	})

	it('keeps meaningful URL punctuation, fragments and percent-encoded values', () => {
		expect(extractMediaUrls('https://media.example.com/test(a).mp4?token=ab%2Fcd&x=1#t=12')).toEqual([
			'https://media.example.com/test(a).mp4?token=ab%2Fcd&x=1#t=12',
		])
	})

	it('returns no candidates for ordinary text or file links', () => {
		expect(extractMediaUrls('帮我转写 file:///Users/example/audio.mp3')).toEqual([])
	})

	it('rejects oversized input and link batches', () => {
		expect(() => extractMediaUrls('x'.repeat(MEDIA_INPUT_MAX_LENGTH + 1))).toThrow('输入过长')
		expect(() => extractMediaUrls(Array.from({ length: 21 }, (_, i) => `https://youtu.be/${i}`).join('\n'))).toThrow('最多处理 20')
	})

	it.each([
		'https://user:password@example.com/file.mp4',
		'http://127.1/media.mp3',
		'http://2130706433/file.mp3',
		'http://localhost/media',
		'http://192.168.1.1/media',
		'http://[::1]/media',
	])('rejects unsafe input %s', (url) => {
		expect(() => extractMediaUrls(url)).toThrow()
	})

	it.each([
		['https://www.bilibili.com/video/BV1', 'bilibili'],
		['https://b23.tv/abc', 'bilibili'],
		['https://xhslink.com/a/abc', 'xiaohongshu'],
		['https://www.xiaohongshu.com/explore/abc', 'xiaohongshu'],
		['https://www.youtube.com/watch?v=abc', 'youtube'],
		[douyin, 'douyin'],
		['https://weibo.com/tv/show/1', 'weibo'],
		['https://cdn.example.com/media', 'direct'],
		['https://youtube.com.attacker.example/media', 'direct'],
	])('classifies domains exactly: %s', (url, platform) => {
		expect(mediaPlatform(url)).toBe(platform)
	})
})

describe('parseMediaInputResponse', () => {
	it('uses the original order and actual URL domains instead of a mistaken platform label', () => {
		const reply = JSON.stringify({
			links: [
				{ url: youtube, platform: 'douyin' },
				{ url: douyin, platform: 'youtube' },
			],
		})
		expect(parseMediaInputResponse(reply, [douyin, youtube])).toEqual([
			{ url: douyin, platform: 'douyin' },
			{ url: youtube, platform: 'youtube' },
		])
	})

	it('accepts JSON code fences', () => {
		expect(parseMediaInputResponse(`\`\`\`json\n${resultFor([douyin])}\n\`\`\``, [douyin])).toHaveLength(1)
	})

	it('rejects invented or edited URLs, including a changed signature', () => {
		expect(() => parseMediaInputResponse(resultFor(['https://v.douyin.com/invented/']), [douyin])).toThrow('原文中不存在')
		expect(() => parseMediaInputResponse(resultFor(['https://media.example.com/a.mp4']), ['https://media.example.com/a.mp4?token=original'])).toThrow(
			'原文中不存在',
		)
	})

	it('rejects incomplete results rather than silently dropping inputs', () => {
		expect(() => parseMediaInputResponse(resultFor([douyin]), [douyin, youtube])).toThrow('未完整解析')
		expect(() => parseMediaInputResponse('{"links":[]}', [douyin])).toThrow('未完整解析')
	})

	it.each(['hello', '[]', '{}', '{"links":[{"url":3,"platform":"douyin"}]}', '{"links":[{"url":"https://youtu.be/xyz","platform":"shell"}]}'])(
		'rejects malformed model output %s',
		(reply) => {
			expect(() => parseMediaInputResponse(reply, [youtube])).toThrow()
		},
	)
})

describe('resolveMediaInput', () => {
	it('calls the online model even for one direct media URL and sends only input text data', async () => {
		const url = 'https://media.example.com/audio.mp3'
		respond(resultFor([url]))
		expect(await resolveMediaInput(`帮我转写 ${url}`, connection)).toEqual([{ url, platform: 'direct' }])
		expect(fetchMock).toHaveBeenCalledOnce()
		const [endpoint, options] = fetchMock.mock.calls[0]
		expect(endpoint).toBe('https://api.deepseek.com/chat/completions')
		expect(options.headers.Authorization).toBe('Bearer test-placeholder-key')
		const body = JSON.parse(options.body)
		expect(body.model).toBe('deepseek-flash')
		expect(body.messages[0].content).toContain('帮我转写')
		expect(body.messages[0].content).not.toContain('test-placeholder-key')
		expect(options.signal).toBeInstanceOf(AbortSignal)
	})

	it('never calls a local/unsupported model or an unconfigured API', async () => {
		await expect(resolveMediaInput(douyin, { ...connection, platform: 'ollama' })).rejects.toMatchObject({ code: 'configuration' })
		await expect(resolveMediaInput(douyin, { ...connection, openaiApiKey: '' })).rejects.toMatchObject({ code: 'configuration' })
		await expect(resolveMediaInput(douyin, { ...connection, openaiBaseUrl: 'https://user:key@example.com/v1' })).rejects.toMatchObject({
			code: 'configuration',
		})
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('does not send a request for text with no valid link', async () => {
		await expect(resolveMediaInput('这段话不包含链接', connection)).rejects.toMatchObject({ code: 'input' })
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it.each([
		[401, '鉴权失败'],
		[403, '鉴权失败'],
		[429, '受限'],
		[500, '调用失败'],
	])('returns a safe Chinese error for HTTP %d without falling back', async (status, message) => {
		fetchMock.mockResolvedValue({ ok: false, status, statusText: 'Error', text: async () => 'private-response-with-a-secret-key' })
		await expect(resolveMediaInput(douyin, connection)).rejects.toThrow(message)
		expect(fetchMock).toHaveBeenCalledOnce()
	})

	it('rejects an invalid successful response', async () => {
		respond('我建议执行 curl')
		await expect(resolveMediaInput(douyin, connection)).rejects.toMatchObject({ code: 'response' })
	})

	it('cancels immediately even when the HTTP adapter does not settle', async () => {
		fetchMock.mockImplementation(() => new Promise(() => {}))
		const controller = new AbortController()
		const result = resolveMediaInput(douyin, connection, controller.signal)
		const assertion = expect(result).rejects.toMatchObject({ code: 'cancelled' })
		controller.abort()
		await assertion
		expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
	})

	it('does not call the adapter for an already cancelled task', async () => {
		const controller = new AbortController()
		controller.abort()
		await expect(resolveMediaInput(douyin, connection, controller.signal)).rejects.toMatchObject({ code: 'cancelled' })
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('bounds an unresponsive API request with a timeout', async () => {
		vi.useFakeTimers()
		fetchMock.mockImplementation(() => new Promise(() => {}))
		const result = resolveMediaInput(douyin, connection)
		const assertion = expect(result).rejects.toThrow('超时')
		await vi.advanceTimersByTimeAsync(MEDIA_INPUT_TIMEOUT_MS)
		await assertion
		expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
	})
})

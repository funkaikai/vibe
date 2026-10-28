import { listen } from '@tauri-apps/api/event'
import { ArrowUp, Check, FileAudio2, FolderOpen, Globe2, Link2, Mic, RefreshCw, SlidersHorizontal, Square, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { m } from '~/paraglide/messages.js'
import AudioDeviceInput from '~/components/audio-device-input'
import { Button } from '~/components/ui/button'
import { Spinner } from '~/components/ui/spinner'
import { openSettingsSection } from '~/lib/app'
import { cn } from '~/lib/style'
import type { MediaInputItem } from '../hooks/use-media-composer'
import { useSession } from '../session'
import MediaModelPicker from './media-model-picker'

function formatElapsed(seconds: number) {
	const minutes = Math.floor(seconds / 60)
	return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

// Live capture meter — five hairline bars driven by the backend's `record_level` event
// (a 0..1 peak, throttled to ~10/s). Center bars react hardest so the shape reads as a voice.
const BAR_WEIGHTS = [0.5, 0.78, 1, 0.78, 0.5]
const BAR_MIN_HEIGHT = 6
const BAR_MAX_HEIGHT = 18
/** Below this the capture counts as silence. */
const SILENCE_LEVEL = 0.03
/** How long silence must hold before the meter drops to dim stubs. */
const SILENCE_HOLD_MS = 1000
const METER_TICK_MS = 60
/** No event for this long means the stream stalled — let the target fall back to zero. */
const LEVEL_STALE_MS = 160

function LevelMeter() {
	const [level, setLevel] = useState(0)
	const [silent, setSilent] = useState(false)
	// Refs keep the audio-rate values out of the render path; only the smoothed level is state.
	const targetRef = useRef(0)
	const lastEventRef = useRef(Date.now())
	const lastSoundRef = useRef(Date.now())

	useEffect(() => {
		const unlisten = listen<number>('record_level', ({ payload }) => {
			const next = typeof payload === 'number' && Number.isFinite(payload) ? Math.min(Math.max(payload, 0), 1) : 0
			targetRef.current = next
			lastEventRef.current = Date.now()
			if (next > SILENCE_LEVEL) lastSoundRef.current = Date.now()
		})

		const timer = window.setInterval(() => {
			const now = Date.now()
			// A dead device emits nothing at all — decay so it can't freeze mid-bar.
			if (now - lastEventRef.current > LEVEL_STALE_MS) targetRef.current *= 0.6
			// Fast attack, slower release: peaks stay legible, the fall stays calm.
			setLevel((prev) => {
				const target = targetRef.current
				const eased = prev + (target - prev) * (target > prev ? 0.7 : 0.3)
				return Math.abs(eased - target) < 0.004 ? target : eased
			})
			setSilent(now - lastSoundRef.current > SILENCE_HOLD_MS)
		}, METER_TICK_MS)

		return () => {
			window.clearInterval(timer)
			unlisten.then((fn) => fn())
		}
	}, [])

	return (
		<span aria-hidden className={cn('flex h-[18px] items-center gap-[3px]', silent && 'opacity-40')}>
			{BAR_WEIGHTS.map((weight, index) => (
				<span
					key={index}
					className="w-[2px] rounded-full bg-foreground transition-[height] duration-75 ease-out"
					style={{ height: silent ? BAR_MIN_HEIGHT : BAR_MIN_HEIGHT + level * weight * (BAR_MAX_HEIGHT - BAR_MIN_HEIGHT) }}
				/>
			))}
		</span>
	)
}

function RecordPanel() {
	const { recording, recordElapsed, preference } = useSession()

	useEffect(() => {
		// The recording hook loads audio devices for this tab only.
		preference.setHomeTab('record')
	}, [])

	if (recording.isRecording) {
		return (
			<div className="flex flex-col items-center gap-4 py-2.5">
				<div className="flex items-center gap-3">
					<LevelMeter />
					<span className="font-mono text-2xl tracking-tight tabular-nums">{formatElapsed(recordElapsed)}</span>
				</div>
				<Button onClick={() => recording.stopRecord()} className="h-10 w-full rounded-xl">
					<Square className="h-3.5 w-3.5 fill-current" />
					{m.stopRecording()}
				</Button>
			</div>
		)
	}

	return (
		// Device labels become eyebrows and the triggers drop to h-10 so the panel stays a compact
		// tool row instead of a form. Restyled from here to keep AudioDeviceInput's API untouched.
		<div
			className={cn(
				'flex w-full flex-col gap-5 py-2.5',
				'[&_label]:text-[11px] [&_label]:font-medium [&_label]:tracking-[0.08em] [&_label]:text-muted-foreground [&_label]:uppercase',
			)}>
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 [&>div]:space-y-1.5 [&_button]:h-10 [&_button]:rounded-xl">
				<AudioDeviceInput type="input" devices={recording.devices} device={recording.inputDevice} setDevice={recording.setInputDevice} />
				<AudioDeviceInput type="output" devices={recording.devices} device={recording.outputDevice} setDevice={recording.setOutputDevice} />
			</div>
			<Button
				onClick={() => recording.startRecord()}
				disabled={!preference.modelPath || (!recording.inputDevice && !recording.outputDevice)}
				className="h-10 w-full rounded-xl disabled:opacity-40">
				<Mic className="h-4 w-4" />
				{m.startRecord()}
			</Button>
		</div>
	)
}

const stageLabels: Record<MediaInputItem['stage'], string> = {
	queued: '等待处理',
	parsing: '正在解析输入',
	downloading: '正在下载媒体',
	preparing: '正在准备音频',
	ready: '已加入本地转写',
	error: '处理失败',
	cancelled: '已取消',
}

/** Also stays visible above the result view when some inputs failed before transcription. */
export function MediaInputProgress({ compact = false }: { compact?: boolean }) {
	const { composer, busy, browse } = useSession()
	if (!composer.items.length && !composer.error) return null
	const failed = composer.items.some((item) => item.stage === 'error')
	return (
		<section aria-label="输入处理进度" className={cn('w-full space-y-3', compact && 'mx-auto max-w-3xl px-6 py-4')}>
			<div className="flex items-center justify-between gap-3">
				<p className="text-xs font-medium text-muted-foreground">{composer.preparing ? '正在准备转写内容' : '输入处理记录'}</p>
				{composer.preparing && (
					<Button type="button" variant="ghost" size="sm" className="h-7 rounded-full px-2 text-xs" onClick={composer.cancel}>
						取消准备
					</Button>
				)}
			</div>
			{composer.error && (
				<p role="alert" className="rounded-xl bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
					{composer.error}
				</p>
			)}
			{composer.items.length > 0 && (
				<ul className="max-h-64 divide-y divide-border/60 overflow-y-auto rounded-2xl border border-border/70 bg-background/70">
					{composer.items.map((item) => {
						const active = ['parsing', 'downloading', 'preparing'].includes(item.stage)
						const percent = active && item.progress !== null && Number.isFinite(item.progress) ? Math.max(0, Math.min(100, item.progress)) : null
						return (
							<li key={item.id} className="px-3.5 py-3">
								<div className="flex items-center gap-3">
									<span className="shrink-0 text-muted-foreground">
										{active ? (
											<Spinner className="h-4 w-4" />
										) : item.stage === 'ready' ? (
											<Check className="h-4 w-4" />
										) : item.kind === 'file' ? (
											<FileAudio2 className="h-4 w-4" />
										) : (
											<Link2 className="h-4 w-4" />
										)}
									</span>
									<div className="min-w-0 flex-1">
										<p className="truncate text-[13px] font-medium">{item.label}</p>
										<p className={cn('mt-0.5 text-xs', item.stage === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
											{item.error ?? stageLabels[item.stage]}
											{percent !== null ? ` · ${Math.round(percent)}%` : ''}
										</p>
									</div>
									{['error', 'cancelled'].includes(item.stage) && (
										<Button
											type="button"
											variant="ghost"
											size="sm"
											disabled={busy}
											aria-label={`重试 ${item.label}`}
											className="h-8 shrink-0 rounded-full px-2 text-xs"
											onClick={() => void composer.retry(item.id)}>
											<RefreshCw className="h-3.5 w-3.5" />
											重试
										</Button>
									)}
								</div>
								{percent !== null && (
									<div
										role="progressbar"
										aria-label={`${item.label}进度`}
										aria-valuemin={0}
										aria-valuemax={100}
										aria-valuenow={Math.round(percent)}
										className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
										<div className="h-full rounded-full bg-foreground/70 transition-[width]" style={{ width: `${percent}%` }} />
									</div>
								)}
							</li>
						)
					})}
				</ul>
			)}
			{(failed || composer.error) && (
				<div className="flex flex-wrap gap-1.5">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={busy}
						className="h-8 rounded-full text-xs"
						onClick={() => openSettingsSection('ai')}>
						配置文本模型
					</Button>
					<Button type="button" variant="ghost" size="sm" disabled={busy} className="h-8 rounded-full text-xs" onClick={() => void browse()}>
						<FolderOpen className="h-3.5 w-3.5" />
						选择本地文件
					</Button>
				</div>
			)}
		</section>
	)
}

export default function IdleHero() {
	const { composer, preference, busy, browse, dragging, collectingFolder, panel, setPanel, recording } = useSession()
	const [modelChanging, setModelChanging] = useState(false)
	const composing = useRef(false)
	const disabled = busy || modelChanging || collectingFolder || !preference.modelPath || (!composer.text.trim() && composer.files.length === 0)

	if (panel === 'record' || recording.isRecording) {
		return (
			<div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-5 px-6 pb-[20vh]">
				<div className="rounded-3xl border border-border bg-muted/20 p-7">
					<RecordPanel />
				</div>
				{!recording.isRecording && (
					<Button type="button" variant="ghost" onClick={() => setPanel('none')}>
						返回转写首页
					</Button>
				)}
			</div>
		)
	}

	return (
		<div className="min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center gap-6 px-6 pt-8 pb-[clamp(2rem,12vh,8rem)]">
				<div className="space-y-2.5 text-center">
					<h1 className="text-[28px] font-semibold tracking-tight text-foreground sm:text-[32px]">把音视频变成文字</h1>
					<p className="text-sm text-muted-foreground">从一段分享、一条链接，或一份本地文件开始</p>
				</div>
				<div
					className={cn(
						'relative rounded-[26px] border bg-background shadow-[0_4px_24px_rgba(0,0,0,0.045)] transition-colors focus-within:border-foreground/25',
						dragging && !busy ? 'border-primary bg-primary/5 ring-4 ring-primary/10' : 'border-border',
					)}>
					{dragging && !busy && (
						<div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[26px] bg-background/95 text-sm font-medium">
							松开以添加音视频文件
						</div>
					)}
					<textarea
						aria-label="链接或分享文案"
						placeholder="粘贴视频链接或分享文案，也可以选择音视频文件"
						value={composer.text}
						disabled={busy}
						rows={3}
						maxLength={16000}
						onChange={(event) => composer.setText(event.target.value)}
						onCompositionStart={() => {
							composing.current = true
						}}
						onCompositionEnd={() => {
							composing.current = false
						}}
						onKeyDown={(event) => {
							if (
								event.key !== 'Enter' ||
								!event.metaKey ||
								composing.current ||
								event.nativeEvent.isComposing ||
								event.nativeEvent.keyCode === 229
							)
								return
							event.preventDefault()
							if (!disabled) void composer.submit()
						}}
						className="block max-h-72 min-h-[126px] w-full resize-y rounded-t-[26px] bg-transparent px-5 pt-5 pb-3 text-[15px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/65 disabled:opacity-60 sm:px-6"
					/>
					{composer.files.length > 0 && (
						<ul aria-label="待转写文件" className="flex flex-wrap gap-2 px-5 pb-3 sm:px-6">
							{composer.files.map((file) => (
								<li
									key={file.path}
									className="flex max-w-full items-center gap-2 rounded-xl border border-border/70 bg-muted/40 py-2 ps-3 pe-1.5">
									<FileAudio2 className="h-4 w-4 shrink-0 text-muted-foreground" />
									<span className="max-w-52 truncate text-xs">{file.name}</span>
									<Button
										type="button"
										variant="ghost"
										size="iconSm"
										disabled={busy}
										aria-label={`移除 ${file.name}`}
										onClick={() => composer.removeFile(file.path)}
										className="h-6 w-6 rounded-full">
										<X className="h-3 w-3" />
									</Button>
								</li>
							))}
						</ul>
					)}
					<div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-3 sm:px-4">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={busy || collectingFolder}
							onClick={() => void browse()}
							className="h-9 rounded-full px-3 text-[13px] font-medium text-muted-foreground">
							{collectingFolder ? <Spinner className="h-4 w-4" /> : <FolderOpen className="h-4 w-4" />}
							{collectingFolder ? '正在收集文件' : '选择文件'}
						</Button>
						<div className="ms-auto flex min-w-0 items-center gap-1.5">
							<MediaModelPicker onBusyChange={setModelChanging} />
							<Button
								type="button"
								size="icon"
								disabled={disabled}
								aria-label="开始转写"
								title="开始转写（⌘ Enter）"
								onClick={() => void composer.submit()}
								className="h-9 w-9 shrink-0 rounded-full">
								{composer.preparing ? <Spinner className="h-4 w-4" /> : <ArrowUp className="h-[18px] w-[18px]" />}
							</Button>
						</div>
					</div>
				</div>
				<div className="-mt-3 flex flex-wrap items-center justify-between gap-2 px-2 text-xs text-muted-foreground">
					<div className="flex items-center gap-1.5">
						<Globe2 className="h-3.5 w-3.5" />
						<span>中文</span>
						<span className="mx-1 text-border">·</span>
						<span>链接解析使用在线模型，音视频在本机转写</span>
					</div>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-7 rounded-full px-2 text-xs font-normal"
						disabled={busy}
						onClick={() => openSettingsSection('tuning')}>
						<SlidersHorizontal className="h-3 w-3" />
						更多选项
					</Button>
				</div>
				{!preference.modelPath && (
					<Button type="button" variant="outline" className="mx-auto rounded-full text-sm" onClick={() => openSettingsSection('models')}>
						先选择或下载语音模型
					</Button>
				)}
				<MediaInputProgress />
			</div>
		</div>
	)
}

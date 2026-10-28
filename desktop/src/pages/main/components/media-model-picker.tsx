import { invoke } from '@tauri-apps/api/core'
import { join } from '@tauri-apps/api/path'
import { Check, ChevronDown, Settings2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '~/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover'
import { Spinner } from '~/components/ui/spinner'
import { openSettingsSection } from '~/lib/app'
import { vadModelFilename } from '~/lib/config'
import { getFriendlyModelName, isModelFileUsable, listInstalledModels, type InstalledModel, type ModelMetadata } from '~/lib/model'
import { isQwenModelPath } from '~/lib/qwen'
import { useSession } from '../session'

function modelLabel(modelPath: string, names: Record<string, string>, name?: string) {
	if (names[modelPath]) return names[modelPath]
	if (isQwenModelPath(modelPath)) return 'Qwen3-ASR · 1.7B'
	return getFriendlyModelName(name ?? modelPath.split(/[\\/]/).pop() ?? modelPath)
}

/** Uses the same persisted selection as settings; the queue loads weights on submission. */
export default function MediaModelPicker({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
	const { preference, busy } = useSession()
	const [open, setOpen] = useState(false)
	const [models, setModels] = useState<InstalledModel[]>([])
	const [loading, setLoading] = useState(false)
	const [changing, setChanging] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const busyRef = useRef(busy)
	const changingRef = useRef(false)
	const mounted = useRef(true)
	busyRef.current = busy

	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
		}
	}, [])

	useEffect(() => {
		if (!open || busy) return
		let active = true
		setLoading(true)
		setError(null)
		listInstalledModels()
			.then((installed) => {
				if (active) setModels(installed)
			})
			.catch(() => {
				if (active) setError('无法读取语音模型，请到模型管理中检查。')
			})
			.finally(() => {
				if (active) setLoading(false)
			})
		return () => {
			active = false
		}
	}, [open, busy])

	async function selectModel(model: InstalledModel) {
		if (busyRef.current || changingRef.current || !model.valid) return
		if (preference.modelPath === model.path) {
			setOpen(false)
			return
		}
		changingRef.current = true
		setChanging(true)
		onBusyChange(true)
		setError(null)
		try {
			// Some older Whisper weights have no metadata but remain supported by the engine.
			const metadata = await invoke<ModelMetadata>('get_model_metadata', { modelPath: model.path }).catch(() => null)
			if (metadata?.capabilities.requires_vad) {
				const folder = await invoke<string>('get_models_folder')
				if (!(await isModelFileUsable(await join(folder, vadModelFilename)))) {
					throw new Error('此模型需要语音活动检测文件，请先在模型管理中完成准备。')
				}
			}
			if (!mounted.current || busyRef.current) return
			preference.setModelMetadata(metadata)
			preference.setModelPath(model.path)
			setOpen(false)
		} catch (cause) {
			if (mounted.current) setError(cause instanceof Error ? cause.message : '无法选择此模型，请到模型管理中检查。')
		} finally {
			changingRef.current = false
			if (mounted.current) {
				setChanging(false)
				onBusyChange(false)
			}
		}
	}

	return (
		<Popover open={open && !busy} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					disabled={busy || changing}
					aria-label="选择语音识别模型"
					className="h-9 min-w-0 max-w-[240px] rounded-full px-2.5 text-[12px] font-medium text-muted-foreground sm:text-[13px]">
					{changing ? <Spinner className="h-3.5 w-3.5" /> : null}
					<span className="truncate">{preference.modelPath ? modelLabel(preference.modelPath, preference.modelDisplayNames) : '选择语音模型'}</span>
					<ChevronDown className="h-3.5 w-3.5" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-80 rounded-2xl p-2">
				<p className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">本地语音识别模型</p>
				{loading ? (
					<div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
						<Spinner className="h-4 w-4" />
						正在读取模型
					</div>
				) : (
					<div className="max-h-64 overflow-y-auto">
						{models.map((model) => (
							<button
								key={model.path}
								type="button"
								disabled={!model.valid || changing || busy}
								aria-pressed={preference.modelPath === model.path}
								onClick={() => void selectModel(model)}
								className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-accent disabled:cursor-default disabled:opacity-45">
								<span className="min-w-0 flex-1">
									<span className="block truncate text-sm">{modelLabel(model.path, preference.modelDisplayNames, model.name)}</span>
									<span className="block text-xs text-muted-foreground">
										{model.valid ? '已下载 · 本机转写' : '文件不可用，请在模型管理中修复'}
									</span>
								</span>
								{preference.modelPath === model.path && <Check className="h-4 w-4 shrink-0" />}
							</button>
						))}
						{!models.length && <p className="px-3 py-4 text-sm text-muted-foreground">还没有可用模型，请先下载语音模型。</p>}
					</div>
				)}
				{error && (
					<p role="alert" className="px-3 py-2 text-xs text-destructive">
						{error}
					</p>
				)}
				<Button
					type="button"
					variant="ghost"
					className="mt-1 w-full justify-start rounded-xl text-sm"
					disabled={changing}
					onClick={() => {
						setOpen(false)
						openSettingsSection('models')
					}}>
					<Settings2 className="h-4 w-4" />
					管理语音模型
				</Button>
			</PopoverContent>
		</Popover>
	)
}

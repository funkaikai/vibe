import { useEffect, useRef, useState } from 'react'
import { emit } from '@tauri-apps/api/event'
import { Check, Download, Loader2, RefreshCw, X } from 'lucide-react'
import { toast } from 'sonner'
import { downloadQwenModel, getQwenModelStatus, QWEN_MODEL_NAME, type QwenModelStatus } from '~/lib/qwen'
import { useToastProvider } from '~/providers/toast'
import { isModelLocked, useModelLocked } from '~/lib/model-lock'
import { IconAction, SettingsGroup, SettingsRow, type SettingsViewModel } from './shared'

export function QwenModelSection({ vm, onBusyChange }: { vm: SettingsViewModel; onBusyChange: (busy: boolean) => void }) {
	const [status, setStatus] = useState<QwenModelStatus | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [phase, setPhase] = useState<'download' | 'select' | null>(null)
	const [cancelling, setCancelling] = useState(false)
	const busy = useRef(false)
	const modelLocked = useModelLocked()
	const mounted = useRef(true)
	const downloading = useRef(false)
	const cancelRequested = useRef(false)
	const progressToast = useToastProvider()
	const selected = status?.installed && vm.preference.modelPath === status.path

	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
			if (downloading.current) {
				cancelRequested.current = true
				emit('abort_download').catch(console.error)
			}
		}
	}, [])

	useEffect(() => {
		let active = true
		getQwenModelStatus()
			.then((next) => {
				if (active) setStatus(next)
			})
			.catch((cause) => {
				if (active) setError(String(cause))
			})
		return () => {
			active = false
		}
	}, [vm.models])

	async function useModel(repair = false) {
		if (isModelLocked() || busy.current || progressToast.open || (selected && !repair)) return
		busy.current = true
		cancelRequested.current = false
		onBusyChange(true)
		setError(null)
		let ownsProgress = false
		try {
			const currentStatus = status ?? (await getQwenModelStatus())
			let modelPath = currentStatus.installed && !repair ? currentStatus.path : null
			if (!modelPath) {
				setPhase('download')
				downloading.current = true
				progressToast.setMessage('Qwen3-ASR-1.7B：当前文件下载与校验')
				progressToast.setProgress(null)
				progressToast.setOpen(true)
				ownsProgress = true
				const result = await downloadQwenModel()
				downloading.current = false
				if (result.status === 'cancelled' || cancelRequested.current || !mounted.current) return
				modelPath = result.path
				setStatus({ path: modelPath, installed: true, reason: null })
			}
			if (!mounted.current || cancelRequested.current) return
			setPhase('select')
			await vm.loadModels()
			if (!mounted.current || cancelRequested.current) return
			await vm.selectModel(modelPath)
			if (mounted.current) toast.success(repair ? 'Qwen3-ASR-1.7B 已校验并修复' : '已选择 Qwen3-ASR-1.7B')
		} catch (cause) {
			if (mounted.current && !cancelRequested.current) setError(String(cause))
		} finally {
			if (ownsProgress) {
				progressToast.setOpen(false)
				progressToast.setProgress(null)
			}
			downloading.current = false
			busy.current = false
			onBusyChange(false)
			if (mounted.current) {
				setPhase(null)
				setCancelling(false)
			}
		}
	}

	async function cancelDownload() {
		cancelRequested.current = true
		setCancelling(true)
		try {
			await emit('abort_download')
		} catch (cause) {
			setError(String(cause))
			setCancelling(false)
		}
	}

	const description =
		phase === 'download'
			? cancelling
				? '正在取消下载'
				: '正在下载与校验模型文件'
			: phase === 'select'
				? '正在选择模型'
				: selected
					? '当前模型 · CPU / Accelerate · 分段时间范围'
					: status?.installed
						? '已下载 · CPU / Accelerate'
						: '本地模型 · 4.7 GB · CPU / Accelerate'

	return (
		<SettingsGroup title="Qwen 语音模型">
			<SettingsRow label={QWEN_MODEL_NAME} description={description} clampDescription={false}>
				{phase ? (
					<>
						<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label={phase === 'download' ? '下载中' : '选择中'} />
						{phase === 'download' && (
							<IconAction label="取消下载" icon={<X className="h-4 w-4" />} onClick={cancelDownload} disabled={cancelling} />
						)}
					</>
				) : (
					<>
						{selected ? (
							<Check className="h-4 w-4 text-muted-foreground" aria-label="当前模型" />
						) : (
							<IconAction
								label={status?.installed ? '使用此模型' : error || status?.reason ? '重新下载并使用' : '下载并使用'}
								icon={
									status?.installed ? (
										<Check className="h-4 w-4" />
									) : error || status?.reason ? (
										<RefreshCw className="h-4 w-4" />
									) : (
										<Download className="h-4 w-4" />
									)
								}
								onClick={() => useModel()}
								disabled={(!status && !error) || progressToast.open || modelLocked}
							/>
						)}
						{status?.installed && (
							<IconAction
								label="校验并修复"
								icon={<RefreshCw className="h-4 w-4" />}
								onClick={() => useModel(true)}
								disabled={progressToast.open || modelLocked}
							/>
						)}
					</>
				)}
			</SettingsRow>
			{(error || status?.reason) && (
				<p role="alert" className="break-words px-4 py-2.5 text-xs text-destructive">
					{error ?? status?.reason}
				</p>
			)}
		</SettingsGroup>
	)
}

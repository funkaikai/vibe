import { Download, X } from 'lucide-react'
import { useEffect } from 'react'
import { CONFIG_KEYS } from '~/lib/config-keys'
import { usePersisted } from '~/lib/config-store'
import { m } from '~/paraglide/messages.js'
import { usePreferenceProvider } from '~/providers/preference'
import { Button } from './ui/button'

export default function ModelDownloadPrompt() {
	const preference = usePreferenceProvider()
	const [dismissed, setDismissed] = usePersisted(CONFIG_KEYS.modelPromptDismissed, false)

	useEffect(() => {
		if (preference.modelPath && dismissed) {
			setDismissed(false)
		}
	}, [preference.modelPath, dismissed, setDismissed])

	if (preference.modelPath || dismissed) return null

	function downloadDefaultModel() {
		window.dispatchEvent(new CustomEvent('vibe:open-settings', { detail: { scrollTo: 'models' } }))
	}

	return (
		<aside className="fixed bottom-4 left-4 right-4 z-40 rounded-xl border border-border/70 bg-card/95 p-4 shadow-xl backdrop-blur-md sm:left-auto sm:w-[340px]">
			<Button
				variant="ghost"
				size="icon"
				className="absolute right-2 top-2 h-7 w-7 text-muted-foreground"
				onClick={() => setDismissed(true)}
				aria-label={m.cancel()}>
				<X className="h-4 w-4" />
			</Button>

			<div className="pr-7">
				<p className="font-medium">{m.noModelsInstalled()}</p>
			</div>

			<Button size="sm" className="mt-3 w-full" onClick={downloadDefaultModel}>
				<Download className="mr-2 h-4 w-4" />
				{m.downloadModel()}
			</Button>
		</aside>
	)
}

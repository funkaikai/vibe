import type { NamedPath, ProjectSource } from '~/lib/types'
import type { Segment, SpeakerNames } from '~/lib/transcript'
import type { AiThreadEntry, TranscriptRecord } from '~/lib/transcripts-store'
import type { AutoExportResult } from '~/lib/auto-export'
import type { Preference } from '~/providers/preference'

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

/** One transcription input. `projectName` re-runs an existing project under the title it already has. */
export interface EnqueueItem extends NamedPath {
	/** Title of the project this input came from; used verbatim, without a source prefix. */
	projectName?: string
	sourceUrl?: string
}

export interface Job {
	id: string
	name: string
	path: string
	/** Origin of this newly created project. */
	source?: ProjectSource
	sourceUrl?: string
	modelPath?: string | null
	language?: string
	status: JobStatus
	/** 0..100, only meaningful while running */
	progress: number
	segments: Segment[]
	error?: string
	/** wall clock seconds the transcription took */
	seconds?: number
	/** path of the .vibe.json this job was saved to / loaded from, when persisted */
	savedPath?: string
	/** true when the job was loaded from the store rather than transcribed in this session */
	hydrated?: boolean
	/** Last AI summary of this transcript, when one was made. */
	summary?: string
	/** Questions asked about this transcript and their answers, oldest first. */
	thread?: AiThreadEntry[]
	/** Names the user gave the diarized speakers, by zero-based speaker index. */
	speakerNames?: SpeakerNames
	/** What auto-export did with this transcript, when it ran. */
	exported?: AutoExportResult
}

/** A run of two or more files: what batch users watch instead of the transcripts. */
export interface BatchProgress {
	total: number
	done: number
	startedAt: number
	/** Seconds per finished file so far, for the time estimate; null until one finished. */
	secondsPerFile: number | null
}

export interface BatchSummary {
	total: number
	seconds: number
	exported: number
	skipped: number
	fallback: number
	failed: number
	/** The one folder everything went to, when there is one. */
	folder: string | null
	/** Jobs whose export did not go as planned, for "Show details". */
	exceptions: { name: string; detail: string }[]
}

export interface TranscribeQueue {
	jobs: Job[]
	activeId: string | null
	selectedId: string | null
	selectedJob: Job | null
	running: boolean
	isAborting: boolean
	hasResults: boolean
	selectJob: (id: string) => void
	enqueue: (files: EnqueueItem[], snapshot?: Preference) => void
	/** Transcribe the media already attached to a hydrated project with no transcript. */
	transcribeJob: (jobId: string) => void
	/**
	 * Replace the session with a transcript loaded from the store, shown as a finished job.
	 * `audioPath` is the media copy kept in the project folder, when it still has one; it becomes the
	 * job's path so the player keeps working after the original file moved away.
	 */
	hydrate: (record: TranscriptRecord, savedPath: string, audioPath?: string | null, source?: ProjectSource) => string | null
	/** Inline edit of one segment's text. Persists to the job's saved file when it has one. */
	updateSegmentText: (jobId: string, segmentIndex: number, text: string) => void
	/** Rename the visible project and its persisted record, when one exists. */
	renameJob: (jobId: string, name: string) => Promise<boolean>
	/** Update the visible title while the inline rename editor is open. */
	previewJobName: (jobId: string, name: string) => void
	/** Attach an AI summary to a job. Persists to the job's saved file when it has one. */
	setJobSummary: (jobId: string, summary: string) => void
	/** Replace the question-and-answer thread of a job. Persists like the summary. */
	setJobThread: (jobId: string, thread: AiThreadEntry[]) => void
	/** Name one diarized speaker; an empty name restores "Speaker N". Persists like the segment edits. */
	setSpeakerName: (jobId: string, speaker: number, name: string) => void
	/** Attribute one line to a speaker: a line diarization missed, or one it got wrong. */
	setSegmentSpeaker: (jobId: string, segmentIndex: number, speaker: number) => void
	cancelCurrent: () => void
	cancelAll: () => void
	reset: () => void
	/** Progress across a run of several files, null for a single file or when idle. */
	batch: BatchProgress | null
	/** The finished card's content, until dismissed. */
	batchSummary: BatchSummary | null
	dismissBatchSummary: () => void
	/** Finished jobs auto-export has not written yet: the count behind "Export all". */
	unexportedCount: number
	/** Export every finished job that has nothing written yet, with the current settings. */
	exportFinished: () => Promise<void>
}

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MainPage from './page'

const mocks = vi.hoisted(() => ({ useSession: vi.fn() }))
vi.mock('./session', () => ({
	useSession: mocks.useSession,
	SessionProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('~/components/layout', () => ({
	SIDEBAR_STORAGE_KEY: 'test:sidebar',
	TOGGLE_SIDEBAR_EVENT: 'test:toggle-sidebar',
	default: ({ children, sidebar, bottomBar }: { children: ReactNode; sidebar: ReactNode; bottomBar: ReactNode }) => (
		<div>{sidebar}<main>{children}</main>{bottomBar}</div>
	),
}))
vi.mock('./components/idle-hero', () => ({
	default: () => {
		const { queue } = mocks.useSession()
		return <button onClick={queue.enqueue}>导入音频</button>
	},
}))
vi.mock('./components/session-view', () => ({
	default: () => {
		const { queue, startNew } = mocks.useSession()
		return (
			<div data-testid="session-view">
				<button disabled={!queue.selectedJob}>导出</button>
				<button onClick={startNew}>新建</button>
				{queue.selectedJob && <p>{queue.selectedJob.name}</p>}
			</div>
		)
	},
}))
vi.mock('./components/recents-sidebar', () => ({
	default: () => <button onClick={mocks.useSession().startNew}>侧栏新建</button>,
}))
vi.mock('./components/player-bar', () => ({ default: () => <div data-testid="player">播放器</div> }))

type Status = 'cancelled' | 'done' | 'running'
interface TestJob { id: string; name: string; status: Status }
interface TestSession {
	mode: 'idle' | 'working' | 'done'
	dragging: boolean
	queue: { jobs: TestJob[]; selectedJob: TestJob | null; enqueue: () => void }
	startNew: () => void
}
const Context = createContext<TestSession | null>(null)

function Fixture({ status }: { status: Status }) {
	const [jobs, setJobs] = useState<TestJob[]>([{ id: 'old', name: '原任务', status }])
	const session: TestSession = {
		mode: jobs.length === 0 ? 'idle' : jobs.some((job) => job.status === 'running') ? 'working' : 'done',
		dragging: false,
		queue: {
			jobs,
			selectedJob: jobs[0] ?? null,
			enqueue: () => setJobs([{ id: 'new', name: '新任务', status: 'running' }]),
		},
		startNew: () => setJobs([]),
	}
	return <Context.Provider value={session}><MainPage /></Context.Provider>
}

beforeEach(() => {
	mocks.useSession.mockImplementation(() => useContext(Context))
	window.localStorage.clear()
})
afterEach(cleanup)

describe('starting a new transcription session', () => {
	it.each(['cancelled', 'done'] as const)('returns directly to import after a %s job, then opens a new task', (status) => {
		render(<Fixture status={status} />)
		expect(screen.getByText('原任务')).toBeTruthy()
		expect(screen.getByTestId('player')).toBeTruthy()
		fireEvent.click(screen.getByRole('button', { name: /^新建$/ }))
		expect(screen.getByRole('button', { name: '导入音频' })).toBeTruthy()
		expect(screen.queryByTestId('session-view')).toBeNull()
		expect(screen.queryByTestId('player')).toBeNull()
		fireEvent.click(screen.getByRole('button', { name: '导入音频' }))
		expect(screen.getByText('新任务')).toBeTruthy()
		expect(screen.getByTestId('player')).toBeTruthy()
		expect(screen.queryByRole('button', { name: '导入音频' })).toBeNull()
	})

	it('also resets through the sidebar after a cancelled task', () => {
		render(<Fixture status="cancelled" />)
		fireEvent.click(screen.getByRole('button', { name: '侧栏新建' }))
		expect(screen.getByRole('button', { name: '导入音频' })).toBeTruthy()
		expect(screen.queryByTestId('session-view')).toBeNull()
	})
})

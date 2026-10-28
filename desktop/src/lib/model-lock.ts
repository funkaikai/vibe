import { useSyncExternalStore } from 'react'

const locks = new Set<symbol>()
const listeners = new Set<() => void>()

export function isModelLocked() {
	return locks.size > 0
}

export function lockModel() {
	const token = Symbol('media-task')
	locks.add(token)
	for (const listener of listeners) listener()
	return () => {
		locks.delete(token)
		for (const listener of listeners) listener()
	}
}

export function useModelLocked() {
	return useSyncExternalStore((listener) => {
		listeners.add(listener)
		return () => listeners.delete(listener)
	}, isModelLocked)
}

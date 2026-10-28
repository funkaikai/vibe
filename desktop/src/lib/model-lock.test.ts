import { describe, expect, it } from 'vitest'
import { isModelLocked, lockModel } from './model-lock'

describe('overlapping preparation and transcription locks', () => {
	it('keeps the model locked until every stage has released its lock', () => {
		const prepare = lockModel()
		const transcribe = lockModel()
		expect(isModelLocked()).toBe(true)
		prepare()
		expect(isModelLocked()).toBe(true)
		transcribe()
		expect(isModelLocked()).toBe(false)
		transcribe()
		expect(isModelLocked()).toBe(false)
	})
})

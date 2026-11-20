import { describe, it, expect } from 'vitest'
import * as childProcess from 'node:child_process'
import { terminateProcessTree } from './process-tree-terminator'

describe('terminateProcessTree (Phase 10 Step 10.12)', () => {
  it('1. safely ignores undefined, null, negative, or invalid PIDs', async () => {
    await expect(terminateProcessTree(undefined)).resolves.toBeUndefined()
    await expect(terminateProcessTree(-1)).resolves.toBeUndefined()
    await expect(terminateProcessTree(0)).resolves.toBeUndefined()
    await expect(terminateProcessTree(4)).resolves.toBeUndefined() // System PID
    await expect(terminateProcessTree(process.pid)).resolves.toBeUndefined() // Self PID guard
  })

  it('2. successfully terminates spawned child process without throwing', async () => {
    // Spawn a lightweight idle process to simulate an OCR job
    const child = childProcess.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore'
    })

    const pid = child.pid
    expect(pid).toBeDefined()
    expect(typeof pid).toBe('number')

    await terminateProcessTree(pid)

    // Give OS a moment to reap
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Confirm process is dead
    let isAlive = true
    try {
      process.kill(pid!, 0) // signal 0 tests existence
    } catch {
      isAlive = false
    }
    expect(isAlive).toBe(false)
  })
})

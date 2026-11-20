import * as childProcess from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'

/**
 * Resolves the trusted absolute path to Windows taskkill.exe.
 * Prevents arbitrary PATH manipulation or shell hijacking.
 */
function resolveSystemTaskkillPath(): string {
  const winDir = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const candidate = path.join(winDir, 'System32', 'taskkill.exe')
  if (fs.existsSync(candidate)) {
    return candidate
  }
  return 'taskkill.exe'
}

/**
 * Deterministically terminates an OS process and all of its spawned child/descendant processes.
 *
 * Windows Implementation:
 * - Direct execution of %SystemRoot%\System32\taskkill.exe with arguments ['/F', '/T', '/PID', String(pid)].
 * - shell: false to prevent command interpolation or CMD injection.
 * - Validates that PID is a strictly positive integer.
 * - Handles race conditions where the process already exited (exit code 128 / "process not found").
 *
 * POSIX Implementation:
 * - Attempts process group kill (kill(-pid, SIGKILL)), falling back to direct process kill.
 */
export async function terminateProcessTree(pid: number | undefined): Promise<void> {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return
  }

  // Safety check: Never kill System Idle (0), System (4), or current process
  if (pid <= 4 || pid === process.pid) {
    return
  }

  if (process.platform === 'win32') {
    return new Promise<void>((resolve) => {
      try {
        const taskkillPath = resolveSystemTaskkillPath()
        const killer = childProcess.spawn(taskkillPath, ['/F', '/T', '/PID', String(pid)], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore'
        })

        killer.on('exit', () => {
          resolve()
        })

        killer.on('error', () => {
          // If taskkill fails to spawn, attempt standard Node process.kill as final resort
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // Already dead
          }
          resolve()
        })
      } catch {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Process already exited
        }
        resolve()
      }
    })
  }

  // POSIX (Linux / macOS)
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Process already exited
    }
  }
}

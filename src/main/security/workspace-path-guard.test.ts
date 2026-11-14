import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  WorkspacePathGuard,
  WorkspaceSecurityError,
  MAX_WORKSPACE_FILE_SIZE_BYTES
} from './workspace-path-guard'

describe('WorkspacePathGuard (Phase 8 Step 8.3)', () => {
  let tempDir: string
  let canonicalRoot: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-guard-test-'))
    canonicalRoot = fs.realpathSync.native(tempDir)
  })

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error on busy locks
    }
  })

  describe('Root Directory Validation', () => {
    it('1. accepts a valid existing directory and resolves canonical path', () => {
      const resolved = WorkspacePathGuard.validateRootDirectory(tempDir)
      expect(resolved).toBe(canonicalRoot)
    })

    it('2. rejects an empty or non-string root path', () => {
      expect(() => WorkspacePathGuard.validateRootDirectory('')).toThrow(WorkspaceSecurityError)
      expect(() => WorkspacePathGuard.validateRootDirectory('   ')).toThrow(WorkspaceSecurityError)
    })

    it('3. rejects a non-existent directory', () => {
      const nonExistent = path.join(tempDir, 'does-not-exist')
      expect(() => WorkspacePathGuard.validateRootDirectory(nonExistent)).toThrow(
        WorkspaceSecurityError
      )
    })

    it('4. rejects a root path that is a regular file, not a directory', () => {
      const filePath = path.join(tempDir, 'file.txt')
      fs.writeFileSync(filePath, 'hello')
      expect(() => WorkspacePathGuard.validateRootDirectory(filePath)).toThrow(
        WorkspaceSecurityError
      )
    })
  })

  describe('Relative Path Syntax & Traversal Guards', () => {
    beforeEach(() => {
      fs.writeFileSync(path.join(canonicalRoot, 'sample.ts'), 'export const x = 1')
      fs.mkdirSync(path.join(canonicalRoot, 'subdir'))
      fs.writeFileSync(path.join(canonicalRoot, 'subdir', 'nested.ts'), 'export const y = 2')
    })

    it('5. accepts a valid relative path within root', () => {
      const result = WorkspacePathGuard.validatePath(canonicalRoot, 'sample.ts')
      expect(result.normalizedRelativePath).toBe('sample.ts')
      expect(result.canonicalPath).toBe(path.join(canonicalRoot, 'sample.ts'))

      const nestedResult = WorkspacePathGuard.validatePath(canonicalRoot, 'subdir/nested.ts')
      expect(nestedResult.normalizedRelativePath).toBe('subdir/nested.ts')
    })

    it('6. rejects empty or whitespace-only paths', () => {
      expect(() => WorkspacePathGuard.validatePath(canonicalRoot, '')).toThrow(
        WorkspaceSecurityError
      )
      expect(() => WorkspacePathGuard.validatePath(canonicalRoot, '   ')).toThrow(
        WorkspaceSecurityError
      )
    })

    it('7. rejects absolute paths and drive-qualified paths', () => {
      const absPath = path.join(canonicalRoot, 'sample.ts')
      expect(() => WorkspacePathGuard.validatePath(canonicalRoot, absPath)).toThrow(
        'Absolute, drive-qualified, or UNC paths are strictly forbidden.'
      )

      expect(() => WorkspacePathGuard.validatePath(canonicalRoot, 'C:/something.txt')).toThrow(
        WorkspaceSecurityError
      )
      expect(() => WorkspacePathGuard.validatePath(canonicalRoot, 'D:\\other.txt')).toThrow(
        WorkspaceSecurityError
      )
    })

    it('8. rejects UNC network paths', () => {
      expect(() =>
        WorkspacePathGuard.validatePath(canonicalRoot, '\\\\server\\share\\file.txt')
      ).toThrow(WorkspaceSecurityError)
      expect(() =>
        WorkspacePathGuard.validatePath(canonicalRoot, '//server/share/file.txt')
      ).toThrow(WorkspaceSecurityError)
    })

    it('9. rejects ../ directory traversal sequences', () => {
      expect(() => WorkspacePathGuard.validatePath(canonicalRoot, '../outside.ts')).toThrow(
        'Directory traversal segments (..) are strictly prohibited.'
      )
      expect(() =>
        WorkspacePathGuard.validatePath(canonicalRoot, 'subdir/../../outside.ts')
      ).toThrow('Directory traversal segments (..) are strictly prohibited.')
    })

    it('10. rejects ..\\ directory traversal sequences (Windows backslashes)', () => {
      expect(() => WorkspacePathGuard.validatePath(canonicalRoot, '..\\outside.ts')).toThrow(
        WorkspaceSecurityError
      )
      expect(() =>
        WorkspacePathGuard.validatePath(canonicalRoot, 'subdir\\..\\..\\outside.ts')
      ).toThrow(WorkspaceSecurityError)
    })

    it('11. rejects NUL bytes and control characters', () => {
      expect(() => WorkspacePathGuard.validatePath(canonicalRoot, 'sample.ts\0.exe')).toThrow(
        'Path contains invalid characters or NUL bytes.'
      )
      expect(() => WorkspacePathGuard.validatePath(canonicalRoot, 'sample.ts\x01')).toThrow(
        WorkspaceSecurityError
      )
    })

    it('12. enforces case-insensitive containment check on Windows', () => {
      if (process.platform === 'win32') {
        expect(() =>
          WorkspacePathGuard.assertContainsPath(canonicalRoot, 'C:\\NonExistentPath\\foo.txt')
        ).toThrow('Path escapes the approved workspace root directory')
      }
    })
  })

  describe('Symlink and Junction Rejection', () => {
    it('13. rejects files that are symbolic links', () => {
      const realTarget = path.join(canonicalRoot, 'real.txt')
      fs.writeFileSync(realTarget, 'real content')
      const symlinkPath = path.join(canonicalRoot, 'symlink.txt')

      try {
        fs.symlinkSync(realTarget, symlinkPath, 'file')
      } catch {
        // Skip on environments without symlink permissions (Windows dev mode unprivileged)
        return
      }

      expect(() => WorkspacePathGuard.validatePath(canonicalRoot, 'symlink.txt')).toThrow(
        'Symbolic links and junctions are strictly prohibited'
      )
    })

    it('14. rejects paths traversing through a symlinked directory', () => {
      const realDir = path.join(canonicalRoot, 'real-dir')
      fs.mkdirSync(realDir)
      fs.writeFileSync(path.join(realDir, 'file.txt'), 'content')

      const symlinkDir = path.join(canonicalRoot, 'symlink-dir')
      try {
        fs.symlinkSync(realDir, symlinkDir, 'junction')
      } catch {
        try {
          fs.symlinkSync(realDir, symlinkDir, 'dir')
        } catch {
          return // Skip if no symlink privileges
        }
      }

      expect(() => WorkspacePathGuard.validatePath(canonicalRoot, 'symlink-dir/file.txt')).toThrow(
        WorkspaceSecurityError
      )
    })
  })

  describe('Sensitive Files & Directory Blacklist', () => {
    it('15. rejects .env and .env.* files', () => {
      fs.writeFileSync(path.join(canonicalRoot, '.env'), 'SECRET=123')
      fs.writeFileSync(path.join(canonicalRoot, '.env.production'), 'SECRET=456')

      expect(() => WorkspacePathGuard.validatePath(canonicalRoot, '.env')).toThrow(
        'Access to environment variable files (.env) is prohibited.'
      )
      expect(() => WorkspacePathGuard.validatePath(canonicalRoot, '.env.production')).toThrow(
        'Access to environment variable files (.env) is prohibited.'
      )
    })

    it('16. rejects .git folder and files inside it', () => {
      const gitDir = path.join(canonicalRoot, '.git')
      fs.mkdirSync(gitDir)
      fs.writeFileSync(path.join(gitDir, 'config.txt'), '[core]')

      expect(() => WorkspacePathGuard.validatePath(canonicalRoot, '.git/config.txt')).toThrow(
        "Access to sensitive directory '.git' is prohibited."
      )
    })

    it('17. rejects SSH keys and credentials', () => {
      fs.writeFileSync(path.join(canonicalRoot, 'id_rsa'), 'private key')
      fs.writeFileSync(path.join(canonicalRoot, 'id_ed25519'), 'private key')
      fs.writeFileSync(path.join(canonicalRoot, 'credentials.json'), '{"key":"secret"}')
      fs.writeFileSync(path.join(canonicalRoot, 'token.json'), '{"token":"123"}')

      expect(() => WorkspacePathGuard.validatePath(canonicalRoot, 'id_rsa')).toThrow(
        "Access to sensitive file 'id_rsa' is prohibited."
      )
      expect(() => WorkspacePathGuard.validatePath(canonicalRoot, 'id_ed25519')).toThrow(
        WorkspaceSecurityError
      )
      expect(() => WorkspacePathGuard.validatePath(canonicalRoot, 'credentials.json')).toThrow(
        WorkspaceSecurityError
      )
      expect(() => WorkspacePathGuard.validatePath(canonicalRoot, 'token.json')).toThrow(
        WorkspaceSecurityError
      )
    })

    it('18. rejects node_modules directory access', () => {
      const nmDir = path.join(canonicalRoot, 'node_modules')
      fs.mkdirSync(nmDir)
      fs.writeFileSync(path.join(nmDir, 'pkg.json'), '{}')

      expect(() => WorkspacePathGuard.validatePath(canonicalRoot, 'node_modules/pkg.json')).toThrow(
        "Access to sensitive directory 'node_modules' is prohibited."
      )
    })

    it('19. rejects certificates and key extensions (.pem, .key, .p12, .pfx)', () => {
      fs.writeFileSync(path.join(canonicalRoot, 'cert.pem'), 'CERT')
      fs.writeFileSync(path.join(canonicalRoot, 'server.key'), 'KEY')

      expect(() => WorkspacePathGuard.validatePath(canonicalRoot, 'cert.pem')).toThrow(
        WorkspaceSecurityError
      )
      expect(() => WorkspacePathGuard.validatePath(canonicalRoot, 'server.key')).toThrow(
        WorkspaceSecurityError
      )
    })
  })

  describe('Extension Allowlist & File Types', () => {
    it('20. rejects unsupported and executable file extensions', () => {
      fs.writeFileSync(path.join(canonicalRoot, 'app.exe'), 'MZ')
      fs.writeFileSync(path.join(canonicalRoot, 'script.sh'), '#!/bin/bash')
      fs.writeFileSync(path.join(canonicalRoot, 'doc.docx'), 'word')

      expect(() => WorkspacePathGuard.validatePath(canonicalRoot, 'app.exe')).toThrow(
        "File extension '.exe' is not on the approved text file allowlist."
      )
      expect(() => WorkspacePathGuard.validatePath(canonicalRoot, 'script.sh')).toThrow(
        WorkspaceSecurityError
      )
      expect(() => WorkspacePathGuard.validatePath(canonicalRoot, 'doc.docx')).toThrow(
        WorkspaceSecurityError
      )
    })

    it('21. rejects directories passed as relative target', () => {
      fs.mkdirSync(path.join(canonicalRoot, 'mydir'))
      expect(() => WorkspacePathGuard.validatePath(canonicalRoot, 'mydir')).toThrow(
        'Target is not a regular file'
      )
    })
  })

  describe('File Size & UTF-8 Text Content Validation', () => {
    it('22. rejects files exceeding 1 MB limit', () => {
      const largeFile = path.join(canonicalRoot, 'large.txt')
      const buffer = Buffer.alloc(MAX_WORKSPACE_FILE_SIZE_BYTES + 10, 'a')
      fs.writeFileSync(largeFile, buffer)

      expect(() => WorkspacePathGuard.validatePath(canonicalRoot, 'large.txt')).toThrow(
        'exceeds 1 MB limit'
      )
    })

    it('23. rejects binary files containing NUL bytes', () => {
      const binaryFile = path.join(canonicalRoot, 'fake.txt')
      const buffer = Buffer.from([0x68, 0x65, 0x00, 0x6c, 0x6f]) // 'he\0lo'
      fs.writeFileSync(binaryFile, buffer)

      expect(() => WorkspacePathGuard.readTextFileStrict(binaryFile)).toThrow(
        'Binary file detected (contains NUL bytes).'
      )
    })

    it('24. rejects invalid UTF-8 byte sequences', () => {
      const badUtf8File = path.join(canonicalRoot, 'bad-utf8.txt')
      const buffer = Buffer.from([0xff, 0xfe, 0x80, 0x81]) // Invalid UTF-8
      fs.writeFileSync(badUtf8File, buffer)

      expect(() => WorkspacePathGuard.readTextFileStrict(badUtf8File)).toThrow(
        'File contains invalid UTF-8 byte sequences.'
      )
    })

    it('25. reads valid UTF-8 text file successfully', () => {
      const validFile = path.join(canonicalRoot, 'valid.ts')
      fs.writeFileSync(validFile, 'export const greeting = "Hello, world!"\nconsole.log(greeting)')

      const text = WorkspacePathGuard.readTextFileStrict(validFile)
      expect(text).toContain('Hello, world!')
    })
  })
})

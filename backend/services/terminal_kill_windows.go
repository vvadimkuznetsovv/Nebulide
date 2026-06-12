//go:build windows

package services

import "os"

// hasChildProcesses on Windows always returns true (can't check /proc).
func hasChildProcesses(_ int) bool { return true }

// hasClaudeProcess on Windows returns false (process tree walk requires
// extra dependencies). Production runs Linux/Alpine — this is a dev-only stub.
func hasClaudeProcess(_ int) bool { return false }

// killProcessGroup on Windows just kills the direct process.
// ConPTY doesn't have Unix process groups.
func killProcessGroup(pid int) {
	if p, err := os.FindProcess(pid); err == nil {
		p.Kill()
	}
}

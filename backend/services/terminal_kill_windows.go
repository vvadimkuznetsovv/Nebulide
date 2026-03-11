//go:build windows

package services

import "os"

// hasChildProcesses on Windows always returns true (can't check /proc).
func hasChildProcesses(_ int) bool { return true }

// killProcessGroup on Windows just kills the direct process.
// ConPTY doesn't have Unix process groups.
func killProcessGroup(pid int) {
	if p, err := os.FindProcess(pid); err == nil {
		p.Kill()
	}
}

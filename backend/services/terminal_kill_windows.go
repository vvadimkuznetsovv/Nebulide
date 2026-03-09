//go:build windows

package services

import "os"

// killProcessGroup on Windows just kills the direct process.
// ConPTY doesn't have Unix process groups.
func killProcessGroup(pid int) {
	if p, err := os.FindProcess(pid); err == nil {
		p.Kill()
	}
}

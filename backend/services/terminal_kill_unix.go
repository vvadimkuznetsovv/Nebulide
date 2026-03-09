//go:build !windows

package services

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// killProcessGroup kills the process and ALL its descendants recursively.
// Claude CLI (and other child processes) create their own process groups,
// so a simple kill(-pgid) only kills bash but not claude. We walk /proc
// to find and kill all children recursively.
func killProcessGroup(pid int) {
	// First, collect all descendant PIDs (depth-first)
	descendants := collectDescendants(pid)

	// Kill all descendants first (leaves → root), then the process itself
	for i := len(descendants) - 1; i >= 0; i-- {
		syscall.Kill(descendants[i], syscall.SIGKILL)
	}

	// Also try killing the process group (catches anything we missed)
	if pgid, err := syscall.Getpgid(pid); err == nil {
		syscall.Kill(-pgid, syscall.SIGKILL)
	}

	// Kill the main process
	syscall.Kill(pid, syscall.SIGKILL)
}

// collectDescendants walks /proc to find all child PIDs recursively.
func collectDescendants(pid int) []int {
	var result []int
	children := getChildPids(pid)
	for _, child := range children {
		result = append(result, child)
		result = append(result, collectDescendants(child)...)
	}
	return result
}

// getChildPids reads /proc to find direct children of a PID.
func getChildPids(pid int) []int {
	childrenFile := filepath.Join("/proc", strconv.Itoa(pid), "task", strconv.Itoa(pid), "children")
	data, err := os.ReadFile(childrenFile)
	if err != nil {
		return nil
	}
	var pids []int
	for _, s := range strings.Fields(string(data)) {
		if p, err := strconv.Atoi(s); err == nil {
			pids = append(pids, p)
		}
	}
	return pids
}

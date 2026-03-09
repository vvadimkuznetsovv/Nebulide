//go:build !windows

package services

import "syscall"

// killProcessGroup kills the entire process group rooted at pid.
// Shell started via PTY is the session/group leader, so -pgid kills all children.
func killProcessGroup(pid int) {
	if pgid, err := syscall.Getpgid(pid); err == nil {
		syscall.Kill(-pgid, syscall.SIGKILL)
	} else {
		syscall.Kill(pid, syscall.SIGKILL)
	}
}

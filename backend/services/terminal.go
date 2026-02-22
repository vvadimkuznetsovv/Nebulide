package services

import (
	"os"
	"os/exec"
	"runtime"
	"sync"

	gopty "github.com/aymanbagabas/go-pty"
)

type TerminalService struct {
	sessions map[string]*TerminalSession
	mu       sync.RWMutex
}

type TerminalSession struct {
	Pty  gopty.Pty
	Cmd  *gopty.Cmd
	Done chan struct{}
}

func NewTerminalService() *TerminalService {
	return &TerminalService{
		sessions: make(map[string]*TerminalSession),
	}
}

func defaultShell() string {
	if shell := os.Getenv("SHELL"); shell != "" {
		return shell
	}
	if runtime.GOOS == "windows" {
		// Must resolve absolute path — go-pty resolves relative to cmd.Dir on Windows
		if ps, err := exec.LookPath("pwsh.exe"); err == nil {
			return ps
		}
		if ps, err := exec.LookPath("powershell.exe"); err == nil {
			return ps
		}
		return "powershell.exe"
	}
	if bash, err := exec.LookPath("bash"); err == nil {
		return bash
	}
	return "/bin/bash"
}

func (s *TerminalService) Create(sessionKey string, workingDir string) (*TerminalSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Close existing session if any
	if existing, ok := s.sessions[sessionKey]; ok {
		existing.Close()
	}

	shell := defaultShell()

	p, err := gopty.New()
	if err != nil {
		return nil, err
	}

	cmd := p.Command(shell)
	cmd.Dir = workingDir
	cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
	)

	if err := cmd.Start(); err != nil {
		p.Close()
		return nil, err
	}

	session := &TerminalSession{
		Pty:  p,
		Cmd:  cmd,
		Done: make(chan struct{}),
	}

	// Monitor process exit
	go func() {
		cmd.Wait()
		close(session.Done)
	}()

	s.sessions[sessionKey] = session
	return session, nil
}

func (s *TerminalService) Get(sessionKey string) (*TerminalSession, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	session, ok := s.sessions[sessionKey]
	return session, ok
}

func (s *TerminalService) Remove(sessionKey string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if session, ok := s.sessions[sessionKey]; ok {
		session.Close()
		delete(s.sessions, sessionKey)
	}
}

func (s *TerminalService) Resize(sessionKey string, rows, cols uint16) error {
	s.mu.RLock()
	session, ok := s.sessions[sessionKey]
	s.mu.RUnlock()

	if !ok {
		return nil
	}

	return session.Pty.Resize(int(cols), int(rows))
}

func (ts *TerminalSession) Close() {
	if ts.Pty != nil {
		ts.Pty.Close()
	}
	if ts.Cmd != nil && ts.Cmd.Process != nil {
		ts.Cmd.Process.Kill()
	}
}

//go:build unix

package shellrun

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const OutputLimit = 64 << 10

// Variables only so tests can shorten them; nothing else changes them.
var (
	ReadTimeout  = 30 * time.Second
	WriteTimeout = 10 * time.Minute
)

// limitedBuffer keeps the first OutputLimit bytes and counts the rest, so a
// chatty command cannot exhaust the agent's memory.
type limitedBuffer struct {
	buf       bytes.Buffer
	truncated bool
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	room := OutputLimit - l.buf.Len()
	if room > 0 {
		if len(p) <= room {
			l.buf.Write(p)
		} else {
			l.buf.Write(p[:room])
			l.truncated = true
		}
	} else if len(p) > 0 {
		l.truncated = true
	}
	return len(p), nil
}

func resolveExecutable(argv []string) (string, error) {
	name, ok := Name(argv)
	if !ok {
		return "", errors.New("invalid executable")
	}
	dirs := ExecDirs()
	if strings.Contains(argv[0], "/") {
		dirs = []string{filepath.Dir(argv[0])}
	}
	for _, d := range dirs {
		p := filepath.Join(d, name)
		if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() && st.Mode()&0o111 != 0 {
			return p, nil
		}
	}
	return "", fmt.Errorf("%s: command not found in %s", name, strings.Join(ExecDirs(), ":"))
}

// Run classifies and executes argv. approved must only be true when the
// backend recorded a human approval for exactly this command.
func Run(argv []string, approved bool) (map[string]any, error) {
	v := Classify(argv)
	switch v.Class {
	case Deny:
		return nil, fmt.Errorf("denied (%s): %s", v.Rule, v.Reason)
	case Write:
		if !approved {
			return nil, errors.New("this command is not read-only and has no human approval")
		}
	case Read:
		paths, content := PathArgs(argv)
		for _, p := range paths {
			if real, err := filepath.EvalSymlinks(p); err == nil && !PathAllowedAfterResolve(real, content) {
				return nil, fmt.Errorf("denied (deny.path): %s resolves outside the readable locations", p)
			}
		}
	}
	exe, err := resolveExecutable(argv)
	if err != nil {
		return nil, err
	}
	timeout := ReadTimeout
	if v.Class == Write {
		timeout = WriteTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, exe, argv[1:]...)
	cmd.Args[0] = filepath.Base(exe)
	cmd.Dir = "/"
	cmd.Env = []string{
		"PATH=" + strings.Join(ExecDirs(), ":"), "LANG=C.UTF-8", "HOME=/root", "TERM=dumb",
		"PAGER=cat", "SYSTEMD_PAGER=cat", "SYSTEMD_COLORS=0", "DOCKER_CLI_HINTS=false",
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 3 * time.Second
	var stdout, stderr limitedBuffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr

	started := time.Now()
	runErr := cmd.Run()
	exit := 0
	var exitErr *exec.ExitError
	switch {
	case errors.As(runErr, &exitErr):
		exit = exitErr.ExitCode()
	case runErr != nil && ctx.Err() == nil:
		return nil, runErr
	}
	timedOut := ctx.Err() == context.DeadlineExceeded
	if timedOut {
		exit = -1
	}
	return map[string]any{
		"class":            string(v.Class),
		"rule":             v.Rule,
		"exit_code":        exit,
		"timed_out":        timedOut,
		"stdout":           Redact(stdout.buf.String()),
		"stderr":           Redact(stderr.buf.String()),
		"stdout_truncated": stdout.truncated,
		"stderr_truncated": stderr.truncated,
		"duration_ms":      time.Since(started).Milliseconds(),
	}, nil
}

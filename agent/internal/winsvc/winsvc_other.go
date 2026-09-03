//go:build !windows

// v0.1/v0.2 agents are Windows-only in production, but this build tag lets
// cmd/daemon, cmd/telemetry, cmd/executor still compile and run (interactive
// mode only, no real Windows service concept exists here) on non-Windows dev
// machines — same reasoning as internal/executor/executor_other.go.
package winsvc

type RunFunc func(stopCh <-chan struct{})

func RunAsService(_ string, run RunFunc) error {
	run(make(chan struct{}))
	return nil
}

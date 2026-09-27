//go:build windows

// Package winsvc lets each of the 3 agent binaries (cmd/daemon, cmd/telemetry,
// cmd/executor) run either as a real Windows service under the Service
// Control Manager, or directly (interactive shell) for local dev/testing —
// same binary, same RunFunc, the only difference is who's driving the
// lifecycle. Without this, `sc.exe create` on any of these binaries would
// just fail: Windows expects a service process to complete the SCM handshake
// (report StartPending/Running, respond to Stop/Shutdown) within a few
// seconds of launch, and a bare `for {}` loop that never does that gets
// killed as unresponsive.
package winsvc

import (
	"os"

	"golang.org/x/sys/windows/svc"
)

// RunFunc is the actual work loop. It must return promptly once stopCh is
// closed — the SCM gives a service a limited window to stop before killing it.
type RunFunc func(stopCh <-chan struct{})

type handler struct {
	run RunFunc
}

func (h *handler) Execute(_ []string, r <-chan svc.ChangeRequest, s chan<- svc.Status) (bool, uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown

	s <- svc.Status{State: svc.StartPending}
	stopCh := make(chan struct{})
	done := make(chan struct{})
	go func() {
		h.run(stopCh)
		close(done)
	}()
	s <- svc.Status{State: svc.Running, Accepts: accepted}

	for {
		select {
		case c := <-r:
			switch c.Cmd {
			case svc.Interrogate:
				s <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				s <- svc.Status{State: svc.StopPending}
				close(stopCh)
				<-done
				s <- svc.Status{State: svc.Stopped}
				return false, 0
			}
		case <-done:
			// RunFunc returned on its own (shouldn't normally happen — these
			// are meant to run forever — but exiting cleanly beats hanging
			// the SCM waiting for a Stopped status that never comes).
			s <- svc.Status{State: svc.Stopped}
			return false, 0
		}
	}
}

// RunAsService runs `run` under the Service Control Manager when the installer
// starts the binary with the explicit "service" argument. Avoiding automatic
// service detection makes startup deterministic across Windows versions and
// restricted service accounts. Without that argument, the binary runs in the
// foreground for local diagnostics.
func RunAsService(name string, run RunFunc) error {
	if len(os.Args) < 2 || os.Args[1] != "service" {
		run(make(chan struct{})) // blocks; never signaled — Ctrl+C/process kill is how dev mode stops
		return nil
	}
	return svc.Run(name, &handler{run: run})
}

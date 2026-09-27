//go:build windows

package tools

import (
	"fmt"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// requireStringParam moved to params.go (no build tag) — shared with the
// desktop.* computer-use tools across all OS builds.

func stateString(s svc.State) string {
	switch s {
	case svc.Stopped:
		return "STOPPED"
	case svc.StartPending:
		return "START_PENDING"
	case svc.StopPending:
		return "STOP_PENDING"
	case svc.Running:
		return "RUNNING"
	case svc.ContinuePending:
		return "CONTINUE_PENDING"
	case svc.PausePending:
		return "PAUSE_PENDING"
	case svc.Paused:
		return "PAUSED"
	default:
		return "UNKNOWN"
	}
}

// ServiceStatus queries a Windows service's current state via the Service
// Control Manager. Read-only.
func ServiceStatus(params map[string]any) (map[string]any, error) {
	name, err := requireStringParam(params, "service_name")
	if err != nil {
		return nil, err
	}

	m, err := mgr.Connect()
	if err != nil {
		return nil, fmt.Errorf("connect to service manager: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(name)
	if err != nil {
		return nil, fmt.Errorf("open service %q: %w", name, err)
	}
	defer s.Close()

	status, err := s.Query()
	if err != nil {
		return nil, fmt.Errorf("query service %q: %w", name, err)
	}

	return map[string]any{
		"service_name": name,
		"state":        stateString(status.State),
	}, nil
}

// ServiceRestart stops then starts a Windows service. Write action — the
// backend's policy engine gates this behind human approval by default (see
// registry.json: risk "medium"). The agent does not second-guess that; it
// trusts the executor only ever receives this call after approval, and focuses
// on doing the restart correctly and reporting real success/failure.
func ServiceRestart(params map[string]any) (map[string]any, error) {
	name, err := requireStringParam(params, "service_name")
	if err != nil {
		return nil, err
	}

	m, err := mgr.Connect()
	if err != nil {
		return nil, fmt.Errorf("connect to service manager: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(name)
	if err != nil {
		return nil, fmt.Errorf("open service %q: %w", name, err)
	}
	defer s.Close()

	status, err := s.Query()
	if err != nil {
		return nil, fmt.Errorf("query service %q before stop: %w", name, err)
	}

	if status.State != svc.Stopped {
		if _, err := s.Control(svc.Stop); err != nil {
			return nil, fmt.Errorf("stop service %q: %w", name, err)
		}
		if err := waitForState(s, svc.Stopped); err != nil {
			return nil, fmt.Errorf("wait for %q to stop: %w", name, err)
		}
	}

	if err := s.Start(); err != nil {
		return nil, fmt.Errorf("start service %q: %w", name, err)
	}
	if err := waitForState(s, svc.Running); err != nil {
		return nil, fmt.Errorf("wait for %q to start: %w", name, err)
	}

	return map[string]any{"service_name": name, "state": "RUNNING"}, nil
}

func waitForState(s *mgr.Service, want svc.State) error {
	const maxAttempts = 20 // ~10s at 500ms poll — generous but bounded, never hangs forever
	for i := 0; i < maxAttempts; i++ {
		status, err := s.Query()
		if err != nil {
			return err
		}
		if status.State == want {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("timed out waiting for state %s", stateString(want))
}

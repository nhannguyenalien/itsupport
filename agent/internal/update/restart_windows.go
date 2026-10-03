//go:build windows

package update

import (
	"fmt"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// Service names as registered by install/install.ps1.
var peerServices = []string{"SupportAgentTelemetry", "SupportAgentDaemon"}

func restartService(m *mgr.Mgr, name string) error {
	s, err := m.OpenService(name)
	if err != nil {
		return err
	}
	defer s.Close()
	if status, err := s.Query(); err == nil && status.State != svc.Stopped {
		s.Control(svc.Stop)
		waitFor(s, svc.Stopped, 30*time.Second)
	}
	if err := s.Start(); err != nil {
		return err
	}
	return waitFor(s, svc.Running, 30*time.Second)
}

func waitFor(s *mgr.Service, want svc.State, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if status, err := s.Query(); err == nil && status.State == want {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("service did not reach the expected state")
}

func restartPeers() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	for _, name := range peerServices {
		if err := restartService(m, name); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
	}
	return nil
}

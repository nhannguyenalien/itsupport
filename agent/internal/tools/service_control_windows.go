//go:build windows

package tools

import (
	"fmt"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// Shared stop/start helpers for the fixed-scope maintenance tools
// (printer.spooler_reset, windows_update.clear_cache). Unlike service.restart
// these never take a caller-supplied service name — each tool hardcodes the
// services it touches.

func serviceState(m *mgr.Mgr, name string) (svc.State, error) {
	s, err := m.OpenService(name)
	if err != nil {
		return 0, fmt.Errorf("open service %q: %w", name, err)
	}
	defer s.Close()
	status, err := s.Query()
	if err != nil {
		return 0, fmt.Errorf("query service %q: %w", name, err)
	}
	return status.State, nil
}

// stopServiceWithDependents stops a service, first stopping any running
// dependents (for example Fax depends on Spooler). It returns the dependents
// it stopped so the caller can start them again afterwards.
func stopServiceWithDependents(m *mgr.Mgr, name string) ([]string, error) {
	s, err := m.OpenService(name)
	if err != nil {
		return nil, fmt.Errorf("open service %q: %w", name, err)
	}
	defer s.Close()
	status, err := s.Query()
	if err != nil {
		return nil, fmt.Errorf("query service %q: %w", name, err)
	}
	if status.State == svc.Stopped {
		return nil, nil
	}
	dependents, err := s.ListDependentServices(svc.Active)
	if err != nil {
		return nil, fmt.Errorf("list dependents of %q: %w", name, err)
	}
	stopped := make([]string, 0, len(dependents))
	for _, dep := range dependents {
		ds, err := m.OpenService(dep)
		if err != nil {
			return stopped, fmt.Errorf("open dependent service %q: %w", dep, err)
		}
		_, ctlErr := ds.Control(svc.Stop)
		if ctlErr == nil {
			ctlErr = waitForState(ds, svc.Stopped)
		}
		ds.Close()
		if ctlErr != nil {
			return stopped, fmt.Errorf("stop dependent service %q: %w", dep, ctlErr)
		}
		stopped = append(stopped, dep)
	}
	if _, err := s.Control(svc.Stop); err != nil {
		return stopped, fmt.Errorf("stop service %q: %w", name, err)
	}
	if err := waitForState(s, svc.Stopped); err != nil {
		return stopped, fmt.Errorf("wait for %q to stop: %w", name, err)
	}
	return stopped, nil
}

func startServiceAndWait(m *mgr.Mgr, name string) error {
	s, err := m.OpenService(name)
	if err != nil {
		return fmt.Errorf("open service %q: %w", name, err)
	}
	defer s.Close()
	status, err := s.Query()
	if err == nil && status.State == svc.Running {
		return nil
	}
	if err := s.Start(); err != nil {
		return fmt.Errorf("start service %q: %w", name, err)
	}
	if err := waitForState(s, svc.Running); err != nil {
		return fmt.Errorf("wait for %q to start: %w", name, err)
	}
	return nil
}

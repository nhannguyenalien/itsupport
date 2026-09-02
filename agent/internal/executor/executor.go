// Package executor is the ONLY place in the agent that actually runs a tool.
// It is meant to run as its own OS process, separate from the connection
// daemon and telemetry process (see docs/v0.1-spec.md "Agent security nên là
// requirement v0.1" / process separation diagram) — this package doesn't own
// that process boundary itself (cmd/executor does), but it's written so that
// EVERY call into it re-validates the tool name against the compile-time
// allowlist, never trusting that whatever called it already checked.
package executor

import (
	"fmt"

	"support-agent/agent/internal/tools"
)

type Request struct {
	ToolCallID string
	Tool       string
	Params     map[string]any
}

type Result struct {
	ToolCallID string
	Success    bool
	Data       map[string]any
	Error      string
}

// Execute rejects any tool name that isn't in tools.KnownTools before doing
// anything else. This check alone is platform-independent and deliberately
// kept that way — it's the property spec calls out explicitly: "Agent không
// biết tool đó → reject ngay tại endpoint, kể cả backend có bug." The actual
// running of a recognized tool is delegated to dispatch(), which is
// platform-specific (executor_windows.go / executor_other.go).
func Execute(req Request) Result {
	if _, known := tools.KnownTools[req.Tool]; !known {
		return Result{
			ToolCallID: req.ToolCallID,
			Success:    false,
			Error:      fmt.Sprintf("tool %q is not in the compile-time allowlist — refusing", req.Tool),
		}
	}
	return dispatch(req)
}

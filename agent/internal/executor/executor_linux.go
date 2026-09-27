//go:build linux

package executor

import (
	"fmt"

	"support-agent/agent/internal/tools"
)

func dispatch(req Request) Result {
	def, ok := tools.Allowlist[req.Tool]
	if !ok {
		// Name passed KnownTools but has no Linux implementation wired — e.g.
		// a Windows-only IT tool like service.restart. Expected, not a bug.
		return Result{ToolCallID: req.ToolCallID, Success: false, Error: fmt.Sprintf("tool %q known but not wired in this build", req.Tool)}
	}
	data, err := def.Fn(req.Params)
	if err != nil {
		return Result{ToolCallID: req.ToolCallID, Success: false, Error: err.Error()}
	}
	return Result{ToolCallID: req.ToolCallID, Success: true, Data: data}
}

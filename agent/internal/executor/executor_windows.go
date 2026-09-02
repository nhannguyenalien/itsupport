//go:build windows

package executor

import (
	"fmt"

	"support-agent/agent/internal/tools"
)

func dispatch(req Request) Result {
	def, ok := tools.Allowlist[req.Tool]
	if !ok {
		// Name passed KnownTools but has no real implementation wired — should
		// only happen if the two registries in package tools drift apart.
		return Result{ToolCallID: req.ToolCallID, Success: false, Error: fmt.Sprintf("tool %q known but not wired in this build", req.Tool)}
	}
	data, err := def.Fn(req.Params)
	if err != nil {
		return Result{ToolCallID: req.ToolCallID, Success: false, Error: err.Error()}
	}
	return Result{ToolCallID: req.ToolCallID, Success: true, Data: data}
}

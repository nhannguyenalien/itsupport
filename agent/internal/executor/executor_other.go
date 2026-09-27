//go:build !windows && !darwin && !linux

package executor

// Fallback for any OS other than the three with a real dispatch()
// (executor_windows.go, executor_darwin.go, executor_linux.go) — keeps the
// allowlist-rejection logic (executor.go) buildable/testable everywhere else
// too. Actual execution is refused outright here rather than silently
// no-op'd.
func dispatch(req Request) Result {
	return Result{ToolCallID: req.ToolCallID, Success: false, Error: "agent has no tool implementations for this OS"}
}

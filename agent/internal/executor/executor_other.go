//go:build !windows

package executor

// v0.1 is Windows-only per docs/v0.1-spec.md scope contract. This build exists
// so the allowlist-rejection logic (executor.go) and everything above it in the
// call chain can be built and unit tested on non-Windows dev machines — actual
// execution is refused outright here rather than silently no-op'd.
func dispatch(req Request) Result {
	return Result{ToolCallID: req.ToolCallID, Success: false, Error: "agent only executes tools on windows in v0.1"}
}

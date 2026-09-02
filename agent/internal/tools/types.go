// Package tools holds every action the agent is capable of performing. This is
// the compile-time allowlist referenced throughout docs/v0.1-spec.md: if a tool
// name isn't a key in Allowlist (registry.go), the executor rejects it before
// any Windows API is touched — regardless of what the backend sends, even if the
// backend has a bug and forwards something like "powershell.exec".
package tools

// Func is the signature every tool implementation must satisfy. params comes
// straight from the backend's tool_calls.params JSONB column (already schema
// checked against registry.json server-side, but the agent does NOT trust that
// — each Func validates its own params before touching a Windows API).
type Func func(params map[string]any) (map[string]any, error)

// Risk mirrors backend/src/tool-registry/registry.json's risk field. Kept here
// too (not just trusted from the backend) so the executor can independently
// refuse to run a "write" tool if it was somehow dispatched without going
// through the approval flow — defense in depth, not the only check.
type Risk string

const (
	RiskRead   Risk = "read"
	RiskLow    Risk = "low"
	RiskMedium Risk = "medium"
	RiskHigh   Risk = "high"
)

type Definition struct {
	Fn   Func
	Risk Risk
}

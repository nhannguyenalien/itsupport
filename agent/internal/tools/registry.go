package tools

// KnownTools mirrors backend/src/tool-registry/registry.json's tool names and
// risk levels. This file has NO build tag deliberately — the executor's
// allowlist-membership check (internal/executor) needs to compile and be unit
// testable on any platform, even though the actual tool implementations
// (registry_windows.go, service_windows.go, etc.) are Windows-only. Keep the
// two registries in sync by hand for v0.1; consider codegen from registry.json
// once both sides stabilize.
var KnownTools = map[string]Risk{
	"package.status":     RiskRead,
	"package.install":    RiskHigh,
	"system.temperature": RiskRead,
	"service.status":     RiskRead,
	"process.list":       RiskRead,
	"network.ping":       RiskRead,
	"network.dns_lookup": RiskRead,
	"disk.usage":         RiskRead,
	"temp.scan":          RiskRead,
	"printer.status":     RiskRead,
	"printer.queue":      RiskRead,
	"printer.test":       RiskRead,
	"system.info":        RiskRead,
	"eventlog.read":      RiskRead,

	"service.restart":     RiskMedium,
	"process.kill":        RiskHigh,
	"network.flush_dns":   RiskLow,
	"temp.clean":          RiskLow,
	"printer.clear_queue": RiskLow,

	// v0.2 marketing-ops — opens the default browser at a backend-constructed
	// /oauth/*/connect link so a human on this machine can complete OAuth
	// consent themselves (see browser_windows.go for why this doesn't
	// automate the consent click).
	"browser.open_url": RiskLow,

	// Computer-use addendum (docs/v0.1-computer-use-addendum.md) — see
	// desktop_windows.go. screenshot/move/wait are read-risk (no device state
	// change); every action that actually clicks/types/scrolls is risk:"high"
	// so it NEVER auto-executes regardless of tenant autonomy opt-in
	// (policy-engine/index.ts) — every one is held for human approval.
	"desktop.screenshot":   RiskRead,
	"desktop.move":         RiskRead,
	"desktop.wait":         RiskRead,
	"desktop.click":        RiskHigh,
	"desktop.double_click": RiskHigh,
	"desktop.drag":         RiskHigh,
	"desktop.keypress":     RiskHigh,
	"desktop.type":         RiskHigh,
	"desktop.scroll":       RiskHigh,

	// System-triggered only (backend/src/computer-use/index.ts's
	// startSession()) — never something the AI decides to call itself. Opens
	// the customer's own browser to a read-only-plus-chat status page.
	"desktop.open_customer_view": RiskRead,
}

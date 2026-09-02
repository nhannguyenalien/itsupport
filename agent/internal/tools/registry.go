package tools

// KnownTools mirrors backend/src/tool-registry/registry.json's tool names and
// risk levels. This file has NO build tag deliberately — the executor's
// allowlist-membership check (internal/executor) needs to compile and be unit
// testable on any platform, even though the actual tool implementations
// (registry_windows.go, service_windows.go, etc.) are Windows-only. Keep the
// two registries in sync by hand for v0.1; consider codegen from registry.json
// once both sides stabilize.
var KnownTools = map[string]Risk{
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
}

//go:build windows

package tools

import "fmt"

func notImplemented(tool string) Func {
	return func(params map[string]any) (map[string]any, error) {
		return nil, fmt.Errorf("tool %q is registered but not yet implemented in this agent build", tool)
	}
}

// Allowlist is the ACTUAL compile-time dispatch table the executor calls
// through. Every key here must also be a key in KnownTools (registry.go) —
// executor.go checks both and refuses to run anything not in both, so a typo
// here just means "not implemented" rather than an unchecked new tool sneaking
// past the name allowlist.
//
// Implemented for real: service.status/restart, process.list/kill, disk.usage,
// system.info — enough to run demo scenarios A and D end-to-end. The rest are
// wired to notImplemented() so the ARCHITECTURE is complete (executor correctly
// recognizes the tool name, routes it, and gets a clean typed error back) even
// before every Win32 call is written.
var Allowlist = map[string]Definition{
	"service.status": {Fn: ServiceStatus, Risk: RiskRead},
	"process.list":   {Fn: ProcessList, Risk: RiskRead},
	"disk.usage":     {Fn: DiskUsage, Risk: RiskRead},
	"system.info":    {Fn: SystemInfo, Risk: RiskRead},

	"network.ping":       {Fn: notImplemented("network.ping"), Risk: RiskRead},
	"network.dns_lookup": {Fn: notImplemented("network.dns_lookup"), Risk: RiskRead},
	"temp.scan":          {Fn: notImplemented("temp.scan"), Risk: RiskRead},
	"printer.status":     {Fn: notImplemented("printer.status"), Risk: RiskRead},
	"printer.queue":      {Fn: notImplemented("printer.queue"), Risk: RiskRead},
	"printer.test":       {Fn: notImplemented("printer.test"), Risk: RiskRead},
	"eventlog.read":      {Fn: notImplemented("eventlog.read"), Risk: RiskRead},

	"service.restart": {Fn: ServiceRestart, Risk: RiskMedium},
	"process.kill":    {Fn: ProcessKill, Risk: RiskHigh},

	"network.flush_dns":   {Fn: notImplemented("network.flush_dns"), Risk: RiskLow},
	"temp.clean":          {Fn: notImplemented("temp.clean"), Risk: RiskLow},
	"printer.clear_queue": {Fn: notImplemented("printer.clear_queue"), Risk: RiskLow},

	"browser.open_url": {Fn: OpenURL, Risk: RiskLow},
}

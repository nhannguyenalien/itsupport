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
// Every v0.1 tool now has a real implementation. notImplemented() is kept
// around as the wiring for any tool added to KnownTools (registry.go) before
// its Win32 code lands — a name known to the executor but not yet runnable,
// rather than an unchecked new tool slipping past the allowlist.
var Allowlist = map[string]Definition{
	"service.status":     {Fn: ServiceStatus, Risk: RiskRead},
	"process.list":       {Fn: ProcessList, Risk: RiskRead},
	"disk.usage":         {Fn: DiskUsage, Risk: RiskRead},
	"system.info":        {Fn: SystemInfo, Risk: RiskRead},
	"network.ping":       {Fn: Ping, Risk: RiskRead},
	"network.dns_lookup": {Fn: DNSLookup, Risk: RiskRead},
	"temp.scan":          {Fn: TempScan, Risk: RiskRead},
	"printer.status":     {Fn: PrinterStatus, Risk: RiskRead},
	"printer.queue":      {Fn: PrinterQueue, Risk: RiskRead},
	"printer.test":       {Fn: PrinterTest, Risk: RiskRead},
	"eventlog.read":      {Fn: EventLogRead, Risk: RiskRead},

	"service.restart": {Fn: ServiceRestart, Risk: RiskMedium},
	"process.kill":    {Fn: ProcessKill, Risk: RiskHigh},

	"network.flush_dns":   {Fn: FlushDNS, Risk: RiskLow},
	"temp.clean":          {Fn: TempClean, Risk: RiskLow},
	"printer.clear_queue": {Fn: PrinterClearQueue, Risk: RiskLow},

	"browser.open_url": {Fn: OpenURL, Risk: RiskLow},

	"desktop.screenshot":   {Fn: DesktopScreenshot, Risk: RiskRead},
	"desktop.move":         {Fn: DesktopMove, Risk: RiskRead},
	"desktop.wait":         {Fn: DesktopWait, Risk: RiskRead},
	"desktop.click":        {Fn: DesktopClick, Risk: RiskHigh},
	"desktop.double_click": {Fn: DesktopDoubleClick, Risk: RiskHigh},
	"desktop.drag":         {Fn: DesktopDrag, Risk: RiskHigh},
	"desktop.keypress":     {Fn: DesktopKeypress, Risk: RiskHigh},
	"desktop.type":         {Fn: DesktopType, Risk: RiskHigh},
	"desktop.scroll":       {Fn: DesktopScroll, Risk: RiskHigh},

	"desktop.open_customer_view": {Fn: OpenCustomerView, Risk: RiskRead},
}

//go:build darwin

package tools

import "support-agent/agent/internal/update"

// Allowlist on macOS wires the 9 desktop.* computer-use tools
// (desktop_darwin.go) plus three of the general IT-diagnosis read tools
// (disk.usage/process.list/temp.scan — disk_darwin.go/process_darwin.go/
// temp_darwin.go), ported for real dogfooding on this project's own dev
// machine. The rest of the Windows-specific IT tools (service.restart,
// printer.*, eventlog.*, etc.) still have no macOS implementation and simply
// aren't listed here. They're still in KnownTools (registry.go, shared
// across every OS) so the executor's existing "known but not wired in this
// build" branch (executor_darwin.go's dispatch) reports that honestly
// instead of a tool-name allowlist failure, same as any other
// not-yet-implemented tool.
var Allowlist = map[string]Definition{
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

	"agent.update": {Fn: update.Apply, Risk: RiskMedium},

	"disk.usage":   {Fn: DiskUsage, Risk: RiskRead},
	"process.list": {Fn: ProcessList, Risk: RiskRead},
	"temp.scan":    {Fn: TempScan, Risk: RiskRead},
}

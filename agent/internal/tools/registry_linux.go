//go:build linux

package tools

// Linux diagnostics use native read-only interfaces; desktop entries remain legacy.
var Allowlist = map[string]Definition{
	"process.list":         {Fn: ProcessList, Risk: RiskRead},
	"service.status":       {Fn: ServiceStatus, Risk: RiskRead},
	"service.restart":      {Fn: ServiceRestart, Risk: RiskMedium},
	"disk.usage":           {Fn: DiskUsage, Risk: RiskRead},
	"system.info":          {Fn: SystemInfo, Risk: RiskRead},
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

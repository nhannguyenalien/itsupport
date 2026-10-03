//go:build windows

package tools

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc/mgr"
)

// Đợt 1 printer tools: printer.details (driver/port/state inventory),
// printer.spooler_reset (stuck spool files), and the GDI path used by
// printer.test when a driver refuses RAW jobs (v4/XPS class drivers).
//
// Note: the executor runs as LocalSystem, so it sees printers installed for
// the machine (the usual case for office IP/USB printers) but not per-user
// "connections" a user added to a print server from their own session.

const (
	printerAttributeDefault     = 0x00000004
	printerAttributeShared      = 0x00000008
	printerAttributeNetwork     = 0x00000010
	printerAttributeWorkOffline = 0x00000400
)

// PRINTER_INFO_2W — 136 bytes (amd64): 13 pointers then 8 DWORDs.
type printerInfo2W struct {
	pServerName         *uint16
	pPrinterName        *uint16
	pShareName          *uint16
	pPortName           *uint16
	pDriverName         *uint16
	pComment            *uint16
	pLocation           *uint16
	pDevMode            uintptr
	pSepFile            *uint16
	pPrintProcessor     *uint16
	pDatatype           *uint16
	pParameters         *uint16
	pSecurityDescriptor uintptr
	attributes          uint32
	priority            uint32
	defaultPriority     uint32
	startTime           uint32
	untilTime           uint32
	status              uint32
	cJobs               uint32
	averagePPM          uint32
}

func utf16OrEmpty(p *uint16) string {
	if p == nil {
		return ""
	}
	return windows.UTF16PtrToString(p)
}

// tcpPortTarget reads the host/port of a Standard TCP/IP port so the AI can
// ping the printer itself instead of guessing from the port name.
func tcpPortTarget(port string) (string, uint64) {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`SYSTEM\CurrentControlSet\Control\Print\Monitors\Standard TCP/IP Port\Ports\`+port, registry.QUERY_VALUE)
	if err != nil {
		return "", 0
	}
	defer k.Close()
	host, _, _ := k.GetStringValue("HostName")
	if host == "" {
		host, _, _ = k.GetStringValue("IPAddress")
	}
	portNumber, _, _ := k.GetIntegerValue("PortNumber")
	return host, portNumber
}

func spoolDirectory() string {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	return filepath.Join(root, "System32", "spool", "PRINTERS")
}

func countSpoolFiles() (int, int64) {
	entries, err := os.ReadDir(spoolDirectory())
	if err != nil {
		return 0, 0
	}
	var count int
	var bytes int64
	for _, e := range entries {
		if !e.Type().IsRegular() {
			continue
		}
		if info, err := e.Info(); err == nil {
			count++
			bytes += info.Size()
		}
	}
	return count, bytes
}

// PrinterDetails lists every printer visible to the machine with driver,
// port, network/shared flags, decoded status and queued job count, plus the
// Spooler service state and how many spool files are sitting on disk.
func PrinterDetails(params map[string]any) (map[string]any, error) {
	spoolerState := "UNKNOWN"
	if m, err := mgr.Connect(); err == nil {
		if state, err := serviceState(m, "Spooler"); err == nil {
			spoolerState = stateString(state)
		}
		m.Disconnect()
	}
	spoolFiles, spoolBytes := countSpoolFiles()
	result := map[string]any{
		"spooler_state":     spoolerState,
		"spool_files":       spoolFiles,
		"spool_files_bytes": spoolBytes,
	}
	if spoolerState != "RUNNING" {
		// EnumPrinters needs the spooler; report what we know instead of failing.
		result["printers"] = []any{}
		result["note"] = "Print Spooler is not running, printers cannot be listed"
		return result, nil
	}

	const flags = uintptr(printerEnumLocal | printerEnumConnections)
	var needed, returned uint32
	procEnumPrintersW.Call(flags, 0, 2, 0, 0, uintptr(unsafe.Pointer(&needed)), uintptr(unsafe.Pointer(&returned)))
	printers := make([]map[string]any, 0)
	if needed > 0 {
		buf := make([]byte, needed)
		ret, _, callErr := procEnumPrintersW.Call(flags, 0, 2,
			uintptr(unsafe.Pointer(&buf[0])), uintptr(needed),
			uintptr(unsafe.Pointer(&needed)), uintptr(unsafe.Pointer(&returned)))
		if ret == 0 {
			return nil, fmt.Errorf("EnumPrinters level 2: %w", callErr)
		}
		sz := unsafe.Sizeof(printerInfo2W{})
		for i := uint32(0); i < returned; i++ {
			p := (*printerInfo2W)(unsafe.Pointer(&buf[uintptr(i)*sz]))
			port := utf16OrEmpty(p.pPortName)
			entry := map[string]any{
				"name":         utf16OrEmpty(p.pPrinterName),
				"driver":       utf16OrEmpty(p.pDriverName),
				"port":         port,
				"location":     utf16OrEmpty(p.pLocation),
				"status":       decodePrinterStatus(p.status),
				"jobs":         p.cJobs,
				"shared":       p.attributes&printerAttributeShared != 0,
				"network":      p.attributes&printerAttributeNetwork != 0,
				"work_offline": p.attributes&printerAttributeWorkOffline != 0,
				"online":       p.status&printerStatusOffline == 0 && p.attributes&printerAttributeWorkOffline == 0,
			}
			if host, number := tcpPortTarget(port); host != "" {
				entry["port_host"] = host
				entry["port_number"] = number
			}
			if strings.HasPrefix(strings.ToUpper(port), "WSD") {
				entry["port_type"] = "WSD"
			}
			printers = append(printers, entry)
		}
	}
	result["printers"] = printers
	result["count"] = len(printers)
	return result, nil
}

// PrinterSpoolerReset clears jobs stuck at the spooler level: stops the
// Print Spooler (and running dependents), removes only the regular files in
// the fixed system spool directory, then starts everything again. Write
// action (risk "medium"); verification is printer.details reporting the
// spooler RUNNING (tool-calls/execution.ts).
func PrinterSpoolerReset(params map[string]any) (map[string]any, error) {
	m, err := mgr.Connect()
	if err != nil {
		return nil, fmt.Errorf("connect to service manager: %w", err)
	}
	defer m.Disconnect()

	dependents, err := stopServiceWithDependents(m, "Spooler")
	if err != nil {
		// Best effort: never leave printing down because the reset failed half way.
		startServiceAndWait(m, "Spooler")
		return nil, err
	}

	var removed, failed int
	var freed int64
	dir := spoolDirectory()
	if entries, err := os.ReadDir(dir); err == nil {
		for _, e := range entries {
			if !e.Type().IsRegular() {
				continue
			}
			info, _ := e.Info()
			if err := os.Remove(filepath.Join(dir, e.Name())); err != nil {
				failed++
				continue
			}
			removed++
			if info != nil {
				freed += info.Size()
			}
		}
	}

	if err := startServiceAndWait(m, "Spooler"); err != nil {
		return nil, err
	}
	restarted := make([]string, 0, len(dependents))
	for _, dep := range dependents {
		if startServiceAndWait(m, dep) == nil {
			restarted = append(restarted, dep)
		}
	}
	return map[string]any{
		"spooler_state":        "RUNNING",
		"spool_files_removed":  removed,
		"spool_files_failed":   failed,
		"freed_bytes":          freed,
		"dependents_restarted": restarted,
	}, nil
}

var (
	// gdi32 and procDeleteDC are shared with desktop_windows.go.
	procCreateDCW    = gdi32.NewProc("CreateDCW")
	procStartDocW    = gdi32.NewProc("StartDocW")
	procEndDoc       = gdi32.NewProc("EndDoc")
	procAbortDoc     = gdi32.NewProc("AbortDoc")
	procStartPage    = gdi32.NewProc("StartPage")
	procEndPage      = gdi32.NewProc("EndPage")
	procTextOutW     = gdi32.NewProc("TextOutW")
	procGetDeviceCap = gdi32.NewProc("GetDeviceCaps")
)

// DOCINFOW — 40 bytes (amd64).
type docInfoW struct {
	cbSize       int32
	lpszDocName  *uint16
	lpszOutput   *uint16
	lpszDatatype *uint16
	fwType       uint32
}

// gdiTestPage renders a real page through the printer driver, which works
// for drivers that reject RAW data (most v4/XPS and many modern drivers).
func gdiTestPage(name string) (int32, error) {
	driver, _ := windows.UTF16PtrFromString("WINSPOOL")
	device, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return 0, err
	}
	hdc, _, callErr := procCreateDCW.Call(uintptr(unsafe.Pointer(driver)), uintptr(unsafe.Pointer(device)), 0, 0)
	if hdc == 0 {
		return 0, fmt.Errorf("CreateDC(%q): %w", name, callErr)
	}
	defer procDeleteDC.Call(hdc)

	docName, _ := windows.UTF16PtrFromString("IT Support test page")
	doc := docInfoW{lpszDocName: docName}
	doc.cbSize = int32(unsafe.Sizeof(doc))
	jobID, _, callErr := procStartDocW.Call(hdc, uintptr(unsafe.Pointer(&doc)))
	if int32(jobID) <= 0 {
		return 0, fmt.Errorf("StartDoc(%q): %w", name, callErr)
	}
	if ret, _, e := procStartPage.Call(hdc); int32(ret) <= 0 {
		procAbortDoc.Call(hdc)
		return 0, fmt.Errorf("StartPage(%q): %w", name, e)
	}
	const logPixelsY = 90
	dpi, _, _ := procGetDeviceCap.Call(hdc, logPixelsY)
	if dpi == 0 {
		dpi = 300
	}
	lines := []string{"IT Support - printer test page", "This page was printed to verify the printer driver and queue."}
	for i, line := range lines {
		text, _ := windows.UTF16FromString(line)
		y := int32(dpi) * int32(i+1) / 2
		procTextOutW.Call(hdc, uintptr(int32(dpi)/2), uintptr(y), uintptr(unsafe.Pointer(&text[0])), uintptr(len(text)-1))
	}
	if ret, _, e := procEndPage.Call(hdc); int32(ret) <= 0 {
		procAbortDoc.Call(hdc)
		return 0, fmt.Errorf("EndPage(%q): %w", name, e)
	}
	if ret, _, e := procEndDoc.Call(hdc); int32(ret) <= 0 {
		return 0, fmt.Errorf("EndDoc(%q): %w", name, e)
	}
	return int32(jobID), nil
}

//go:build windows

package tools

import (
	"context"
	"encoding/binary"
	"fmt"
	"net"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// This file implements the three network read/low tools from
// docs/v0.1-spec.md's registry: network.ping, network.dns_lookup and
// network.flush_dns — the trio scenario B ("ping gateway -> DNS lookup fails
// -> flush DNS -> DNS lookup succeeds") is built from.
//
// Consistent with the rest of the agent, nothing here shells out to
// ping.exe / nslookup / ipconfig — each is a native API call (IcmpSendEcho,
// the Go resolver, DnsFlushResolverCache). "No arbitrary process execution"
// in the spec applies to the agent's own actions too, not just what the
// backend can ask for.

var (
	iphlpapi            = windows.NewLazySystemDLL("iphlpapi.dll")
	procIcmpCreateFile  = iphlpapi.NewProc("IcmpCreateFile")
	procIcmpCloseHandle = iphlpapi.NewProc("IcmpCloseHandle")
	procIcmpSendEcho    = iphlpapi.NewProc("IcmpSendEcho")

	dnsapi                    = windows.NewLazySystemDLL("dnsapi.dll")
	procDnsFlushResolverCache = dnsapi.NewProc("DnsFlushResolverCache")
)

// ipOptionInformation mirrors Win32 IP_OPTION_INFORMATION. Only needed so the
// icmpEchoReply layout below matches the C struct; the agent never sets IP
// options on its probes.
type ipOptionInformation struct {
	TTL         uint8
	Tos         uint8
	Flags       uint8
	OptionsSize uint8
	OptionsData *byte
}

// icmpEchoReply mirrors Win32 ICMP_ECHO_REPLY. The reply buffer handed to
// IcmpSendEcho is over-allocated and only the leading struct is read back —
// Address/Status/RoundTripTime sit at fixed offsets regardless of the trailing
// Options/Data fields, so a small layout mismatch there can't corrupt the
// values actually used.
type icmpEchoReply struct {
	Address       uint32
	Status        uint32
	RoundTripTime uint32
	DataSize      uint16
	Reserved      uint16
	Data          uintptr
	Options       ipOptionInformation
}

// Ping sends a single ICMP echo request via the IP Helper API. IPv4 only —
// enough for "ping the default gateway" in scenario B; the Windows fleets this
// targets rarely have an IPv6-only gateway. A timeout or unreachable host is
// reported as an error (result = "error" upstream), which is exactly the
// signal the AI needs to reason about connectivity.
func Ping(params map[string]any) (map[string]any, error) {
	target, err := requireStringParam(params, "target")
	if err != nil {
		return nil, err
	}

	ipAddr, err := net.ResolveIPAddr("ip4", target)
	if err != nil {
		return nil, fmt.Errorf("resolve %q to an IPv4 address: %w", target, err)
	}
	v4 := ipAddr.IP.To4()
	if v4 == nil {
		return nil, fmt.Errorf("%q did not resolve to an IPv4 address", target)
	}
	// IPAddr is a 32-bit value with the first octet in the low-order byte.
	dest := binary.LittleEndian.Uint32(v4)

	if err := procIcmpSendEcho.Find(); err != nil {
		return nil, fmt.Errorf("IcmpSendEcho unavailable: %w", err)
	}

	handle, _, callErr := procIcmpCreateFile.Call()
	if handle == 0 || handle == ^uintptr(0) { // NULL or INVALID_HANDLE_VALUE
		return nil, fmt.Errorf("IcmpCreateFile failed: %w", callErr)
	}
	defer procIcmpCloseHandle.Call(handle)

	payload := []byte("support-agent-icmp-probe--------") // 31 bytes, arbitrary
	reply := make([]byte, 1500)                           // ICMP_ECHO_REPLY + payload + slack
	const timeoutMs = 4000

	n, _, callErr := procIcmpSendEcho.Call(
		handle,
		uintptr(dest),
		uintptr(unsafe.Pointer(&payload[0])),
		uintptr(uint16(len(payload))),
		0, // no IP options
		uintptr(unsafe.Pointer(&reply[0])),
		uintptr(uint32(len(reply))),
		uintptr(uint32(timeoutMs)),
	)
	if n == 0 {
		return nil, fmt.Errorf("no ICMP reply from %s within %dms: %w", ipAddr.IP.String(), timeoutMs, callErr)
	}

	r := (*icmpEchoReply)(unsafe.Pointer(&reply[0]))
	const ipSuccess = 0
	if r.Status != ipSuccess {
		return nil, fmt.Errorf("ping to %s failed: ICMP status %d", ipAddr.IP.String(), r.Status)
	}

	return map[string]any{
		"target":      target,
		"resolved_ip": ipAddr.IP.String(),
		"success":     true,
		"rtt_ms":      r.RoundTripTime,
	}, nil
}

// DNSLookup resolves a hostname through the OS resolver (which respects the
// local DNS cache — so scenario B's "flush then re-lookup" actually exercises
// the cache). A resolution failure is returned as an error on purpose: it's
// the deterministic signal both the AI diagnosis and the flush_dns
// verification chain key off of (see backend tool-calls/execution.ts).
func DNSLookup(params map[string]any) (map[string]any, error) {
	host, err := requireStringParam(params, "hostname")
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	addrs, err := net.DefaultResolver.LookupHost(ctx, host)
	if err != nil {
		return nil, fmt.Errorf("resolve %q: %w", host, err)
	}

	return map[string]any{
		"hostname":  host,
		"addresses": addrs,
		"resolved":  true,
	}, nil
}

// FlushDNS clears the local DNS resolver cache via dnsapi.dll's
// DnsFlushResolverCache — the same call `ipconfig /flushdns` makes, without
// spawning ipconfig. Write action (risk "low"); its verification chain is a
// follow-up network.dns_lookup (registry.json).
func FlushDNS(params map[string]any) (map[string]any, error) {
	if err := procDnsFlushResolverCache.Find(); err != nil {
		return nil, fmt.Errorf("DnsFlushResolverCache unavailable on this host: %w", err)
	}
	ret, _, callErr := procDnsFlushResolverCache.Call()
	if ret == 0 {
		return nil, fmt.Errorf("DnsFlushResolverCache failed: %w", callErr)
	}
	return map[string]any{"flushed": true}, nil
}

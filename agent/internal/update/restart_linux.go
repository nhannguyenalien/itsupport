//go:build linux

package update

import (
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// systemd units written by install/install-linux.sh.
var peerUnits = []string{"itsupport-telemetry.service", "itsupport-daemon.service"}

func restartPeers() error {
	for _, unit := range peerUnits {
		if out, err := exec.Command("systemctl", "restart", unit).CombinedOutput(); err != nil {
			return fmt.Errorf("%s: %v: %s", unit, err, strings.TrimSpace(string(out)))
		}
	}
	// Restart=always would mask a crashing binary, so require the units to
	// stay active rather than just checking they were started.
	time.Sleep(10 * time.Second)
	for _, unit := range peerUnits {
		if exec.Command("systemctl", "is-active", "--quiet", unit).Run() != nil {
			return fmt.Errorf("%s is not active", unit)
		}
	}
	return nil
}

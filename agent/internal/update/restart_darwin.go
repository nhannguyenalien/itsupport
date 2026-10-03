//go:build darwin

package update

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// LaunchAgent labels written by install/install-macos.sh (user session).
var peerLabels = []string{"work.schoolsai.itsupport.telemetry", "work.schoolsai.itsupport.daemon"}

func launchctl(args ...string) (string, error) {
	out, err := exec.Command("/bin/launchctl", args...).CombinedOutput()
	return string(out), err
}

func restartPeers() error {
	domain := fmt.Sprintf("gui/%d", os.Getuid())
	for _, label := range peerLabels {
		if out, err := launchctl("kickstart", "-k", domain+"/"+label); err != nil {
			return fmt.Errorf("%s: %v: %s", label, err, strings.TrimSpace(out))
		}
	}
	// KeepAlive restarts a crashing binary forever, so require each job to
	// stay up for a while rather than just checking it was launched.
	time.Sleep(10 * time.Second)
	for _, label := range peerLabels {
		out, err := launchctl("print", domain+"/"+label)
		if err != nil || !strings.Contains(out, "state = running") {
			return fmt.Errorf("%s is not running", label)
		}
	}
	return nil
}

// Package version is the single agent release number. Bump Version before
// running build-release.sh; the release manifest, the heartbeat and the
// in-place updater all read it from here.
package version

import (
	"fmt"
	"os"
)

const Version = "0.3.0"

// PrintIfRequested handles `<binary> -version`. The updater runs every staged
// binary this way before swapping it in, so a binary that cannot even start
// is never installed.
func PrintIfRequested() {
	if len(os.Args) == 2 && os.Args[1] == "-version" {
		fmt.Println(Version)
		os.Exit(0)
	}
}

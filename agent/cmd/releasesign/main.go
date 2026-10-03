// releasesign creates and signs agent release manifests. It is a developer
// tool run only on the release machine and is never shipped to devices.
//
//	go run ./cmd/releasesign keygen                 # once; prints the public key for internal/update
//	go run ./cmd/releasesign sign -dir <platform dir> -platform windows-amd64
//
// The private key lives at $AGENT_RELEASE_KEY or ~/.config/itsupport/agent-release-ed25519.key
// (mode 0600). Back it up offline: losing it means existing agents can no
// longer be updated by click and must be reinstalled once.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"

	"support-agent/agent/internal/update"
	"support-agent/agent/internal/version"
)

func keyPath() string {
	if p := os.Getenv("AGENT_RELEASE_KEY"); p != "" {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		log.Fatal(err)
	}
	return filepath.Join(home, ".config", "itsupport", "agent-release-ed25519.key")
}

func keygen() {
	path := keyPath()
	if _, err := os.Stat(path); err == nil {
		log.Fatalf("%s already exists; refusing to overwrite the release key", path)
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		log.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(base64.StdEncoding.EncodeToString(priv)+"\n"), 0o600); err != nil {
		log.Fatal(err)
	}
	fmt.Println(base64.StdEncoding.EncodeToString(pub))
}

func loadKey() ed25519.PrivateKey {
	data, err := os.ReadFile(keyPath())
	if err != nil {
		log.Fatalf("read release key: %v (run keygen once)", err)
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(data)))
	if err != nil || len(raw) != ed25519.PrivateKeySize {
		log.Fatal("release key file is malformed")
	}
	priv := ed25519.PrivateKey(raw)
	if base64.StdEncoding.EncodeToString(priv.Public().(ed25519.PublicKey)) != update.ReleasePublicKey {
		log.Fatal("release key does not match update.ReleasePublicKey compiled into the agent")
	}
	return priv
}

func hashFile(path string) (string, int64) {
	f, err := os.Open(path)
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		log.Fatal(err)
	}
	return hex.EncodeToString(h.Sum(nil)), n
}

func sign(args []string) {
	fs := flag.NewFlagSet("sign", flag.ExitOnError)
	dir := fs.String("dir", "", "directory holding the platform's binaries")
	platform := fs.String("platform", "", "e.g. windows-amd64, darwin-arm64, linux-amd64")
	fs.Parse(args)
	if *dir == "" || *platform == "" {
		log.Fatal("-dir and -platform are required")
	}
	priv := loadKey()
	ext := ""
	if strings.HasPrefix(*platform, "windows-") {
		ext = ".exe"
	}
	m := update.Manifest{Version: version.Version, Platform: *platform}
	for _, name := range []string{"daemon", "enroll", "executor", "telemetry"} {
		sum, size := hashFile(filepath.Join(*dir, name+ext))
		m.Files = append(m.Files, update.File{Name: name + ext, SHA256: sum, Size: size})
	}
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		log.Fatal(err)
	}
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, data))
	if err := os.WriteFile(filepath.Join(*dir, "manifest.json"), data, 0o644); err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(*dir, "manifest.sig"), []byte(sig+"\n"), 0o644); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("signed %s %s\n", *platform, m.Version)
}

func main() {
	if len(os.Args) < 2 {
		log.Fatal("usage: releasesign keygen | sign -dir DIR -platform PLATFORM")
	}
	switch os.Args[1] {
	case "keygen":
		keygen()
	case "sign":
		sign(os.Args[2:])
	default:
		log.Fatalf("unknown command %q", os.Args[1])
	}
}

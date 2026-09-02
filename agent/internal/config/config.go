// Package config is the on-disk record produced by cmd/enroll and read by
// cmd/daemon and cmd/telemetry, so a device only needs to run the enrollment
// step once instead of having every process configured with AGENT_DEVICE_ID by
// hand. Env vars still override file values (see Load) — useful for the
// dev/test loop, not meant to be the primary path in a real install.
package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type Config struct {
	BackendURL string `json:"backendUrl"`
	DeviceID   string `json:"deviceId"`
	// PrivateKeyPEM/PublicKeyPEM: the enrollment keypair (see docs/v0.1-spec.md
	// enrollment flow). Not yet used for anything past enrollment itself — real
	// mTLS client-cert presentation is unbuilt (see backend TODO on cert
	// issuance), so these sit unused post-enrollment until that lands.
	PrivateKeyPEM string `json:"privateKeyPem"`
	PublicKeyPEM  string `json:"publicKeyPem"`
}

func DefaultPath() string {
	if v := os.Getenv("AGENT_CONFIG_PATH"); v != "" {
		return v
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = "."
	}
	return filepath.Join(dir, "support-agent", "config.json")
}

func Save(path string, cfg Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600) // private key lives in here — not world-readable
}

func Load(path string) (Config, error) {
	var cfg Config
	data, err := os.ReadFile(path)
	if err != nil {
		return cfg, err
	}
	err = json.Unmarshal(data, &cfg)
	return cfg, err
}

// LoadWithEnvOverride reads the config file if present, then lets
// AGENT_BACKEND_URL / AGENT_DEVICE_ID env vars override individual fields —
// so a daemon/telemetry process can still be pointed at something different
// without re-running enrollment.
func LoadWithEnvOverride(path string) Config {
	cfg, _ := Load(path) // missing file is fine — env vars alone can still fully specify things
	if v := os.Getenv("AGENT_BACKEND_URL"); v != "" {
		cfg.BackendURL = v
	}
	if v := os.Getenv("AGENT_DEVICE_ID"); v != "" {
		cfg.DeviceID = v
	}
	return cfg
}

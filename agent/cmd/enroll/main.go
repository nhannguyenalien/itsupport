// One-shot enrollment tool. Implements docs/v0.1-spec.md's enrollment flow:
// generate a keypair locally, send the public key + the one-time token an
// admin issued, get back a device_id (and eventually a real device cert — see
// known-gaps note below). Run once per device, before starting daemon/
// telemetry/executor, which read the resulting config file.
package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"

	"support-agent/agent/internal/config"
)

type registerRequest struct {
	Token        string `json:"token"`
	Hostname     string `json:"hostname"`
	PublicKey    string `json:"publicKey"`
	OSVersion    string `json:"osVersion,omitempty"`
	AgentVersion string `json:"agentVersion,omitempty"`
}

type registerResponse struct {
	DeviceID   string `json:"deviceId"`
	CertSerial string `json:"certSerial"`
	Error      string `json:"error"`
}

func main() {
	backendURL := flag.String("backend", os.Getenv("AGENT_BACKEND_URL"), "backend base URL, e.g. https://support.example.com")
	token := flag.String("token", "", "one-time enrollment token from an admin (10 minute TTL, see docs/v0.1-spec.md)")
	configPath := flag.String("config", config.DefaultPath(), "where to write the resulting device config")
	flag.Parse()

	if *backendURL == "" {
		log.Fatal("-backend (or AGENT_BACKEND_URL) is required")
	}
	if *token == "" {
		log.Fatal("-token is required — get one from the dashboard/admin API (POST /enrollment-tokens)")
	}

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		log.Fatalf("generate keypair: %v", err)
	}

	pubPEM, err := encodePublicKeyPEM(pub)
	if err != nil {
		log.Fatalf("encode public key: %v", err)
	}
	privPEM, err := encodePrivateKeyPEM(priv)
	if err != nil {
		log.Fatalf("encode private key: %v", err)
	}

	hostname, _ := os.Hostname()
	if hostname == "" {
		hostname = "unknown-host"
	}

	reqBody, err := json.Marshal(registerRequest{
		Token:        *token,
		Hostname:     hostname,
		PublicKey:    pubPEM,
		AgentVersion: "0.1.0-dev",
	})
	if err != nil {
		log.Fatalf("marshal request: %v", err)
	}

	resp, err := http.Post(*backendURL+"/enrollment/register", "application/json", bytes.NewReader(reqBody))
	if err != nil {
		log.Fatalf("enrollment request failed: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	var result registerResponse
	if err := json.Unmarshal(body, &result); err != nil {
		log.Fatalf("malformed backend response: %s", body)
	}
	if resp.StatusCode != http.StatusCreated {
		log.Fatalf("enrollment rejected (status %d): %s", resp.StatusCode, result.Error)
	}

	cfg := config.Config{
		BackendURL:    *backendURL,
		DeviceID:      result.DeviceID,
		PrivateKeyPEM: privPEM,
		PublicKeyPEM:  pubPEM,
	}
	if err := config.Save(*configPath, cfg); err != nil {
		log.Fatalf("failed to save config to %s: %v", *configPath, err)
	}

	fmt.Printf("Enrolled successfully.\n  device_id:  %s\n  cert_serial: %s (placeholder — see known gaps, real mTLS cert issuance isn't built yet)\n  config:     %s\n",
		result.DeviceID, result.CertSerial, *configPath)
}

func encodePublicKeyPEM(pub ed25519.PublicKey) (string, error) {
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return "", err
	}
	block := &pem.Block{Type: "PUBLIC KEY", Bytes: der}
	return string(pem.EncodeToMemory(block)), nil
}

func encodePrivateKeyPEM(priv ed25519.PrivateKey) (string, error) {
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return "", err
	}
	block := &pem.Block{Type: "PRIVATE KEY", Bytes: der}
	return string(pem.EncodeToMemory(block)), nil
}

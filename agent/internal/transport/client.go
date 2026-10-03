// Package transport builds the mutually authenticated TLS client used for all
// post-enrollment agent traffic.
package transport

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"support-agent/agent/internal/version"
	"time"
)

type Client struct {
	BaseURL    string
	DeviceID   string
	AgentToken string
	http       *http.Client
}

func NewClient(baseURL, deviceID, agentToken, certificatePEM, privateKeyPEM, caCertificatePEM string) (*Client, error) {
	if agentToken != "" {
		return &Client{
			BaseURL: baseURL, DeviceID: deviceID, AgentToken: agentToken,
			http: &http.Client{Timeout: 15 * time.Second},
		}, nil
	}
	certificate, err := tls.X509KeyPair([]byte(certificatePEM), []byte(privateKeyPEM))
	if err != nil {
		return nil, fmt.Errorf("load agent client certificate: %w", err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM([]byte(caCertificatePEM)) {
		return nil, fmt.Errorf("load agent CA certificate")
	}
	return &Client{
		BaseURL:  baseURL,
		DeviceID: deviceID,
		http: &http.Client{
			Timeout: 15 * time.Second,
			Transport: &http.Transport{TLSClientConfig: &tls.Config{
				MinVersion:   tls.VersionTLS13,
				Certificates: []tls.Certificate{certificate},
				RootCAs:      roots,
			}},
		},
	}, nil
}

func (c *Client) do(req *http.Request) (*http.Response, error) {
	if c.AgentToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.AgentToken)
	}
	return c.http.Do(req)
}

type PendingCall struct {
	ID     string         `json:"id"`
	Tool   string         `json:"tool"`
	Params map[string]any `json:"params"`
	Risk   string         `json:"risk"`
}

func (c *Client) Heartbeat() error {
	// Reporting the running version lets the dashboard offer one-click updates.
	body, _ := json.Marshal(map[string]string{"agentVersion": version.Version})
	req, err := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/devices/%s/heartbeat", c.BaseURL, c.DeviceID), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("heartbeat: status %d: %s", resp.StatusCode, body)
	}
	return nil
}

func (c *Client) PollPending() ([]PendingCall, error) {
	req, err := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/devices/%s/tool-calls/pending", c.BaseURL, c.DeviceID), nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("poll pending: status %d: %s", resp.StatusCode, body)
	}
	var calls []PendingCall
	if err := json.NewDecoder(resp.Body).Decode(&calls); err != nil {
		return nil, err
	}
	return calls, nil
}

type ResultPayload struct {
	Result       string         `json:"result"`
	ResultData   map[string]any `json:"resultData,omitempty"`
	ErrorMessage string         `json:"errorMessage,omitempty"`
}

func (c *Client) ReportResult(toolCallID string, payload ResultPayload) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/tool-calls/%s/result", c.BaseURL, toolCallID), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("report result: status %d: %s", resp.StatusCode, respBody)
	}
	return nil
}

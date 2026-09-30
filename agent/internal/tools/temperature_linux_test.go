//go:build linux

package tools

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTemperatureCPUAndDiskSensors(t *testing.T) {
	root := t.TempDir()
	for path, value := range map[string]string{"hwmon0/name": "coretemp", "hwmon0/temp1_label": "Package id 0", "hwmon0/temp1_input": "61000", "hwmon0/temp2_input": "invalid", "hwmon1/name": "nvme", "hwmon1/temp1_input": "38850"} {
		dest := filepath.Join(root, "class/hwmon", path)
		os.MkdirAll(filepath.Dir(dest), 0700)
		os.WriteFile(dest, []byte(value), 0600)
	}
	result, err := readTemperatures(root)
	if err != nil {
		t.Fatal(err)
	}
	sensors := result["sensors"].([]map[string]any)
	if len(sensors) != 2 || sensors[0]["temperature_c"] != float64(61) || sensors[0]["is_cpu"] != true || sensors[1]["is_cpu"] != false {
		t.Fatal(sensors)
	}
}
func TestTemperatureUnavailable(t *testing.T) {
	if _, err := readTemperatures(t.TempDir()); err == nil {
		t.Fatal("missing sensors should report error")
	}
}

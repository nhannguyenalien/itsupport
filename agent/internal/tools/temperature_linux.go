//go:build linux

package tools

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func sensorText(path string) string { b, _ := os.ReadFile(path); return strings.TrimSpace(string(b)) }
func readTemperatures(root string) (map[string]any, error) {
	sensors := []map[string]any{}
	paths, _ := filepath.Glob(filepath.Join(root, "class/hwmon/hwmon*/temp*_input"))
	for _, path := range paths {
		n, err := strconv.ParseFloat(sensorText(path), 64)
		if err != nil || math.IsNaN(n) || math.IsInf(n, 0) || n < -100000 || n > 250000 {
			continue
		}
		chip := sensorText(filepath.Join(filepath.Dir(path), "name"))
		label := sensorText(strings.TrimSuffix(path, "_input") + "_label")
		if label == "" {
			label = strings.TrimSuffix(filepath.Base(path), "_input")
		}
		cpu := chip == "coretemp" || chip == "k10temp" || chip == "zenpower" || chip == "cpu_thermal"
		sensors = append(sensors, map[string]any{"chip": chip, "label": label, "temperature_c": n / 1000, "is_cpu": cpu})
	}
	if len(sensors) == 0 {
		paths, _ = filepath.Glob(filepath.Join(root, "class/thermal/thermal_zone*/temp"))
		for _, path := range paths {
			n, err := strconv.ParseFloat(sensorText(path), 64)
			if err != nil || math.IsNaN(n) || math.IsInf(n, 0) || n < -100000 || n > 250000 {
				continue
			}
			label := sensorText(filepath.Join(filepath.Dir(path), "type"))
			sensors = append(sensors, map[string]any{"chip": label, "label": label, "temperature_c": n / 1000, "is_cpu": strings.Contains(strings.ToLower(label), "cpu")})
		}
	}
	if len(sensors) == 0 {
		return nil, fmt.Errorf("no readable hardware temperature sensors; package installation alone may not enable unsupported sensors")
	}
	return map[string]any{"sensors": sensors, "unit": "celsius", "source": "linux_sysfs"}, nil
}
func SystemTemperature(_ map[string]any) (map[string]any, error) { return readTemperatures("/sys") }

#!/bin/zsh
set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

AGENT_DIR="${0:A:h}"
OUTPUT_DIR="$AGENT_DIR/../frontend/public/downloads/agent"
mkdir -p "$OUTPUT_DIR/darwin-arm64" "$OUTPUT_DIR/darwin-amd64" "$OUTPUT_DIR/windows-amd64"

for arch in arm64 amd64; do
  for command in enroll daemon telemetry executor; do
    (cd "$AGENT_DIR" && CGO_ENABLED=1 GOOS=darwin GOARCH="$arch" go build -trimpath -ldflags="-s -w" -o "$OUTPUT_DIR/darwin-$arch/$command" "./cmd/$command")
  done
done

for command in enroll daemon telemetry executor; do
  (cd "$AGENT_DIR" && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o "$OUTPUT_DIR/windows-amd64/$command.exe" "./cmd/$command")
done

for arch in amd64 arm64; do
  mkdir -p "$OUTPUT_DIR/linux-$arch"
  for command in enroll daemon telemetry executor; do
    (cd "$AGENT_DIR" && CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -trimpath -ldflags="-s -w" -o "$OUTPUT_DIR/linux-$arch/$command" "./cmd/$command")
  done
done
# Sign every platform's manifest with the offline release key (see
# cmd/releasesign). Agents refuse click-to-update without a valid signature.
for platform in darwin-arm64 darwin-amd64 windows-amd64 linux-amd64 linux-arm64; do
  (cd "$AGENT_DIR" && go run ./cmd/releasesign sign -dir "$OUTPUT_DIR/$platform" -platform "$platform")
done

cp "$AGENT_DIR/install/install-linux.sh" "$OUTPUT_DIR/install-linux-service"
cp "$AGENT_DIR/install/install-macos.sh" "$OUTPUT_DIR/install-macos-service"
cp "$AGENT_DIR/install/install.ps1" "$OUTPUT_DIR/install-windows-service"
chmod 755 "$OUTPUT_DIR/install-macos" "$OUTPUT_DIR/install-macos-service" "$OUTPUT_DIR/darwin-"*/{enroll,daemon,telemetry,executor}
echo "Agent release written to $OUTPUT_DIR"

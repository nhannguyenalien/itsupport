#!/bin/zsh
set -euo pipefail

BACKEND_URL="${AGENT_BACKEND_URL:-}"
ENROLLMENT_TOKEN=""
FORCE_REENROLL=0

usage() {
  echo "Usage: $0 --backend https://host/api --token ONE_TIME_TOKEN [--force-re-enroll]"
}

while (( $# > 0 )); do
  case "$1" in
    --backend) BACKEND_URL="$2"; shift 2 ;;
    --token) ENROLLMENT_TOKEN="$2"; shift 2 ;;
    --force-re-enroll) FORCE_REENROLL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

SCRIPT_DIR="${0:A:h}"
INSTALL_DIR="$HOME/Library/Application Support/SupportAgent"
CONFIG_PATH="$HOME/Library/Application Support/support-agent/config.json"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/SupportAgent"

for binary in enroll daemon telemetry executor; do
  [[ -x "$SCRIPT_DIR/$binary" ]] || { echo "Missing executable: $SCRIPT_DIR/$binary" >&2; exit 1; }
done

mkdir -p "$INSTALL_DIR" "$LAUNCH_DIR" "$LOG_DIR"
chmod 700 "$INSTALL_DIR"
for binary in enroll daemon telemetry executor; do
  cp "$SCRIPT_DIR/$binary" "$INSTALL_DIR/$binary"
  chmod 700 "$INSTALL_DIR/$binary"
done

needs_enrollment=$FORCE_REENROLL
if [[ ! -f "$CONFIG_PATH" ]]; then
  needs_enrollment=1
elif ! /usr/bin/python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get("agentToken") else 1)' "$CONFIG_PATH"; then
  cp "$CONFIG_PATH" "$CONFIG_PATH.pre-token.bak"
  chmod 600 "$CONFIG_PATH.pre-token.bak"
  echo "Legacy config backed up to $CONFIG_PATH.pre-token.bak"
  needs_enrollment=1
fi

if (( needs_enrollment )); then
  [[ -n "$BACKEND_URL" && -n "$ENROLLMENT_TOKEN" ]] || { echo "Enrollment required: pass --backend and --token" >&2; exit 1; }
  if [[ -f "$CONFIG_PATH" ]]; then
    cp "$CONFIG_PATH" "$CONFIG_PATH.before-reenroll.bak"
    chmod 600 "$CONFIG_PATH.before-reenroll.bak"
  fi
  "$INSTALL_DIR/enroll" -backend "$BACKEND_URL" -token "$ENROLLMENT_TOKEN" -config "$CONFIG_PATH"
else
  echo "Giữ đăng ký máy hiện có. Nếu máy không xuất hiện trên web, chọn Đăng ký lại trong trang Thiết bị để liên kết đúng workspace."
fi

IPC_SECRET_FILE="$INSTALL_DIR/ipc-secret"
if [[ ! -f "$IPC_SECRET_FILE" ]]; then
  /usr/bin/openssl rand -base64 32 > "$IPC_SECRET_FILE"
  chmod 600 "$IPC_SECRET_FILE"
fi
IPC_SECRET="$(<"$IPC_SECRET_FILE")"

write_plist() {
  local label="$1" binary="$2"
  local plist="$LAUNCH_DIR/$label.plist"
  /bin/cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>$INSTALL_DIR/$binary</string></array>
  <key>EnvironmentVariables</key><dict><key>AGENT_IPC_SECRET</key><string>$IPC_SECRET</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/$binary.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/$binary.error.log</string>
</dict></plist>
PLIST
  chmod 600 "$plist"
  /bin/launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  /bin/launchctl bootstrap "gui/$(id -u)" "$plist"
}

write_plist work.schoolsai.itsupport.executor executor
write_plist work.schoolsai.itsupport.daemon daemon
write_plist work.schoolsai.itsupport.telemetry telemetry

echo "Installed. Check with: launchctl print gui/$(id -u)/work.schoolsai.itsupport.telemetry"
echo "Logs: $HOME/Library/Application Support/support-agent"
echo "Đang xác minh kết nối…"
/usr/bin/python3 - "$CONFIG_PATH" <<'PYTHON'
import json, subprocess, sys
with open(sys.argv[1]) as f:
    config = json.load(f)
result = subprocess.run([
    '/usr/bin/curl', '-sS', '--max-time', '20', '--fail-with-body',
    '-H', 'Authorization: Bearer ' + config['agentToken'],
    '-H', 'Content-Type: application/json', '-d', '{}',
    config['backendUrl'].rstrip('/') + '/devices/' + config['deviceId'] + '/heartbeat',
], capture_output=True, text=True)
if result.returncode:
    print('Đã cài nhưng chưa kết nối được. Kiểm tra mạng và nhật ký agent rồi thử lại.', file=sys.stderr)
    sys.exit(1)
print('Đã xác minh máy gửi heartbeat thành công.')
PYTHON

# Install the official remote-support package in the same customer setup flow.
echo "Đang cài Mesh Agent để kỹ thuật viên hỗ trợ từ xa. Mỗi phiên cần khách chấp thuận."
echo "macOS có thể yêu cầu mật khẩu quản trị để cài dịch vụ."
REMOTE_DIR="$(mktemp -d)"
trap 'rm -rf "$REMOTE_DIR"' EXIT
/usr/bin/python3 - "$CONFIG_PATH" "$REMOTE_DIR" <<'PYTHON'
import json, pathlib, subprocess, sys, urllib.parse
config = json.load(open(sys.argv[1]))
endpoint = config['backendUrl'].rstrip('/') + '/devices/' + config['deviceId'] + '/remote-install'
def download(url, timeout, headers=()):
    result = subprocess.run(['/usr/bin/curl', '--fail', '--silent', '--show-error', '--proto', '=https', '--max-time', str(timeout), *headers, url], capture_output=True)
    if result.returncode:
        raise RuntimeError('HTTPS download failed: ' + result.stderr.decode(errors='replace').strip())
    return result.stdout
try:
    remote = json.loads(download(endpoint, 30, ['-H', 'Authorization: Bearer ' + config['agentToken']]))
    url = urllib.parse.urlparse(remote['url'])
    if url.scheme != 'https' or url.netloc != urllib.parse.urlparse(remote['server']).netloc:
        raise ValueError('Invalid remote installer URL')
    existing = pathlib.Path('/usr/local/mesh_services/meshagent/meshagent/meshagent.msh')
    if pathlib.Path('/Library/LaunchDaemons/meshagent.plist').exists():
        settings = existing.read_text()
        import base64
        group_hex = base64.b64decode(remote['group'].replace('@', '+').replace('$', '/')).hex().upper()
        if ('MeshID=0x' + group_hex) not in settings or ('MeshServer=wss://' + url.hostname + ':443/') not in settings:
            raise ValueError('An existing Mesh Agent belongs to another server or group; contact your administrator')
        pathlib.Path(sys.argv[2], 'already-installed').touch()
    else:
        pathlib.Path(sys.argv[2], 'MeshAgent.zip').write_bytes(download(remote['url'], 120))
except Exception as error:
    print('Support Agent đã cài. Mesh Agent chưa sẵn sàng: ' + str(error), file=sys.stderr)
    sys.exit(1)
PYTHON
if [[ ! -f "$REMOTE_DIR/already-installed" ]]; then
  /usr/bin/ditto -x -k "$REMOTE_DIR/MeshAgent.zip" "$REMOTE_DIR/package"
  /usr/bin/sudo /usr/sbin/installer -pkg "$REMOTE_DIR/package/MeshAgent.pkg" -target /
fi
/usr/bin/sudo /bin/launchctl print system/meshagent >/dev/null
echo "Mesh Agent đã cài. Vào System Settings > Privacy & Security, cấp Screen Recording và Accessibility cho Mesh Agent."
echo "Quản trị viên liên kết máy trong Dashboard > Thiết bị > Hỗ trợ từ xa."

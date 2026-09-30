#!/usr/bin/env bash
# Linux x64/ARM64, systemd. Device credentials and IPC secret are root-only.
set -euo pipefail
umask 077
BACKEND_URL=''
TOKEN=''
FORCE_REENROLL=0
while (( $# )); do
  case "$1" in
    --backend) BACKEND_URL="$2"; shift 2;;
    --token) TOKEN="$2"; shift 2;;
    --force-re-enroll) FORCE_REENROLL=1; shift;;
    *) echo "Unknown option: $1" >&2; exit 2;;
  esac
done
[[ $(uname -s) == Linux && $EUID == 0 && -d /run/systemd/system ]] || { echo 'Run as root on Linux with systemd.' >&2; exit 1; }
for tool in python3 curl systemctl; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }; done
case $(uname -m) in x86_64) ARCH=amd64;; aarch64|arm64) ARCH=arm64;; *) exit 1;; esac
SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
INSTALL_DIR=/opt/itsupport-agent
CONFIG_PATH=/etc/itsupport-agent/config.json
for binary in enroll daemon telemetry executor; do
  [[ -x "$SCRIPT_DIR/$binary" ]] || { echo "Missing $binary" >&2; exit 1; }
done
install -d -m 700 "$INSTALL_DIR" /etc/itsupport-agent
if [[ ! -f "$CONFIG_PATH" ]] || (( FORCE_REENROLL )); then
  [[ "$BACKEND_URL" == https://* && -n "$TOKEN" ]] || { echo 'HTTPS backend and enrollment token required.' >&2; exit 1; }
  [[ ! -f "$CONFIG_PATH" ]] || cp -p "$CONFIG_PATH" "$CONFIG_PATH.before-reenroll.bak"
  "$SCRIPT_DIR/enroll" -backend "$BACKEND_URL" -token "$TOKEN" -config "$CONFIG_PATH"
fi
# Stop before replacing binaries, so reconnect also works on a running Linux host.
for binary in daemon telemetry executor; do systemctl stop "itsupport-$binary.service" 2>/dev/null || true; done
for binary in enroll daemon telemetry executor; do install -m 700 "$SCRIPT_DIR/$binary" "$INSTALL_DIR/$binary"; done
if [[ ! -f /etc/itsupport-agent/service.env ]]; then
  python3 - <<'PY'
import secrets
with open('/etc/itsupport-agent/service.env', 'w') as f:
    f.write('AGENT_CONFIG_PATH=/etc/itsupport-agent/config.json\nAGENT_IPC_SECRET=' + secrets.token_hex(32) + '\n')
PY
fi
chmod 600 "$CONFIG_PATH" /etc/itsupport-agent/service.env
for binary in executor daemon telemetry; do
  cat > "/etc/systemd/system/itsupport-$binary.service" <<UNIT
[Unit]
Description=ITSupport $binary
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=root
EnvironmentFile=/etc/itsupport-agent/service.env
ExecStart=$INSTALL_DIR/$binary
Restart=always
RestartSec=5
UMask=0077
[Install]
WantedBy=multi-user.target
UNIT
  chmod 644 "/etc/systemd/system/itsupport-$binary.service"
done
systemctl daemon-reload
systemctl enable --now itsupport-executor.service itsupport-daemon.service itsupport-telemetry.service
systemctl is-active --quiet itsupport-executor.service itsupport-daemon.service itsupport-telemetry.service
python3 - "$CONFIG_PATH" "$ARCH" <<'PY'
import base64, json, pathlib, re, subprocess, sys, tempfile, time, urllib.parse, urllib.request
config = json.loads(pathlib.Path(sys.argv[1]).read_text())
base = config['backendUrl'].rstrip('/') + '/devices/' + config['deviceId']
def request(url, data=None, authenticated=False):
    if urllib.parse.urlparse(url).scheme != 'https':
        raise ValueError('HTTPS required')
    headers = {'Content-Type': 'application/json', 'User-Agent': 'ITSupport-Agent/1.0'}
    if authenticated:
        headers['Authorization'] = 'Bearer ' + config['agentToken']
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None, headers=headers)
    with urllib.request.urlopen(req, timeout=120) as response:
        return response.read()
request(base + '/heartbeat', {}, True)
print('Support Agent connected. Installing remote support…', flush=True)
remote = json.loads(request(base + '/remote-install?arch=' + sys.argv[2], authenticated=True))
server = urllib.parse.urlparse(remote['server'])
for key in ['url', 'settingsUrl']:
    parsed = urllib.parse.urlparse(remote[key])
    if parsed.scheme != 'https' or parsed.netloc != server.netloc:
        raise ValueError('Invalid remote download destination')
# Upstream Linux Mesh Agent installs its service in /usr/local/mesh_services/meshagent.
meshdir = pathlib.Path('/usr/local/mesh_services/meshagent')
binary = meshdir / 'meshagent'
settings = meshdir / 'meshagent.msh'
if binary.exists() or settings.exists():
    text = settings.read_text()
    group = base64.b64decode(remote['group'].replace('@', '+').replace('$', '/')).hex().upper()
    values = dict(line.split('=', 1) for line in text.splitlines() if '=' in line)
    expected = 'wss://' + server.netloc + ('' if server.port else ':443') + '/agent.ashx'
    if values.get('MeshID', '').upper() != '0X' + group or values.get('MeshServer') != expected:
        raise ValueError('Existing Mesh Agent belongs to another server/group; contact your administrator')
else:
    with tempfile.TemporaryDirectory() as tmp:
        downloaded = pathlib.Path(tmp, 'meshagent')
        downloaded.write_bytes(request(remote['url']))
        downloaded.chmod(0o700)
        pathlib.Path(tmp, 'meshagent.msh').write_bytes(request(remote['settingsUrl']))
        subprocess.run([str(downloaded), '-fullinstall', '--copy-msh=1'], cwd=tmp, check=True, timeout=120)
subprocess.run(['systemctl', 'is-active', '--quiet', 'meshagent.service'], check=True)
node = subprocess.check_output([str(binary), '-nodeid'], cwd=meshdir, timeout=30, text=True).strip()
if not re.fullmatch(r'(?:[a-fA-F0-9]{96}|[A-Za-z0-9@$]{64})', node):
    raise ValueError('Cannot identify remote agent')
for attempt in range(10):
    try:
        request(base + '/remote-register', {'nodeId': node}, True)
        break
    except Exception:
        if attempt == 9:
            raise RuntimeError('Support Agent connected, but remote registration failed. Run the installer again to retry.') from None
        time.sleep(3)
print('Connected. Remote support can now be enabled or disabled in chat.')
PY
echo 'Done. Logs: sudo journalctl -u itsupport-daemon -u itsupport-telemetry -u itsupport-executor'

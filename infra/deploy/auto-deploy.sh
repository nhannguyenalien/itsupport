#!/usr/bin/env bash
set -Eeuo pipefail
cd /home/mac/apps/itsupport
state=/home/mac/.local/state/itsupport-deploy
mkdir -p "$state"
exec 9>"$state/lock"
flock -n 9 || exit 0
[[ -z $(git status --porcelain --untracked-files=no) ]] || { echo 'Tracked files changed locally; refusing deploy'; exit 1; }
git fetch origin main
target=$(git rev-parse origin/main)
[[ ! -f "$state/deployed" || $(cat "$state/deployed") != "$target" ]] || exit 0
# Only deploy a commit whose CI workflow completed successfully.
python3 - "$target" <<'PY'
import json, sys, urllib.request
url = 'https://api.github.com/repos/nhannguyenalien/itsupport/actions/workflows/ci.yml/runs?head_sha=' + sys.argv[1] + '&event=push&per_page=1'
with urllib.request.urlopen(urllib.request.Request(url, headers={'Accept': 'application/vnd.github+json'}), timeout=30) as response:
    runs = json.load(response)['workflow_runs']
if not runs or runs[0]['status'] != 'completed' or runs[0]['conclusion'] != 'success':
    sys.exit('Waiting for successful CI for ' + sys.argv[1])
PY
previous=$(git rev-parse HEAD)
compose=(docker compose -f infra/docker-compose.yml -f infra/docker-compose.neon.yml --env-file infra/.env)
for service in frontend backend; do
    docker tag "support-agent-platform-$service:latest" "support-agent-platform-$service:rollback"
done
rollback() {
    trap - ERR
    echo "Deployment failed; restoring $previous and previous images"
    git reset --hard "$previous"
    for service in frontend backend; do
        docker tag "support-agent-platform-$service:rollback" "support-agent-platform-$service:latest"
    done
    "${compose[@]}" up -d --no-build --no-deps --force-recreate backend frontend
    exit 1
}
trap rollback ERR
git merge --ff-only "$target"
"${compose[@]}" config --quiet
"${compose[@]}" build backend frontend
"${compose[@]}" up -d --no-build --no-deps --wait --wait-timeout 180 backend frontend
for attempt in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:18080/api/health >/dev/null && curl -fsS http://127.0.0.1:18080/login >/dev/null; then
        printf '%s\n' "$target" > "$state/deployed"
        echo "Deployed $target successfully"
        exit 0
    fi
    sleep 2
done
false

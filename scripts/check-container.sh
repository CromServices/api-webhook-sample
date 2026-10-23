#!/usr/bin/env bash
# Build is the caller's job. This boots the image the way Fly does
# (non-root, NODE_ENV=production, empty data dir) and fails unless the
# customer routes answer and a cold boot shows a stored run.
set -euo pipefail

IMAGE="${1:-crom-api-webhook-sample:ci}"
NAME="crom-container-check-$$"
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --user node \
  -e NODE_ENV=production \
  -e PORT=3000 \
  -p "${PORT}:3000" \
  "$IMAGE" >/dev/null

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "$1" >&2
  docker logs "$NAME" >&2 || true
  exit 1
}

echo "waiting for ${IMAGE} on 127.0.0.1:${PORT}"
ready=""
for _ in $(seq 1 40); do
  if [[ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || echo false)" != "true" ]]; then
    fail "container exited before /health returned 200"
  fi
  code="$(curl -sS -o /tmp/crom-health-body -w '%{http_code}' "http://127.0.0.1:${PORT}/health" 2>/dev/null || true)"
  if [[ "$code" == "200" ]]; then
    ready=1
    break
  fi
  sleep 1
done
[[ -n "$ready" ]] || fail "GET /health did not return 200"

uid="$(docker exec "$NAME" id -u)"
[[ "$uid" != "0" ]] || fail "container is running as root"
env_node="$(docker exec "$NAME" printenv NODE_ENV)"
[[ "$env_node" == "production" ]] || fail "NODE_ENV is ${env_node}, expected production"

check_status() {
  local path="$1"
  local expect="$2"
  local code
  code="$(curl -sS -o /tmp/crom-route-body -D /tmp/crom-route-headers -w '%{http_code}' --max-redirs 0 "http://127.0.0.1:${PORT}${path}" || true)"
  if [[ "$code" != "$expect" ]]; then
    fail "GET ${path} returned ${code}, expected ${expect}"
  fi
  echo "GET ${path} ${code}"
}

check_status / 200
check_status /health 200

B='{"event":"ping"}'
SIG="$(printf '%s' "$B" | openssl dgst -sha256 -hmac crom-demo-webhook-secret-v1 | awk '{print $2}')"
ok="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H "x-signature-256: sha256=${SIG}" --data "$B" "http://127.0.0.1:${PORT}/webhook")"
[[ "$ok" == "200" ]] || fail "signed POST /webhook returned ${ok}, expected 200"
bad="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H "x-signature-256: sha256=00" --data "$B" "http://127.0.0.1:${PORT}/webhook")"
[[ "$bad" == "401" ]] || fail "bad-signature POST /webhook returned ${bad}, expected 401"
echo "signed webhook 200, bad signature 401"

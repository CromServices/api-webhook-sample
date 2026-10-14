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
check_status /sheet 200
check_status /alerts 200
check_status /happened 200
check_status /before-after 200
check_status "/before-after?view=triage" 200
check_status /shop 200
check_status /stock 200
check_status /history 200
check_status /shop-before-after 200
check_status "/shop-before-after?view=triage" 200
check_status /shop-and-stock 200
check_status /demo 301
check_status "/demo?view=triage" 301

home="$(curl -fsS "http://127.0.0.1:${PORT}/")"
before="$(curl -fsS "http://127.0.0.1:${PORT}/before-after")"
shop="$(curl -fsS "http://127.0.0.1:${PORT}/shop-before-after")"

if grep -q "New leads: 0. In your sheet: 0" <<<"$home"; then
  fail "GET / is an empty run after a cold boot"
fi
if ! grep -q "New leads: 3. In your sheet: 3" <<<"$home"; then
  fail "GET / does not show the stored lead run"
fi
if ! grep -q "Jordan Hale" <<<"$home"; then
  fail "GET / does not show a stored lead"
fi
if grep -q "New leads: 0. In your sheet: 0" <<<"$before"; then
  fail "GET /before-after is an empty run after a cold boot"
fi
if ! grep -q "New leads: 3. In your sheet: 2 (1 copied twice, 1 missing)" <<<"$before"; then
  fail "GET /before-after does not show the stored before run"
fi
if ! grep -q "New leads: 3. In your sheet: 3" <<<"$before"; then
  fail "GET /before-after does not show the stored after run"
fi
if ! grep -q "Made 3. Arrived 2." <<<"$shop"; then
  fail "GET /shop-before-after does not show the stored shop before run"
fi
if ! grep -q "Made 3. Arrived 3." <<<"$shop"; then
  fail "GET /shop-before-after does not show the stored shop after run"
fi

echo "cold boot shows stored lead and shop runs"

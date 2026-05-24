#!/bin/sh
set -eu

run_uid="${OPEN_DESIGN_UID:-1000}"
run_gid="${OPEN_DESIGN_GID:-1000}"

mkdir -p /home/open-design/.codex
chown -R "$run_uid:$run_gid" /home/open-design/.codex

if [ "${1:-}" != "open-design" ]; then
  exec su-exec "$run_uid:$run_gid" "$@"
fi

mkdir -p /app/.od/projects
chown -R "$run_uid:$run_gid" /app/.od

internal_port="${OD_INTERNAL_PORT:-7457}"
external_port="${OD_PORT:-7456}"

su-exec "$run_uid:$run_gid" node apps/daemon/dist/cli.js --no-open --host 127.0.0.1 --port "$internal_port" &
daemon_pid="$!"

su-exec "$run_uid:$run_gid" socat "TCP-LISTEN:${external_port},fork,reuseaddr,bind=0.0.0.0" "TCP:127.0.0.1:${internal_port}" &
proxy_pid="$!"

shutdown() {
  kill "$daemon_pid" "$proxy_pid" 2>/dev/null || true
}

trap shutdown INT TERM

while kill -0 "$daemon_pid" 2>/dev/null && kill -0 "$proxy_pid" 2>/dev/null; do
  sleep 1
done

shutdown
wait "$daemon_pid" 2>/dev/null || true
wait "$proxy_pid" 2>/dev/null || true
exit 1

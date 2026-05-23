#!/usr/bin/env bash
set -euo pipefail

HOST_IP="${HOST_IP:-192.168.1.88}"
LIVEKIT_LB_IP="${LIVEKIT_LB_IP:-192.168.122.224}"
UDP_START="${UDP_START:-50100}"
UDP_END="${UDP_END:-50120}"
LOG_FILE="${LOG_FILE:-/var/log/phone-levelg-livekit-forward.log}"

socat -ly -lf "$LOG_FILE" TCP-LISTEN:7880,bind="$HOST_IP",reuseaddr,fork TCP:"$LIVEKIT_LB_IP":7880 &
socat -ly -lf "$LOG_FILE" TCP-LISTEN:7881,bind="$HOST_IP",reuseaddr,fork TCP:"$LIVEKIT_LB_IP":7881 &

for port in $(seq "$UDP_START" "$UDP_END"); do
  socat -ly -lf "$LOG_FILE" UDP4-LISTEN:"$port",bind="$HOST_IP",reuseaddr,fork UDP4:"$LIVEKIT_LB_IP":"$port" &
done

wait

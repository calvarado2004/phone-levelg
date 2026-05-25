#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$ROOT_DIR/apps/mobile/android"
APK_SOURCE="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"
SERVE_DIR="${SERVE_DIR:-$ROOT_DIR/dist/android-release}"
APK_NAME="${APK_NAME:-phone-levelg-release.apk}"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8099}"
BACKGROUND="${BACKGROUND:-0}"
EXPO_PUBLIC_API_URL="${EXPO_PUBLIC_API_URL:-https://phone-levelg-server-phone-levelg.apps.ocp-think.levelg.io}"
EXPO_PUBLIC_LIVEKIT_URL="${EXPO_PUBLIC_LIVEKIT_URL:-ws://192.168.1.88:7880}"

cd "$ANDROID_DIR"
EXPO_PUBLIC_API_URL="$EXPO_PUBLIC_API_URL" \
EXPO_PUBLIC_LIVEKIT_URL="$EXPO_PUBLIC_LIVEKIT_URL" \
./gradlew assembleRelease

mkdir -p "$SERVE_DIR"
cp "$APK_SOURCE" "$SERVE_DIR/$APK_NAME"

cat > "$SERVE_DIR/index.html" <<HTML
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Phone LevelG Android Release</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem; line-height: 1.4; }
      code { background: #f4f4f5; padding: 0.125rem 0.25rem; border-radius: 0.25rem; }
      a { font-size: 1.25rem; }
    </style>
  </head>
  <body>
    <h1>Phone LevelG Android Release</h1>
    <p><a href="./$APK_NAME">Download $APK_NAME</a></p>
    <p>API: <code>$EXPO_PUBLIC_API_URL</code></p>
    <p>LiveKit: <code>$EXPO_PUBLIC_LIVEKIT_URL</code></p>
  </body>
</html>
HTML

LOCAL_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname)"

echo "Serving $SERVE_DIR"
echo "APK: $SERVE_DIR/$APK_NAME"
echo "Local URL: http://127.0.0.1:$PORT/$APK_NAME"
echo "LAN URL: http://$LOCAL_IP:$PORT/$APK_NAME"
if [[ "$BACKGROUND" == "1" ]]; then
  LOG_FILE="$SERVE_DIR/server.log"
  PID_FILE="$SERVE_DIR/server.pid"
  python3 - "$HOST" "$PORT" "$SERVE_DIR" "$LOG_FILE" "$PID_FILE" <<'PY'
import functools
import http.server
import os
import socketserver
import sys

host, port_text, serve_dir, log_file, pid_file = sys.argv[1:]
port = int(port_text)
ready_read, ready_write = os.pipe()
pid = os.fork()

if pid:
    os.close(ready_write)
    message = os.read(ready_read, 4096).decode("utf-8", "replace")
    os.close(ready_read)
    os.waitpid(pid, 0)
    if message.startswith("OK"):
        raise SystemExit(0)
    sys.stderr.write(message or "Failed to start APK server\n")
    raise SystemExit(1)

os.setsid()
pid = os.fork()
if pid:
    raise SystemExit(0)

os.close(ready_read)
os.chdir(serve_dir)
with open(log_file, "ab", buffering=0) as log:
    os.dup2(log.fileno(), 1)
    os.dup2(log.fileno(), 2)
with open(os.devnull, "rb") as devnull:
    os.dup2(devnull.fileno(), 0)

try:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=serve_dir)

    class ReusableTCPServer(socketserver.ThreadingTCPServer):
        allow_reuse_address = True

    with ReusableTCPServer((host, port), handler) as httpd:
        with open(pid_file, "w", encoding="utf-8") as file:
            file.write(f"{os.getpid()}\n")
        os.write(ready_write, b"OK")
        os.close(ready_write)
        httpd.serve_forever()
except BaseException as exc:
    try:
        os.write(ready_write, f"Failed to start APK server: {exc}\n".encode("utf-8", "replace"))
        os.close(ready_write)
    finally:
        raise
PY
  echo "Started APK server in background."
  echo "PID: $(cat "$PID_FILE")"
  echo "Log: $LOG_FILE"
  exit 0
fi

cd "$SERVE_DIR"
echo "Press Ctrl-C to stop."
python3 -m http.server "$PORT" --bind "$HOST"

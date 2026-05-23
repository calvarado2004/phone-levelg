import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dockerfile = readFileSync("apps/server/Dockerfile", "utf8");
const goMod = readFileSync("apps/server/go.mod", "utf8");
const compose = readFileSync("docker-compose.yml", "utf8");

assert.match(dockerfile, /^FROM golang:1\.26-alpine AS build$/m, "server Dockerfile must build with Go 1.26");
assert.match(goMod, /^go 1\.26$/m, "go.mod must declare Go 1.26");
assert.match(dockerfile, /CGO_ENABLED=0 GOOS=linux go build -o \/out\/phone-levelg-server \.\/cmd\/server/);
assert.match(compose, /docker\.io\/library\/postgres:18-alpine/, "local compose must use Postgres 18");
assert.match(compose, /PGDATA:\s*\/var\/lib\/postgresql\/data\/pgdata/, "local compose Postgres 18 must keep PGDATA under /var/lib/postgresql");
assert.match(compose, /postgres18-data:\/var\/lib\/postgresql/, "local compose Postgres 18 volume must mount at /var/lib/postgresql");
assert.match(compose, /docker\.io\/library\/redis:7-alpine/, "local compose must use fully qualified Redis image");
assert.match(compose, /server:\n\s+build:/, "local compose must run the Go API");
assert.match(compose, /docker\.io\/livekit\/livekit-server:latest/, "local compose must include LiveKit for emulator calls");
assert.match(compose, /"4000:4000"/, "local compose must expose the API on port 4000");
assert.match(compose, /"7880:7880"/, "local compose must expose LiveKit websocket port 7880");

console.log("Validated container build and local state service assets");

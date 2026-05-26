import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse, parseAllDocuments } from "yaml";

const dockerfile = readFileSync("apps/server/Dockerfile", "utf8");
const goMod = readFileSync("apps/server/go.mod", "utf8");
const compose = readFileSync("docker-compose.yml", "utf8");
const composeDoc = parse(compose);
const openshiftResources = [
  "deploy/openshift/server.yaml",
  "deploy/openshift/postgres.yaml",
  "deploy/openshift/redis.yaml",
  "deploy/openshift/livekit.yaml"
].flatMap(file => parseAllDocuments(readFileSync(file, "utf8")).filter(doc => doc.contents).map(doc => doc.toJSON()));
const localLiveKit = parse(readFileSync("deploy/local/livekit.yaml", "utf8"));
const openshiftLiveKit = parseAllDocuments(readFileSync("deploy/openshift/livekit.yaml", "utf8"))
  .find(doc => doc.contents?.items?.some?.(item => item.key?.value === "kind" && item.value?.value === "ConfigMap"))
  .toJSON();
const openshiftLiveKitConfig = parse(openshiftLiveKit.data["livekit.yaml"]);

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

const services = composeDoc.services;
assert.deepEqual(
  Object.keys(services).sort(),
  ["livekit", "postgres", "redis", "server"],
  "local compose must mirror the OpenShift runtime services"
);

const openshiftPostgres = findResource("StatefulSet", "postgres").spec.template.spec.containers[0];
assert.equal(services.postgres.image, openshiftPostgres.image, "Compose and OpenShift must use the same Postgres image");
assert.equal(services.postgres.environment.PGDATA, envValue(openshiftPostgres, "PGDATA"), "Compose and OpenShift must use the same Postgres PGDATA");
assert.ok(services.postgres.volumes.includes("postgres18-data:/var/lib/postgresql"), "Compose Postgres must persist the same mounted data root as OpenShift");
assert.deepEqual(services.postgres.healthcheck.test, ["CMD-SHELL", "pg_isready -U phone_levelg -d phone_levelg"], "Compose Postgres healthcheck must match the OpenShift readiness command");

const openshiftRedis = findResource("StatefulSet", "redis").spec.template.spec.containers[0];
assert.equal(services.redis.image, openshiftRedis.image, "Compose and OpenShift must use the same Redis image");
assert.deepEqual(services.redis.command, openshiftRedis.args, "Compose Redis command must match OpenShift append-only persistence");
assert.ok(services.redis.volumes.includes("redis7-data:/data"), "Compose Redis must persist /data like OpenShift");
assert.deepEqual(services.redis.healthcheck.test, ["CMD", "redis-cli", "ping"], "Compose Redis healthcheck must match the OpenShift readiness command");

assert.deepEqual(services.server.depends_on.postgres, { condition: "service_healthy" }, "Compose server must wait for healthy Postgres");
assert.deepEqual(services.server.depends_on.redis, { condition: "service_healthy" }, "Compose server must wait for healthy Redis");
assert.equal(services.server.environment.PORT, "4000", "Compose server port env must match OpenShift");
assert.equal(services.server.environment.CORS_ORIGIN, "*", "Compose server CORS env must match OpenShift");
assert.equal(services.server.environment.DATABASE_URL, "postgres://phone_levelg:phone_levelg@postgres:5432/phone_levelg?sslmode=disable");
assert.equal(services.server.environment.REDIS_ADDR, "redis:6379");

const openshiftLiveKitContainer = findResource("Deployment", "phone-levelg-livekit").spec.template.spec.containers[0];
assert.equal(services.livekit.image, openshiftLiveKitContainer.image, "Compose and OpenShift must use the same LiveKit image");
assert.deepEqual(services.livekit.command, openshiftLiveKitContainer.args, "Compose and OpenShift must start LiveKit with the same config path");
assert.deepEqual(
  {
    port: localLiveKit.port,
    node_ip: localLiveKit.rtc.node_ip,
    tcp_port: localLiveKit.rtc.tcp_port,
    port_range_start: localLiveKit.rtc.port_range_start,
    port_range_end: localLiveKit.rtc.port_range_end,
    use_external_ip: localLiveKit.rtc.use_external_ip
  },
  {
    port: openshiftLiveKitConfig.port,
    node_ip: openshiftLiveKitConfig.rtc.node_ip,
    tcp_port: openshiftLiveKitConfig.rtc.tcp_port,
    port_range_start: openshiftLiveKitConfig.rtc.port_range_start,
    port_range_end: openshiftLiveKitConfig.rtc.port_range_end,
    use_external_ip: openshiftLiveKitConfig.rtc.use_external_ip
  },
  "local and OpenShift LiveKit RTC config must stay aligned"
);
for (const port of ["7880:7880", "7881:7881", "50100-50120:50100-50120/udp"]) {
  assert.ok(services.livekit.ports.includes(port), `Compose LiveKit must expose ${port}`);
}

console.log("Validated container build, local stack parity, and state service assets");

function findResource(kind, name) {
  const resource = openshiftResources.find(item => item.kind === kind && item.metadata?.name === name);
  assert.ok(resource, `missing OpenShift ${kind}/${name}`);
  return resource;
}

function envValue(container, name) {
  return container.env?.find(item => item.name === name)?.value;
}

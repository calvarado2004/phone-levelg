import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseAllDocuments } from "yaml";

const files = [
  "deploy/openshift/server.yaml",
  "deploy/openshift/postgres.yaml",
  "deploy/openshift/redis.yaml",
  "deploy/openshift/livekit.yaml"
];

const resources = files.flatMap(file => {
  const contents = readFileSync(file, "utf8");
  return parseAllDocuments(contents)
    .filter(doc => doc.contents)
    .map(doc => ({ file, resource: doc.toJSON() }));
});

for (const { file, resource } of resources) {
  assert.ok(resource.apiVersion, `${file}: apiVersion is required`);
  assert.ok(resource.kind, `${file}: kind is required`);
  assert.ok(resource.metadata?.name, `${file}: metadata.name is required`);
}

const namespace = find("Namespace", "phone-levelg");
assert.equal(namespace.metadata.name, "phone-levelg");

const buildConfig = find("BuildConfig", "phone-levelg-server");
assert.equal(buildConfig.metadata.namespace, "phone-levelg");
assert.equal(buildConfig.spec.strategy.dockerStrategy.dockerfilePath, "apps/server/Dockerfile");
assert.equal(buildConfig.spec.output.to.name, "phone-levelg-server:latest");

const deployment = find("Deployment", "phone-levelg-server");
assert.equal(deployment.metadata.namespace, "phone-levelg");
assert.equal(
  deployment.spec.template.spec.containers[0].image,
  "image-registry.openshift-image-registry.svc:5000/phone-levelg/phone-levelg-server:latest"
);
assert.equal(
  deployment.spec.replicas,
  1,
  "server websocket presence is process-local, so the backend must stay single-replica until presence is externalized"
);

for (const statefulSetName of ["postgres", "redis"]) {
  const statefulSet = find("StatefulSet", statefulSetName);
  assert.equal(statefulSet.metadata.namespace, "phone-levelg");
  assert.equal(
    statefulSet.spec.volumeClaimTemplates[0].spec.storageClassName,
    "px-csi-db",
    `${statefulSetName} must use px-csi-db`
  );
  assert.match(
    statefulSet.spec.template.spec.containers[0].image,
    /^docker\.io\//,
    `${statefulSetName} image must be fully qualified`
  );
}

const postgres = find("StatefulSet", "postgres");
const postgresContainer = postgres.spec.template.spec.containers[0];
assert.equal(postgresContainer.image, "docker.io/library/postgres:18-alpine");
assert.equal(postgresContainer.volumeMounts[0].mountPath, "/var/lib/postgresql");
assert.deepEqual(
  postgresContainer.env.find(env => env.name === "PGDATA"),
  { name: "PGDATA", value: "/var/lib/postgresql/data/pgdata" }
);

const redis = find("StatefulSet", "redis");
assert.equal(redis.spec.template.spec.containers[0].image, "docker.io/library/redis:7-alpine");

const serverSecret = find("Secret", "phone-levelg-server");
assert.equal(serverSecret.stringData.DATABASE_URL, "postgres://phone_levelg:phone_levelg@postgres:5432/phone_levelg?sslmode=disable");
assert.equal(serverSecret.stringData.REDIS_ADDR, "redis:6379");
assert.equal(serverSecret.stringData.LIVEKIT_API_KEY, "devkey");
assert.equal(serverSecret.stringData.LIVEKIT_API_SECRET, "secret");

const livekitDeployment = find("Deployment", "phone-levelg-livekit");
assert.equal(livekitDeployment.metadata.namespace, "phone-levelg");
assert.equal(livekitDeployment.spec.template.spec.containers[0].image, "docker.io/livekit/livekit-server:latest");

const livekitRoute = find("Route", "phone-levelg-livekit");
assert.equal(livekitRoute.spec.port.targetPort, "signal");

const livekitService = find("Service", "phone-levelg-livekit");
assert.ok(
  livekitService.spec.ports.some(port => port.name === "rtc-udp-50100" && port.protocol === "UDP"),
  "LiveKit service must expose an RTC UDP port"
);

console.log(`Validated ${resources.length} OpenShift resources`);

function find(kind, name) {
  const match = resources.find(({ resource }) => resource.kind === kind && resource.metadata?.name === name);
  assert.ok(match, `missing ${kind}/${name}`);
  return match.resource;
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseAllDocuments } from "yaml";

const files = [
  "deploy/openshift/server.yaml",
  "deploy/openshift/postgres.yaml",
  "deploy/openshift/redis.yaml",
  "deploy/openshift/livekit.yaml"
];
const exampleFiles = ["deploy/openshift/secrets.example.yaml"];

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
  assert.notEqual(resource.kind, "Secret", `${file}: real OpenShift manifests must not define Secret objects`);
  assert.doesNotMatch(JSON.stringify(resource), /replace-with-|devkey: secret/i, `${file}: real OpenShift manifests must not contain placeholder secret values`);
}

const namespace = find("Namespace", "phone-levelg");
assert.equal(namespace.metadata.name, "phone-levelg");

const buildConfig = find("BuildConfig", "phone-levelg-server");
assert.equal(buildConfig.metadata.namespace, "phone-levelg");
assert.equal(buildConfig.spec.source.type, "Git");
assert.equal(buildConfig.spec.source.git.uri, "https://github.com/calvarado2004/phone-levelg.git");
assert.equal(buildConfig.spec.source.git.ref, "main");
assert.equal(buildConfig.spec.strategy.dockerStrategy.dockerfilePath, "apps/server/Dockerfile");
assert.equal(buildConfig.spec.output.to.name, "phone-levelg-server:latest");
assert.ok(
  buildConfig.spec.triggers.some(trigger => trigger.type === "GitHub" && trigger.github?.secretReference?.name === "phone-levelg-github-webhook"),
  "backend BuildConfig must be triggerable from GitHub webhooks"
);

const buildManifests = resources.filter(({ resource }) => resource.kind === "BuildConfig");
for (const { file, resource } of buildManifests) {
  assert.notEqual(resource.spec.source?.type, "Binary", `${file}: OpenShift builds must use Git source, not binary uploads`);
}

const deployment = find("Deployment", "phone-levelg-server");
assert.equal(deployment.metadata.namespace, "phone-levelg");
const serverContainer = deployment.spec.template.spec.containers[0];
assert.equal(
  serverContainer.image,
  "image-registry.openshift-image-registry.svc:5000/phone-levelg/phone-levelg-server:latest"
);
assert.deepEqual(serverContainer.envFrom, [{ secretRef: { name: "phone-levelg-server" } }]);
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
assert.deepEqual(postgresContainer.envFrom, [{ secretRef: { name: "postgres" } }]);
assert.equal(postgresContainer.volumeMounts[0].mountPath, "/var/lib/postgresql");
assert.deepEqual(
  postgresContainer.env.find(env => env.name === "PGDATA"),
  { name: "PGDATA", value: "/var/lib/postgresql/data/pgdata" }
);

const redis = find("StatefulSet", "redis");
assert.equal(redis.spec.template.spec.containers[0].image, "docker.io/library/redis:7-alpine");

const livekitDeployment = find("Deployment", "phone-levelg-livekit");
assert.equal(livekitDeployment.metadata.namespace, "phone-levelg");
const livekitContainer = livekitDeployment.spec.template.spec.containers[0];
assert.equal(livekitContainer.image, "docker.io/livekit/livekit-server:latest");
assert.deepEqual(
  livekitContainer.env.find(env => env.name === "LIVEKIT_KEYS")?.valueFrom,
  { secretKeyRef: { name: "phone-levelg-livekit", key: "LIVEKIT_KEYS" } }
);

const livekitRoute = find("Route", "phone-levelg-livekit");
assert.equal(livekitRoute.spec.port.targetPort, "signal");

const livekitService = find("Service", "phone-levelg-livekit");
assert.ok(
  livekitService.spec.ports.some(port => port.name === "rtc-udp-50100" && port.protocol === "UDP"),
  "LiveKit service must expose an RTC UDP port"
);

console.log(`Validated ${resources.length} OpenShift resources`);

const exampleResources = exampleFiles.flatMap(file => {
  const contents = readFileSync(file, "utf8");
  return parseAllDocuments(contents)
    .filter(doc => doc.contents)
    .map(doc => ({ file, resource: doc.toJSON() }));
});

for (const { file, resource } of exampleResources) {
  assert.equal(resource.kind, "Secret", `${file}: example manifests must only contain Secret examples`);
  assert.match(file, /\.example\.yaml$/, `${file}: placeholder values must live only in .example.yaml files`);
  assert.equal(resource.metadata?.annotations?.["phone-levelg.io/example-only"], "true", `${file}: Secret examples must be marked example-only`);
}

for (const secretName of ["phone-levelg-github-webhook", "phone-levelg-server", "postgres", "phone-levelg-livekit"]) {
  assert.ok(
    exampleResources.some(({ resource }) => resource.metadata?.name === secretName),
    `missing example Secret/${secretName}`
  );
}

function find(kind, name) {
  const match = resources.find(({ resource }) => resource.kind === kind && resource.metadata?.name === name);
  assert.ok(match, `missing ${kind}/${name}`);
  return match.resource;
}

# OpenShift Deployment

Namespace: `phone-levelg`

Storage class for PVC-backed services: `px-csi-db`

## Pieces

- `server.yaml`
  - namespace
  - local OpenShift ImageStream
  - Git-sourced BuildConfig
  - references to externally managed backend and webhook Secrets
  - backend Deployment
  - backend Service
  - backend Route

- `postgres.yaml`
  - Postgres StatefulSet
  - reference to externally managed Postgres Secret
  - Postgres PVC using `px-csi-db`
  - ClusterIP Service

- `redis.yaml`
  - Redis StatefulSet
  - Redis PVC using `px-csi-db`
  - ClusterIP Service

- `livekit.yaml`
  - LiveKit ConfigMap
  - LiveKit Deployment
  - reference to externally managed LiveKit Secret
  - LiveKit LoadBalancer Service
  - TCP signaling/media ports and UDP WebRTC media ports

## Deploy

```sh
oc apply -f deploy/openshift/postgres.yaml
oc apply -f deploy/openshift/redis.yaml
oc apply -f deploy/openshift/server.yaml
oc apply -f deploy/openshift/livekit.yaml
```

## Build Contract

OpenShift builds only backend runtime artifacts. Android APKs, iOS apps, local build directories, and ad hoc backend binaries must not be uploaded into the cluster.

The `phone-levelg-server` BuildConfig clones this repository from GitHub:

```text
https://github.com/calvarado2004/phone-levelg.git
```

The build pod runs `apps/server/Dockerfile` inside OpenShift and pushes the resulting backend image into the internal registry. Commit and push source changes to GitHub first, then let the GitHub webhook trigger the BuildConfig.

Real OpenShift manifests do not define Secret objects and do not contain placeholder secret values. Keep local real Secret exports in ignored `deploy/openshift/secrets.local.yaml`. Use tracked `deploy/openshift/secrets.example.yaml` only as a shape reference.

Configure the GitHub repository webhook with the externally managed `phone-levelg-github-webhook` Secret and point it at the BuildConfig webhook URL.

## Internal Registry

The backend image is built by OpenShift and pushed into:

```text
image-registry.openshift-image-registry.svc:5000/phone-levelg/phone-levelg-server:latest
```

The Deployment pulls that image directly from the local cluster registry.

## LiveKit

LiveKit is deployed in the same namespace and exposed with a MetalLB `LoadBalancer` service.

Current ports:

- `7880/TCP`: LiveKit signaling, used by mobile as `ws://192.168.1.88:7880`
- `7881/TCP`: WebRTC TCP fallback
- `50100-50120/UDP`: WebRTC media

The KVM/libvirt OpenShift network allocates the LiveKit service from the `192.168.122.0/24` MetalLB pool. The Fedora host forwards the home/VPN-facing host IP to that LoadBalancer IP with `socat`. The helper script in this directory mirrors the installed service command:

```sh
HOST_IP=192.168.1.88 \
LIVEKIT_LB_IP=$(oc -n phone-levelg get svc phone-levelg-livekit -o jsonpath='{.status.loadBalancer.ingress[0].ip}') \
sudo -E ./deploy/openshift/livekit-host-forward.sh
```

Do not leave stale DNAT rules for the same host ports active while this forwarder is running. Inbound packets must hit the local `socat` listeners on `7880`, `7881`, and `50100-50120/UDP`.

The service should normally have one listener set: two TCP listeners and one UDP listener for each port in `50100-50120`. UDP forwarding uses `socat -T 30` by default to clean up per-client relay workers after calls close. If `systemctl status phone-levelg-livekit-forward.service` shows a large number of duplicate UDP children, restart the service before validating WebRTC publish behavior.

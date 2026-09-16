# syntax=docker/dockerfile:1
# mq_prometheus (ibm-messaging/mq-metric-samples) built from IBM source at a pinned tag.
#
# Derived from the upstream Dockerfile at that tag (Apache-2.0):
#   https://github.com/ibm-messaging/mq-metric-samples/blob/v6.0.0/Dockerfile
# Same base images, MQ redistributable client (VRMF), Go toolchain, build flags and
# runtime layout. The one structural change: the source is cloned INSIDE the builder
# stage instead of arriving as a remote git build context. Docker Compose >= 2.35
# delegates builds to buildx bake, and bake on Windows (Docker Desktop) resolves
# `context: https://github.com/...git#v6.0.0` as a local path and fails with
# "failed to evaluate path ... CreateFile ...\https::". A local context with an
# in-build clone builds identically on Linux, macOS and Windows.
#
# linux/amd64 only (the lab targets Docker Desktop / x86_64); the upstream file also
# handles arm64/ppc64le/s390x from locally supplied install packages.
#
# Every input is pinned to content, not to a name that can move (CLAUDE.md rule 5):
# base images by digest, the source tag by its commit, the IBM client tarball by SHA-256.
# Bump: change MQ_METRIC_SAMPLES_TAG + MQ_METRIC_SAMPLES_COMMIT (and VRMF / VRMF_SHA256 /
# GOVERSION / the image digests if upstream moved them at the new tag) in one commit with
# the validation output. Digests: `docker buildx imagetools inspect <image> --format '{{.Manifest.Digest}}'`;
# commit: `git ls-remote --tags <repo> refs/tags/<tag>`; tarball: `curl -sSL <url> | sha256sum`.

ARG EXPORTER=mq_prometheus
ARG RUNTIME_IMAGE=registry.access.redhat.com/ubi8-minimal:latest@sha256:128021168edb5b3013258601a2dffe93fddfed91cf996c08c76a24dfdcd6de13
ARG BASE_IMAGE=registry.access.redhat.com/ubi8/go-toolset:1.21@sha256:4ec05fd5b355106cc0d990021a05b71bbfb9231e4f5bdc0c5316515edf6a1c96

# ------------------------------------------------------------------ builder
FROM ${BASE_IMAGE} AS builder
ARG EXPORTER
ARG MQ_METRIC_SAMPLES_REPO=https://github.com/ibm-messaging/mq-metric-samples.git
ARG MQ_METRIC_SAMPLES_TAG=v6.0.0
ARG MQ_METRIC_SAMPLES_COMMIT=7bce9b8ef9ef513ff77688f022929843d5ba7eaf
ARG GOPROXY=https://proxy.golang.org,direct
ARG RDURL=https://public.dhe.ibm.com/ibmdl/export/pub/software/websphere/messaging/mqdev/redist
ARG VRMF_SHA256=2c987fa786a027baec10668e2e2a5bdacfd0fe5b0e37147c8a490e28fde5b877
ENV EXPORTER=${EXPORTER} \
    VRMF=10.0.0.0 \
    CGO_CFLAGS="-I/opt/mqm/inc/" \
    CGO_LDFLAGS_ALLOW="-Wl,-rpath.*" \
    genmqpkg_incnls=1 \
    genmqpkg_incsdk=1 \
    genmqpkg_inctls=1 \
    GOVERSION=1.22.8
ENV GOTOOLCHAIN="go${GOVERSION}+auto"
USER 0
RUN go env -w GOPROXY="${GOPROXY}" && go version

# MQ redistributable client + SDK, exactly as upstream fetches it for linux/amd64 — verified
# against the pinned SHA-256 before anything is unpacked.
RUN mkdir -p /opt/mqm && chmod a+rx /opt/mqm && cd /opt/mqm \
    && curl -LO "${RDURL}/${VRMF}-IBM-MQC-Redist-LinuxX64.tar.gz" \
    && echo "${VRMF_SHA256}  ${VRMF}-IBM-MQC-Redist-LinuxX64.tar.gz" | sha256sum -c - \
    && tar -zxf ./*.tar.gz && rm -f ./*.tar.gz \
    && bin/genmqpkg.sh -b /opt/mqm

# Source at the pinned tag, which must still resolve to the pinned commit (a moved tag fails
# the build instead of silently shipping different code under the same image name).
WORKDIR /go/src/github.com/ibm-messaging
RUN git -c advice.detachedHead=false clone --depth 1 --branch "${MQ_METRIC_SAMPLES_TAG}" "${MQ_METRIC_SAMPLES_REPO}" mq-metric-samples \
    && cd mq-metric-samples \
    && test "$(git rev-parse HEAD)" = "${MQ_METRIC_SAMPLES_COMMIT}" \
    || { echo "tag ${MQ_METRIC_SAMPLES_TAG} is at $(git -C mq-metric-samples rev-parse HEAD), expected ${MQ_METRIC_SAMPLES_COMMIT}" >&2; exit 1; }
WORKDIR /go/src/github.com/ibm-messaging/mq-metric-samples
RUN buildStamp=$(date +%Y%m%d-%H%M%S); bp="$(uname -s)/$(uname -m)"; gitCommit=$(git rev-parse --short HEAD); \
    go build -mod=vendor \
      -ldflags "-X \"main.BuildStamp=${buildStamp}\" -X \"main.BuildPlatform=${bp}\" -X \"main.GitCommit=${gitCommit}\"" \
      -o /go/bin/${EXPORTER} ./cmd/${EXPORTER}

# ------------------------------------------------------------------ runtime
FROM ${RUNTIME_IMAGE} AS runtime
ARG EXPORTER
# Upstream leaves the runtime as root with 777 directories. This process holds the MQ admin
# password and mqm rights on the queue manager, so it runs as an unprivileged uid; the MQ
# client only needs to write its error logs (/IBM/MQ/data/errors) and its .mqm marker.
RUN mkdir -p /opt/bin /opt/mqm /opt/config /IBM/MQ/data/errors /.mqm \
    && chmod 755 /opt/bin \
    && chmod -R 777 /IBM /.mqm \
    && chmod 775 /opt/mqm \
    && chmod a+rx /opt/config
WORKDIR /opt/mqm
ENV EXPORTER=${EXPORTER} \
    LD_LIBRARY_PATH="/opt/mqm/lib64:/usr/lib64" \
    MQ_CONNECT_TYPE=CLIENT \
    IBMMQ_GLOBAL_CONFIGURATIONFILE=/opt/config/${EXPORTER}.yaml
COPY --chmod=555 --from=builder /go/bin/${EXPORTER} /opt/bin/${EXPORTER}
COPY             --from=builder /opt/mqm/ /opt/mqm/
USER 1001
CMD ["sh", "-c", "/opt/bin/${EXPORTER}"]

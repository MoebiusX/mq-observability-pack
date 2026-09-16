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
# Bump: change MQ_METRIC_SAMPLES_TAG (and VRMF / GOVERSION / BASE_IMAGE if upstream
# moved them at the new tag) in one commit with the validation output (CLAUDE.md rule 5).

ARG EXPORTER=mq_prometheus
ARG RUNTIME_IMAGE=registry.access.redhat.com/ubi8-minimal:latest
ARG BASE_IMAGE=registry.access.redhat.com/ubi8/go-toolset:1.21

# ------------------------------------------------------------------ builder
FROM ${BASE_IMAGE} AS builder
ARG EXPORTER
ARG MQ_METRIC_SAMPLES_REPO=https://github.com/ibm-messaging/mq-metric-samples.git
ARG MQ_METRIC_SAMPLES_TAG=v6.0.0
ARG GOPROXY=https://proxy.golang.org,direct
ARG RDURL=https://public.dhe.ibm.com/ibmdl/export/pub/software/websphere/messaging/mqdev/redist
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

# MQ redistributable client + SDK, exactly as upstream fetches it for linux/amd64
RUN mkdir -p /opt/mqm && chmod a+rx /opt/mqm && cd /opt/mqm \
    && curl -LO "${RDURL}/${VRMF}-IBM-MQC-Redist-LinuxX64.tar.gz" \
    && tar -zxf ./*.tar.gz && rm -f ./*.tar.gz \
    && bin/genmqpkg.sh -b /opt/mqm

# Source at the pinned tag; -mod=vendor and the version stamps mirror upstream's build line
WORKDIR /go/src/github.com/ibm-messaging
RUN git -c advice.detachedHead=false clone --depth 1 --branch "${MQ_METRIC_SAMPLES_TAG}" "${MQ_METRIC_SAMPLES_REPO}" mq-metric-samples
WORKDIR /go/src/github.com/ibm-messaging/mq-metric-samples
RUN buildStamp=$(date +%Y%m%d-%H%M%S); bp="$(uname -s)/$(uname -m)"; gitCommit=$(git rev-parse --short HEAD); \
    go build -mod=vendor \
      -ldflags "-X \"main.BuildStamp=${buildStamp}\" -X \"main.BuildPlatform=${bp}\" -X \"main.GitCommit=${gitCommit}\"" \
      -o /go/bin/${EXPORTER} ./cmd/${EXPORTER}

# ------------------------------------------------------------------ runtime
FROM ${RUNTIME_IMAGE} AS runtime
ARG EXPORTER
RUN mkdir -p /opt/bin /opt/mqm /opt/config /IBM/MQ/data/errors /.mqm \
    && chmod -R 777 /opt/bin /IBM /.mqm \
    && chmod 775 /opt/mqm \
    && chmod a+rx /opt/config
WORKDIR /opt/mqm
ENV EXPORTER=${EXPORTER} \
    LD_LIBRARY_PATH="/opt/mqm/lib64:/usr/lib64" \
    MQ_CONNECT_TYPE=CLIENT \
    IBMMQ_GLOBAL_CONFIGURATIONFILE=/opt/config/${EXPORTER}.yaml
COPY --chmod=555 --from=builder /go/bin/${EXPORTER} /opt/bin/${EXPORTER}
COPY             --from=builder /opt/mqm/ /opt/mqm/
CMD ["sh", "-c", "/opt/bin/${EXPORTER}"]

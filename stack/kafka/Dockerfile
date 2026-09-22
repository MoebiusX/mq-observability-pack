# stack/kafka/Dockerfile — the lab's single Kafka node, and its traffic generator (same image, the
# kafka-gen service runs /opt/lab/gen.sh instead of the broker).
#
# The Apache image (KRaft, one node) plus Prometheus' JMX exporter as a javaagent: the broker's
# MBeans become the kafka-broker scrape job on :9404 with the Strimzi rule set (jmx-kafka.yml),
# which is the naming Observogram's kafka reference pack targets ("kafka 3.x, Strimzi 0.40+").
# Pins: KAFKA_TAG and CURL_TAG come from docker-compose.yaml / .env.example; the agent version and
# its sha256 (from the GitHub release's .sha256 file) are below. The jar is fetched in a curl
# stage so the Kafka image itself stays untouched apart from the two directories it gains.
ARG KAFKA_TAG=3.9.2
ARG CURL_TAG=8.22.0
ARG JMX_EXPORTER_VERSION=1.6.0
ARG JMX_EXPORTER_SHA256=a95983fd96e865d2bcdf911cc500e7c82808c27ab9fd226bf96732b6c3d8c46e

FROM curlimages/curl:${CURL_TAG} AS fetch
ARG JMX_EXPORTER_VERSION
ARG JMX_EXPORTER_SHA256
WORKDIR /tmp/jmx
RUN curl -fsSL -o jmx_prometheus_javaagent.jar \
      "https://github.com/prometheus/jmx_exporter/releases/download/${JMX_EXPORTER_VERSION}/jmx_prometheus_javaagent-${JMX_EXPORTER_VERSION}.jar" \
 && echo "${JMX_EXPORTER_SHA256}  jmx_prometheus_javaagent.jar" | sha256sum -c -

FROM apache/kafka:${KAFKA_TAG}
USER root
COPY --from=fetch /tmp/jmx/jmx_prometheus_javaagent.jar /opt/jmx/jmx_prometheus_javaagent.jar
COPY jmx-kafka.yml /opt/jmx/kafka.yml
COPY gen.sh /opt/lab/gen.sh
# The data directory exists in the image so the named volume inherits appuser's ownership.
RUN chmod 0755 /opt/lab/gen.sh \
 && mkdir -p /var/lib/kafka/data \
 && chown -R appuser:appuser /opt/jmx /opt/lab /var/lib/kafka
USER appuser

#!/usr/bin/env bash
# stack/kafka/gen.sh — the lab's Kafka traffic (the kafka-gen service).
#
# Two topics, a committing consumer group on each and a steady producer on each, all from the
# broker image's own tools: kafka-producer-perf-test at a fixed rate in a loop, and
# kafka-console-consumer with auto-commit so the groups' offsets move. That is what the kafka
# reference pack's per-topic, per-consumergroup and per-request panels read; nothing here is
# instrumented with OTel, so the pack's trace panel stays empty by design (said in STATUS.md).
# Rates are messages per second (KAFKA_ORDERS_RATE, KAFKA_PAYMENTS_RATE); each JVM is bounded by
# KAFKA_HEAP_OPTS and the service by its mem_limit. Logs are one JSON line per event so the log
# pipeline files them under service kafka-gen.
set -euo pipefail

BOOT=${KAFKA_BOOTSTRAP:-kafka:9092}
BIN=/opt/kafka/bin
ORDERS_RATE=${KAFKA_ORDERS_RATE:-50}
PAYMENTS_RATE=${KAFKA_PAYMENTS_RATE:-10}
export KAFKA_HEAP_OPTS=${KAFKA_HEAP_OPTS:--Xmx128m}

log() { printf '{"time":"%s","level":"%s","service":"kafka-gen","msg":"%s"}\n' "$(date -u +%FT%TZ)" "$1" "$2"; }

until "$BIN/kafka-topics.sh" --bootstrap-server "$BOOT" --list >/dev/null 2>&1; do
  log info "waiting for $BOOT"
  sleep 3
done
for t in orders payments; do
  "$BIN/kafka-topics.sh" --bootstrap-server "$BOOT" --create --if-not-exists --topic "$t" --partitions 3 --replication-factor 1 >/dev/null
done
log info "topics orders and payments ready on $BOOT"

# A consumer group that commits: the console consumer with auto-commit every second.
consume() {
  while true; do
    "$BIN/kafka-console-consumer.sh" --bootstrap-server "$BOOT" --topic "$1" --group "$2" \
      --consumer-property enable.auto.commit=true --consumer-property auto.commit.interval.ms=1000 >/dev/null 2>&1 || true
    log warn "consumer group $2 exited, restarting"
    sleep 2
  done
}

# A producer that sends one minute of records at the rate, then starts over (perf-test is bounded).
produce() {
  local topic=$1 rate=$2 size=$3
  while true; do
    if "$BIN/kafka-producer-perf-test.sh" --topic "$topic" --num-records $(( rate * 60 )) --record-size "$size" \
         --throughput "$rate" --producer-props bootstrap.servers="$BOOT" acks=all linger.ms=5 >/dev/null 2>&1; then
      log info "$topic: $(( rate * 60 )) records sent at ${rate}/s"
    else
      log warn "$topic: producer run failed, retrying"
      sleep 2
    fi
  done
}

consume orders orders-consumers &
consume payments payments-consumers &
produce orders "$ORDERS_RATE" 512 &
produce payments "$PAYMENTS_RATE" 256 &
log info "producing orders at ${ORDERS_RATE}/s and payments at ${PAYMENTS_RATE}/s"
wait

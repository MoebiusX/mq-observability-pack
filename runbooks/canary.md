# MQCanaryFailing (SEV1)

**Signal:** fewer than half of the synthetic put/get round-trips on `APP.CANARY` succeeded over 2 minutes, or the canary metric is absent.

## Triage
Look at the `result` label breakdown (`sum by (result)(rate(mq_canary_attempts_total[2m]))`):
* `connect_failed` → same causes as [qmgr-unreachable](qmgr-unreachable.md) / [qmgr-down](qmgr-down.md); those alerts should be firing too.
* `put_failed_q_full` → `APP.CANARY` MAXDEPTH reached: a previous canary generation left messages (get timeouts) — clear the canary queue, it is non-persistent by design.
* `get_timeout` → put works, get does not return the matching MsgId within 5 s: qmgr overloaded (check CPU, `log_write_latency`), or MATCH_MSG_ID broken by a message-conversion problem.
* `payload_mismatch` → someone else is consuming/altering `APP.CANARY` — find the rogue consumer (`DISPLAY QSTATUS(APP.CANARY) TYPE(HANDLE)`).
* metric absent → the canary container itself is down, or the collector/remote-write path is broken (check `IBMMQExporterDown` and collector export counters).

## Verify
`ibmmq:canary_success:ratio_5m` returns to ≥ 0.99.

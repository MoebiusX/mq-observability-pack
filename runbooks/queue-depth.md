# IBMMQQueueDepthHigh (SEV2) / IBMMQQueueFull (SEV1)

**Signal:** `depth / MAXDEPTH` > 0.8 (High) or ≥ 1 (Full → producers get MQRC_Q_FULL 2053 and the producer's `mq.orders.put.errors` counter climbs).

## Triage
1. Which queue? (label `queue`). Producer-side or consumer-side? `ibmmq_queue_input_handles == 0` → nobody is getting → consumer down. Input handles > 0 but `oldest_message_age` rising → consumer too slow.
2. `sum_over_time(ibmmq_queue_mqput_mqput1_count[2m]) / 120` vs `sum_over_time(ibmmq_queue_mqget_count[2m]) / 120` on the queue (these are per-interval deltas, not counters — never `rate()` them): the gap is the accumulation rate; depth / gap = time to full.
3. Upstream burst? Compare producer rate to baseline.

## Fix
* Consumer down → restart consumer (`consumer-scale-out` automation, max 3×/h).
* Consumer slow → scale out consumers; MQ shares a queue between concurrent getters natively.
* Genuinely more load → `ALTER QLOCAL(x) MAXDEPTH(n)` buys time only; fix the consumer.
* Never `CLEAR QLOCAL` on a persistent application queue without business sign-off.

## Verify
Headroom ratio falls, `IBMMQQueueFull` resolves first, `IBMMQQueueDepthHigh` after depth < 80 %.

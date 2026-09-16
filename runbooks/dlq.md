# IBMMQDeadLetterQueueNotEmpty (SEV2) — manual only

**Signal:** `ibmmq_queue_depth{queue="APP.DLQ"} > 0`. Something could not be delivered and MQ parked it with an MQDLH header saying why.

## Triage
1. Browse, never get: `amqsbcg APP.DLQ QM1` (or the console). Read the MQDLH `Reason` (e.g. 2053 queue full, 2085 unknown object, 2035 not authorized, 2030 message too big).
2. Correlate with the qmgr log around the DLH `PutDate/PutTime` in Loki (`{service_name="ibmmq"}`).
3. Is it one message (application bug) or a stream (topology/authority problem)?
4. A steady stream of ~40 messages every 10 s with reason 2053 on a `$SYS/MQ/INFO/QMGR/…` publication means a **subscriber stopped reading its destination**: its temporary dynamic reply queue (`AMQ.*`, MAXDEPTH 5000 from `SYSTEM.DEFAULT.MODEL.QUEUE`) is full and every further resource publication is dead-lettered. `DISPLAY QSTATUS('AMQ.*') CURDEPTH IPPROCS` finds the culprit; stopping that client deletes the queue and the stream ends. Seen live on 2026-09-16 with a detached, never-scraped mq_prometheus container.

## Fix
* Fix the root cause first (define the missing queue, fix authority, raise MAXMSGL, drain the full queue).
* Then replay with the DLQ handler: `runmqdlq APP.DLQ QM1 < rules.rul` with a rule that `ACTION(RETRY)`s the specific reason — or `ACTION(FWD)` to a quarantine queue for business review.
* Discard (`ACTION(DISCARD)`) only with written business sign-off; on a payments queue manager a DLQ message may be money.

## Verify
DLQ depth 0; the alert resolves 30-50 s after the queue is empty (measured; its `for:` is 20 s).

No automation exists for this alert by design (`automation: manual-only` in the pack).

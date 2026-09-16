# IBMMQOldestMessageAgeHigh (SEV2)

**Signal:** oldest message on an application queue older than 60 s (DIS QSTATUS MSGAGE, needs MONQ).

## Triage
1. `ibmmq_queue_input_handles{queue="..."}` — 0 means no consumer connected at all.
2. Consumer logs/traces: Tempo (Grafana → Explore → Tempo, `{ resource.service.name = "orders-consumer" }`) — are `receive` spans still being produced? Errors on GET (2033 is normal on an empty queue; anything else is not)?
3. Poison message: the same message being got and backed out repeatedly → `ibmmq_queue_depth` flat, age rising, consumer errors in a loop. Check `BOTHRESH`/`BOQNAME` on the queue.

## Fix
Restart/scale the consumer (automation `consumer-scale-out`, max 3×/h). For a poison message, move it to the DLQ / backout queue by hand, then handle per the DLQ runbook.

## Verify
`ibmmq:oldest_message_age:seconds_max` drops below 60; alert resolves.

# IBMMQQueueManagerRestarted (SEV2)

Only rendered for sites with `vantage: single` (client exporter only). From a client the
queue manager's uptime is the one retrospective discriminator between "the listener or channel
was broken" and "the queue manager itself restarted": both look like
`IBMMQQueueManagerUnreachable` while they last.

**Signal:** `ibmmq_qmgr_uptime{job="ibmmq-exporter"}` is below four scrape intervals, so the
queue manager started less than four scrapes ago. It resolves by itself once uptime passes that
threshold; its purpose is the timeline (dashboard annotation, alert ledger), not a page.

## Triage
* Preceded by `IBMMQQueueManagerUnreachable` → the queue manager was down (planned or not); read
  its error log (`AMQERR01.json` under the queue manager's `errors/` directory) for the stop
  reason (`AMQ8004I` planned `endmqm`, `AMQ5008I`/`AMQ6109E` abnormal end).
* On an RDQM group → a failover moved the queue manager to another node: `rdqmstatus -m <QM>`
  shows the current primary; confirm the floating address followed it and the exporter reconnected.
* No unreachable alert before it → the restart was shorter than the alert's `for:` window; still
  worth a look at the error log if it repeats.

## Verify
`ibmmq_qmgr_uptime{job="ibmmq-exporter", qmgr="<QM>"}` grows monotonically; no repeat within
the hour.

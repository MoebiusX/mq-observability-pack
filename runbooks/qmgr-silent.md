# IBMMQQueueManagerSilent (SEV2)

Only rendered for sites with `vantage: single` (client exporter only, no native endpoint), where
`IBMMQQueueManagerDown` cannot exist: from a client there is no process signal, so an absent
exporter series is the only evidence that a queue manager stopped answering.

**Signal:** a queue manager listed in the site inventory (`ibmmq:inventory:qmgr{qmgr}`, one
recorded series per queue manager of the environment) has had no `up{job="ibmmq-exporter"}`
series for 2 minutes. The inventory says it should be monitored; nothing is reporting it.

## Triage
Decide first whether the queue manager or its monitoring is silent:
* The client exporter for this queue manager is not running or not scraped → `up{job="ibmmq-exporter", qmgr="<QM>"}` is absent, not `0`. Check the exporter host from `site.json` (`qmgrs[].exporter_host`), its process (`mq_prometheus` instance for that queue manager, port `client_port`) and the collector's scrape logs. A whole-environment silence is [telemetry-pipeline](telemetry-pipeline.md).
* The exporter runs but cannot connect → `up` is `1` and `ibmmq_qmgr_status != 2`; that is [qmgr-unreachable](qmgr-unreachable.md) (in single-vantage sites it fires without the native gate, so it also covers a stopped queue manager).
* The queue manager was removed or renamed → update the inventory and regenerate the site (`gen-site`), otherwise the alert stays on until the inventory rule disappears.
* On an RDQM group: the floating address moved and the exporter's CCDT or `connName` still points at the old primary → check `rdqmstatus -m <QM>` on each node and the exporter's connection definition.

## Verify
`up{job="ibmmq-exporter", qmgr="<QM>"} == 1` returns and stays for one evaluation cycle; the
alert resolves on the next evaluation after the series is back.

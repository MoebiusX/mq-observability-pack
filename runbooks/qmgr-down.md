# IBMMQQueueManagerDown (SEV1)

**Signal:** `up{job="ibmmq-native"} == 0` for 20 s — the queue manager's own metrics server is gone, i.e. the container/process is down.

## Triage (2 min)
1. `docker compose ps mq` / `kubectl get pod -l app=mq` — is the container running? restarting?
2. `docker compose logs --tail=200 mq` — look for `AMQ7xxx`/`AMQ6xxx` FDC messages, OOM kills, volume permission errors (`/mnt/mqm`).
3. Confirm the blast radius: `MQCanaryFailing` and `IBMMQQueueManagerUnreachable` will follow within a minute.

## Fix
* Crashed / OOM: `docker compose start mq`. The pack declares an automation for this with a guardrail of max 2 automated restarts per hour and a human above SEV1; that is for the platform to implement — in this lab, do it by hand.
* Volume/permission: fix the mount, then restart. Never delete `/mnt/mqm` — that is the recovery log.
* Native HA: check quorum (`dspmq -o nativeha`) before restarting anything.

## Verify
`ibmmq:qmgr_process_up:ratio_5m` → 1, `ibmmq_qmgr_status{job="ibmmq-exporter"} == 2`, canary success back to 100 %. The alert resolves by itself.

# IBMMQQueueManagerUnreachable (SEV1)

**Signal:** native metrics answer but the client-side exporter reports `ibmmq_qmgr_status != 2` for 20 s. The process is alive; applications cannot reach it.

## Triage
1. Listener: `runmqsc QM1` → `DISPLAY LSSTATUS(*)`; if none running → `START LISTENER('SYSTEM.LISTENER.TCP.1')`.
2. Channel: `DISPLAY CHSTATUS(DEV.APP.SVRCONN)`, `DISPLAY CHSTATUS(DEV.ADMIN.SVRCONN)`; STOPPED → `START CHANNEL(...)`.
3. Auth: `AMQ9777`/`AMQ9557`/`AMQ9776` in the qmgr log = CHLAUTH/CONNAUTH rejecting the client; `DISPLAY CHLAUTH(*)`, check password secrets rotated?
4. Network: port 1414 reachable from the client network? (`nc -zv mq 1414`)
5. Quiescing: `dspmq -m QM1` shows `Quiescing` → someone ran `endmqm -c`.

## Fix
Start what is stopped. Automation `start-listener-and-channels` is allowed up to 3×/h; auth and network problems need a human.

## Verify
`ibmmq_qmgr_status{job="ibmmq-exporter"} == 2`, canary recovers within one interval.

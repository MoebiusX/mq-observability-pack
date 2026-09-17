// tools/site/templates/index.mjs — the template registry of the IBM MQ site module.
//
// tools/site/ibmmq.mjs delegates its templates(ctx), perQmgr(ctx, qm) and fleet(ctxs) hooks
// here, so a new rendered file is one import and one entry in a map, never a change to the
// module. Every template is a function over the reference file under stack/ (design rule R1:
// the lab file is the template, `${...}` only where the inventory or the environment drives a
// value, fleet-only blocks guarded by ctx conditions that are false for the lab). No template
// engine. A template that does not apply to an environment returns null and the module records
// the skip in site.json (`skipped`).
//
//   templates   { '<path under sites/<env>/>': (ctx) => string | null }
//   perQmgr     { 'qmgrs/<qm>/<file>': (ctx, qm) => string | null }   ('<qm>' is replaced by the queue manager's name)
//   fleet       { '<path under sites/>': (ctxs) => string }           (only with --env all and > 1 environment)
//
// ctx is the gen-site context (vendor/observogram/lib/site/run.mjs header): env, lab, timing
// (step, poll, probe, window3, gate, canaryShort, canaryHung, keepFiring, dur(), durM(),
// symptomFor(), alertmanager{}), vantage, profile, p (site params), endpoints, receivers,
// secrets, qmgrs[], hosts[], siteOf(qm), pack (the derived site pack), burn, manifest.

import { render as recording } from './recording.mjs';
import { render as alerts } from './alerts.mjs';
import { render as inventoryRules } from './inventory-rules.mjs';
import { render as tests } from './tests.mjs';
import { render as prometheus } from './prometheus.mjs';
import { render as otelcol } from './otelcol.mjs';
import { render as alertmanager, renderFleet as alertmanagerFleet } from './alertmanager.mjs';
import { render as datasources } from './datasources.mjs';
import { render as exporterClient } from './exporter-client.mjs';
import { render as canaryEnv } from './canary-env.mjs';
import * as fileSd from './file-sd.mjs';

export const templates = {
  'prometheus/prometheus.yml': prometheus,
  'prometheus/rules/ibmmq.recording.yml': recording,
  'prometheus/rules/ibmmq.alerts.yml': alerts,
  'prometheus/rules/ibmmq.inventory.yml': inventoryRules,
  'prometheus/tests/ibmmq.alerts.test.yml': tests,
  'prometheus/file_sd/ibmmq-native.json': fileSd.native,
  'prometheus/file_sd/ibmmq-exporter.json': fileSd.exporter,
  'prometheus/file_sd/certification.json': fileSd.certification,
  'otelcol/config.yaml': otelcol,
  'alertmanager/alertmanager.yml': alertmanager,
  'grafana/provisioning/datasources/datasources.yaml': datasources,
};

export const perQmgr = {
  'qmgrs/<qm>/mq_prometheus.yaml': exporterClient,
  'qmgrs/<qm>/canary.env': canaryEnv,
};

export const fleet = {
  'alertmanager.fleet.yml': alertmanagerFleet,
};

// tools/site/templates/index.mjs — the template registry of the IBM MQ site module.
//
// tools/site/ibmmq.mjs delegates its templates(ctx) and perQmgr(ctx, qm) hooks here, so a new
// rendered file is one import and one entry in a map, never a change to the module. Every
// template is a function over the reference file under stack/ (design rule R1: the lab file is
// the template, `${...}` only where the inventory or the environment drives a value, fleet-only
// blocks guarded by ctx conditions that are false for the lab). No template engine.
//
//   templates   { '<path under sites/<env>/>': (ctx) => string }
//   perQmgr     { 'qmgrs/<qm>/<file>': (ctx, qm) => string }   ('<qm>' is replaced by the queue manager's name)
//   fleet       { '<path under sites/>': (ctxs) => string }     (only with --env all and > 1 environment)
//
// ctx is the gen-site context (vendor/observogram/lib/site/run.mjs header): env, lab, timing
// (step, poll, probe, window3, gate, canaryShort, canaryHung, keepFiring, dur(), durM(),
// symptomFor(), alertmanager{}), vantage, profile, p (site params), endpoints, receivers,
// secrets, qmgrs[], hosts[], siteOf(qm), pack (the derived site pack), burn, manifest.
//
// The Foundation stage registers nothing: the Templates stage fills this file with one module
// per design §5 entry (recording, alerts, inventory-rules, alertmanager, otelcol-gateway,
// prometheus, datasources, exporter-client, canary-env, tests), e.g.
//   import { render as recording } from './recording.mjs';
//   export const templates = { 'prometheus/rules/ibmmq.recording.yml': recording };

export const templates = {};
export const perQmgr = {};
export const fleet = {};

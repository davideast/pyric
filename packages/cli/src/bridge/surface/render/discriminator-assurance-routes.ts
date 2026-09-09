/**
 * The routes the `judge_authorization_risk` tool's actions take.
 *
 * The assurance family as the discriminator variant spells it: replaying a
 * capture, deciding its cases locally and on the hosted API, reading a
 * feature's conformance status, and the campaign run loop from attach through
 * export. Each route reaches the same canonical operation the service tool's
 * `assurance` methods reach, under the argument names this variant was
 * authored with, so the two surfaces execute the same handlers.
 *
 * `check_conformance` is the one action that belongs to a tool this file does
 * not own: `verify_security_rules` already spelled it, so the route lives with
 * its family here and names that tool.
 */
import type { Args, DiscriminatorRoute } from './discriminator-route-shapes.js';
import { assign, on, parseJsonArray, parseJsonObject, text } from './discriminator-route-shapes.js';

/** The campaign every run-loop action names. */
function campaign(args: Args): Args {
  const call: Args = {};
  assign(call, 'campaignId', args.campaignId);
  return call;
}

/** The campaign and the probe an action names. */
function campaignProbe(args: Args): Args {
  const call = campaign(args);
  assign(call, 'probeId', args.probeId);
  return call;
}

export const ASSURANCE_ROUTES: DiscriminatorRoute[] = [
  {
    tool: 'verify_security_rules',
    action: 'check_conformance',
    selects: on('action', 'check_conformance'),
    operation: 'check_assurance_feature',
    translate: (args) => ({ feature: text(args, 'feature') ?? '' }),
  },
  {
    tool: 'judge_authorization_risk',
    action: 'replay_session',
    selects: on('action', 'replay_session'),
    operation: 'replay_assurance_session',
    translate: (args) => {
      const call: Args = {};
      assign(call, 'sessionPath', args.sessionPath);
      assign(call, 'candidateRules', args.candidateRules);
      assign(call, 'service', args.service);
      return call;
    },
  },
  {
    tool: 'judge_authorization_risk',
    action: 'verify_cases',
    selects: on('action', 'verify_cases'),
    operation: 'verify_assurance_cases',
    translate: (args) => {
      const call: Args = {};
      assign(call, 'fixture', args.sessionPath);
      assign(call, 'candidateRules', args.candidateRules);
      return call;
    },
  },
  {
    tool: 'judge_authorization_risk',
    action: 'test_rules_hosted',
    selects: on('action', 'test_rules_hosted'),
    operation: 'test_assurance_rules_hosted',
    translate: (args) => {
      const call: Args = { service: 'firestore' };
      assign(call, 'rules', args.candidateRules);
      assign(call, 'cases', parseJsonArray(text(args, 'casesJson')));
      assign(call, 'confirm', args.confirm);
      return call;
    },
  },
  {
    tool: 'judge_authorization_risk',
    action: 'attach',
    selects: on('action', 'attach'),
    operation: 'attach_assurance_target',
    translate: campaign,
  },
  {
    tool: 'judge_authorization_risk',
    action: 'start',
    selects: on('action', 'start'),
    operation: 'start_assurance_campaign',
    translate: (args) => {
      const call = campaign(args);
      assign(call, 'target', parseJsonObject(text(args, 'targetJson')));
      return call;
    },
  },
  {
    tool: 'judge_authorization_risk',
    action: 'map',
    selects: on('action', 'map'),
    operation: 'map_assurance_campaign',
    translate: (args) => {
      const call = campaign(args);
      assign(call, 'actors', parseJsonArray(text(args, 'recordsJson')));
      return call;
    },
  },
  {
    tool: 'judge_authorization_risk',
    action: 'define',
    selects: on('action', 'define'),
    operation: 'define_assurance_invariants',
    translate: (args) => {
      const call = campaign(args);
      assign(call, 'invariants', parseJsonArray(text(args, 'recordsJson')));
      return call;
    },
  },
  {
    tool: 'judge_authorization_risk',
    action: 'propose',
    selects: on('action', 'propose'),
    operation: 'propose_assurance_probes',
    translate: (args) => {
      const call = campaign(args);
      assign(call, 'observationId', args.observationId);
      assign(call, 'invariantId', args.invariantId);
      assign(call, 'mutations', parseJsonArray(text(args, 'recordsJson')));
      return call;
    },
  },
  {
    tool: 'judge_authorization_risk',
    action: 'run',
    selects: on('action', 'run'),
    operation: 'run_assurance_probes',
    translate: campaign,
  },
  {
    tool: 'judge_authorization_risk',
    action: 'inspect',
    selects: on('action', 'inspect'),
    operation: 'inspect_assurance_probe',
    translate: campaignProbe,
  },
  {
    tool: 'judge_authorization_risk',
    action: 'minimize',
    selects: on('action', 'minimize'),
    operation: 'minimize_assurance_probe',
    translate: campaignProbe,
  },
  {
    tool: 'judge_authorization_risk',
    action: 'verify',
    selects: on('action', 'verify'),
    operation: 'verify_assurance_rules',
    translate: (args) => {
      const call = campaign(args);
      const rules: Args = {};
      assign(rules, 'firestore', args.candidateRules);
      call.rules = rules;
      return call;
    },
  },
  {
    tool: 'judge_authorization_risk',
    action: 'export',
    selects: on('action', 'export'),
    operation: 'export_assurance_campaign',
    translate: (args) => {
      const call = campaign(args);
      assign(call, 'path', args.exportPath);
      return call;
    },
  },
];

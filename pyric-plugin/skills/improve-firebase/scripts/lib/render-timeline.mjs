/**
 * Deterministic timeline computation, binary-search frame sampling, and CFR resampling
 * for Pyric offline stage rendering.
 * Zero external dependencies.
 */

import path from 'node:path';

const MIN_TIMELINE_MS = 2500;
const DEFAULT_END_HOLD_MS = 500;

/**
 * Binary-search a sorted `frames` array (`[{ tMs, files }, ...]`) and return
 * the latest frame with `frame.tMs <= tMs` (clamped to first/last frame).
 */
export function sampleFrameAtTime(frames, tMs) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error('sampleFrameAtTime requires a non-empty sorted frames array');
  }
  if (frames.length === 1 || tMs <= frames[0].tMs) {
    return frames[0];
  }
  const lastIndex = frames.length - 1;
  if (tMs >= frames[lastIndex].tMs) {
    return frames[lastIndex];
  }

  let lo = 0;
  let hi = lastIndex;
  let best = 0;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (frames[mid].tMs <= tMs) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return frames[best];
}

function normalizeEventsList(events) {
  if (Array.isArray(events)) {
    return events;
  }
  if (events && typeof events === 'object' && Array.isArray(events.events)) {
    return events.events;
  }
  return [];
}

function getEventTimeMs(event) {
  if (!event || typeof event !== 'object') {
    return null;
  }
  for (const key of ['tMs', 'timestampMs', 'timeMs', 'offsetMs']) {
    if (typeof event[key] === 'number' && Number.isFinite(event[key]) && event[key] >= 0) {
      return event[key];
    }
  }
  return null;
}

function resolveEventMethod(event) {
  if (typeof event.method === 'string' && event.method.length > 0) {
    return event.method;
  }
  if (typeof event.op === 'string' && event.op.length > 0) {
    return event.op;
  }
  return null;
}

function formatSdkCallFromEvent(event) {
  if (!event || typeof event !== 'object') {
    return null;
  }
  if (typeof event.sdkCall === 'string' && event.sdkCall.trim().length > 0) {
    return event.sdkCall.trim();
  }
  const service = typeof event.service === 'string' ? event.service : null;
  const method = resolveEventMethod(event);
  const targetPath = typeof event.path === 'string' ? event.path : '/';
  if (!service || !method) {
    return null;
  }
  if (event.data !== undefined) {
    return `${service}.${method}('${targetPath}', ${JSON.stringify(event.data)})`;
  }
  return `${service}.${method}('${targetPath}')`;
}

function findEventForPhase(eventList, phaseNames) {
  for (const ev of eventList) {
    if (!ev || typeof ev !== 'object') {
      continue;
    }
    const evPhase = String(ev.phase ?? ev.type ?? ev.kind ?? '').toLowerCase();
    if (phaseNames.includes(evPhase)) {
      return ev;
    }
  }
  return null;
}

function findStepForPhase(steps, phaseNames) {
  if (!Array.isArray(steps)) {
    return null;
  }
  for (const step of steps) {
    if (!step || typeof step !== 'object') {
      continue;
    }
    const id = String(step.id ?? '').toLowerCase();
    const phase = String(step.phase ?? '').toLowerCase();
    if (phaseNames.includes(id) || phaseNames.includes(phase)) {
      return step;
    }
  }
  return null;
}

function resolveRuleText(candidate) {
  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    return candidate.trim();
  }
  return null;
}

function detectFixPresence(scenario, eventList, fixEvent, fixStep) {
  if (scenario.fixRules && Object.keys(scenario.fixRules).length > 0) {
    return true;
  }
  if (typeof scenario.copy?.fixed === 'string' && scenario.copy.fixed.trim().length > 0) {
    return true;
  }
  if (fixEvent !== null || fixStep !== null) {
    return true;
  }
  return eventList.some((ev) => String(ev?.decision ?? '').toUpperCase() === 'DENY');
}

function buildBeatDefinitions(scenario, eventList) {
  const showTitleCard = scenario.stage?.slots?.showTitleCard !== false;
  const showOutroCard = scenario.stage?.slots?.showOutroCard !== false;

  const hookEvent = findEventForPhase(eventList, ['hook', 'baseline', 'control']);
  const exploitEvent = findEventForPhase(eventList, ['exploit', 'mutation', 'attack']);
  const fixEvent = findEventForPhase(eventList, ['fix', 'verify', 'patched']);

  const hookStep = findStepForPhase(scenario.steps, ['hook', 'baseline']);
  const exploitStep = findStepForPhase(scenario.steps, ['exploit', 'attack']);
  const fixStep = findStepForPhase(scenario.steps, ['fix', 'verify']);
  const takeawayStep = findStepForPhase(scenario.steps, ['takeaway', 'outro']);

  const hasFix = detectFixPresence(scenario, eventList, fixEvent, fixStep);
  const victimUid = scenario.actors?.victim?.uid || 'alice';
  const attackerUid = scenario.actors?.attacker?.uid || 'mallory';

  const vulnerableRule =
    resolveRuleText(exploitStep?.matchedRule) ??
    resolveRuleText(exploitEvent?.matchedRule) ??
    resolveRuleText(scenario.fixRules?.before) ??
    resolveRuleText(hookEvent?.matchedRule) ??
    '".write": "auth != null"';

  const fixedRule =
    resolveRuleText(fixStep?.matchedRule) ??
    resolveRuleText(fixEvent?.matchedRule) ??
    resolveRuleText(scenario.fixRules?.matchedRule) ??
    resolveRuleText(scenario.fixRules?.after) ??
    resolveRuleText(scenario.fixRules?.rule) ??
    'auth != null && auth.uid == data.child("authorUid").val()';

  const exploitSdkCall =
    resolveRuleText(exploitStep?.sdkCall) ??
    formatSdkCallFromEvent(exploitEvent) ??
    `database.set('/target', { actor: '${attackerUid}' })`;

  const hookSdkCall =
    resolveRuleText(hookStep?.sdkCall) ??
    formatSdkCallFromEvent(hookEvent) ??
    `auth.signIn('${victimUid}')`;

  const fixSdkCall =
    resolveRuleText(fixStep?.sdkCall) ??
    formatSdkCallFromEvent(fixEvent) ??
    exploitSdkCall;

  const beats = [];

  if (showTitleCard) {
    const hookCaption =
      resolveRuleText(hookStep?.caption) ??
      resolveRuleText(hookEvent?.caption) ??
      resolveRuleText(scenario.copy?.baseline) ??
      scenario.copy.title;
    beats.push({
      id: 'hook',
      phase: 'hook',
      defaultDurationMs: 1200,
      eventTimeMs: getEventTimeMs(hookEvent),
      caption: hookCaption,
      badgeText: 'BASELINE ALLOW',
      badgeTone: 'neutral',
      sdkCall: hookSdkCall,
      matchedRule: resolveRuleText(hookEvent?.matchedRule) ?? vulnerableRule,
    });
  }

  const exploitCaption =
    resolveRuleText(exploitStep?.caption) ??
    resolveRuleText(exploitEvent?.caption) ??
    scenario.copy.exploit;
  beats.push({
    id: 'exploit',
    phase: 'exploit',
    defaultDurationMs: hasFix ? 2000 : 2400,
    eventTimeMs: getEventTimeMs(exploitEvent),
    caption: exploitCaption,
    badgeText: 'EXPLOIT ALLOWED',
    badgeTone: 'danger',
    sdkCall: exploitSdkCall,
    matchedRule: vulnerableRule,
  });

  if (hasFix) {
    const fixCaption =
      resolveRuleText(fixStep?.caption) ??
      resolveRuleText(fixEvent?.caption) ??
      resolveRuleText(scenario.copy?.fixed) ??
      'Security rules updated — unauthorized mutation denied';
    beats.push({
      id: 'fix',
      phase: 'fix',
      defaultDurationMs: 1500,
      eventTimeMs: getEventTimeMs(fixEvent),
      caption: fixCaption,
      badgeText: 'FIX DENIED',
      badgeTone: 'success',
      sdkCall: fixSdkCall,
      matchedRule: fixedRule,
    });

    const hasTakeaway = Boolean(takeawayStep) || (showOutroCard && Boolean(scenario.copy?.why));
    if (hasTakeaway) {
      const takeawayCaption =
        resolveRuleText(takeawayStep?.caption) ??
        scenario.copy.why;
      beats.push({
        id: 'takeaway',
        phase: 'fix',
        defaultDurationMs: 1300,
        eventTimeMs: null,
        caption: takeawayCaption,
        badgeText: 'FIX DENIED',
        badgeTone: 'success',
        sdkCall: fixSdkCall,
        matchedRule: fixedRule,
      });
    }
  }

  return beats;
}

function allocateBeatDurations(beatDefs, totalMs) {
  const count = beatDefs.length;
  const minBeatMs = Math.min(600, Math.floor(totalMs / count));

  // If timed events mark clear boundaries, honor them; otherwise allocate proportionally.
  const exploitIdx = beatDefs.findIndex((b) => b.id === 'exploit');
  const fixIdx = beatDefs.findIndex((b) => b.id === 'fix');

  if (
    exploitIdx === 1 &&
    typeof beatDefs[1].eventTimeMs === 'number' &&
    beatDefs[1].eventTimeMs >= minBeatMs &&
    beatDefs[1].eventTimeMs <= totalMs - minBeatMs * (count - 1)
  ) {
    const hookMs = Math.round(beatDefs[1].eventTimeMs);
    const remainingAfterHook = totalMs - hookMs;
    if (
      fixIdx === 2 &&
      typeof beatDefs[2].eventTimeMs === 'number' &&
      beatDefs[2].eventTimeMs > hookMs + minBeatMs &&
      beatDefs[2].eventTimeMs <= totalMs - minBeatMs * (count - 2)
    ) {
      const exploitMs = Math.round(beatDefs[2].eventTimeMs - hookMs);
      const remainingAfterExploit = totalMs - hookMs - exploitMs;
      if (count === 3) {
        return [hookMs, exploitMs, remainingAfterExploit];
      }
      const fixMs = Math.max(minBeatMs, Math.round(remainingAfterExploit * 0.55));
      const takeawayMs = Math.max(minBeatMs, remainingAfterExploit - fixMs);
      return [hookMs, exploitMs, fixMs, takeawayMs];
    }

    const tailDefs = beatDefs.slice(1);
    const tailDurations = allocateProportionalDurations(tailDefs, remainingAfterHook, minBeatMs);
    return [hookMs, ...tailDurations];
  }

  return allocateProportionalDurations(beatDefs, totalMs, minBeatMs);
}

function allocateProportionalDurations(defs, totalMs, minBeatMs) {
  const weightSum = defs.reduce((sum, item) => sum + item.defaultDurationMs, 0);
  const durations = [];
  let allocated = 0;

  for (let i = 0; i < defs.length; i++) {
    const remainingSlots = defs.length - i - 1;
    if (remainingSlots === 0) {
      durations.push(Math.max(1, totalMs - allocated));
    } else {
      const raw = Math.round((defs[i].defaultDurationMs / weightSum) * totalMs);
      const maxAllowed = totalMs - allocated - remainingSlots * minBeatMs;
      const clamped = Math.max(minBeatMs, Math.min(maxAllowed, raw));
      durations.push(clamped);
      allocated += clamped;
    }
  }

  return durations;
}

/**
 * Compute deterministic stage beats and total duration from a validated scenario,
 * optional event log, and optional capture duration.
 */
function formatServiceDisplayName(service) {
  const s = String(service || 'database').toLowerCase();
  if (s === 'database' || s === 'rtdb') return 'Realtime Database';
  if (s === 'firestore') return 'Firestore';
  if (s === 'storage') return 'Cloud Storage';
  return 'Firebase';
}

function parseRuleEntry(rawRule) {
  const text = String(rawRule || '').trim();
  if (!text) return { nodePath: '', body: '' };

  const rtdbMatch = /^([A-Za-z0-9_$/.-]+)\s*:\s*("(?:\.write|\.read|\.validate)"\s*:\s*[\s\S]+)$/.exec(text);
  if (rtdbMatch) {
    return {
      nodePath: rtdbMatch[1].trim(),
      body: rtdbMatch[2].trim(),
    };
  }

  const fsMatch = /^match\s+(\/[^\s{]+)\s*\{([\s\S]+)\}$/.exec(text);
  if (fsMatch) {
    const cleanMatchPath =
      fsMatch[1].replace(/^\/databases\/\{[^}]+\}\/documents/, '') || fsMatch[1];
    return {
      nodePath: cleanMatchPath.trim(),
      body: fsMatch[2].trim(),
    };
  }

  return { nodePath: '', body: text };
}

function resolveAnchoredRulePath(nodePath, targetPath, parentAnchoredPath = '') {
  const cleanTarget = String(targetPath || '').trim();
  const targetTokens = cleanTarget
    .replace(/^\/databases\/[^/]+\/documents/, '')
    .split('/')
    .filter(Boolean);
  const rawNode = String(nodePath || '').trim();

  if (!rawNode) {
    if (targetTokens.length >= 2) {
      return `/${targetTokens.slice(0, -1).join('/')}/$${targetTokens[targetTokens.length - 1]}`;
    }
    return cleanTarget || '/';
  }

  if (rawNode.startsWith('/')) {
    return rawNode;
  }

  const nodeTokens = rawNode.split('/').filter(Boolean);
  if (nodeTokens.length === 0) {
    return cleanTarget || '/';
  }

  const first = nodeTokens[0];
  if (!first.startsWith('$') && !first.startsWith('{')) {
    const idx = targetTokens.indexOf(first);
    if (idx > 0) {
      return `/${targetTokens.slice(0, idx).concat(nodeTokens).join('/')}`;
    }
    return `/${nodeTokens.join('/')}`;
  }

  if (parentAnchoredPath) {
    const cleanParent = parentAnchoredPath.replace(/\/+$/, '');
    const parentTokens = cleanParent.split('/').filter(Boolean);
    let overlap = 0;
    const maxOverlap = Math.min(parentTokens.length, nodeTokens.length);
    for (let k = maxOverlap; k >= 1; k -= 1) {
      let matches = true;
      for (let i = 0; i < k; i += 1) {
        if (parentTokens[parentTokens.length - k + i] !== nodeTokens[i]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        overlap = k;
        break;
      }
    }
    const suffixTokens = nodeTokens.slice(overlap);
    return suffixTokens.length > 0 ? `${cleanParent}/${suffixTokens.join('/')}` : cleanParent;
  }

  if (targetTokens.length >= nodeTokens.length) {
    return `/${targetTokens.slice(0, targetTokens.length - nodeTokens.length).concat(nodeTokens).join('/')}`;
  }

  return `/${nodeTokens.join('/')}`;
}

function humanizeToken(rawToken, fallback = 'record') {
  const cleaned = String(rawToken || '')
    .replace(/^[$@]+/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  return cleaned || fallback;
}

function capitalizeFirst(text) {
  const s = String(text || '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

function singularizeToken(word) {
  const s = String(word || '').trim();
  if (s.endsWith('ies') && s.length > 4) return `${s.slice(0, -3)}y`;
  if (s.endsWith('ses') && s.length > 4) return s.slice(0, -2);
  if (s.endsWith('s') && !s.endsWith('ss') && s.length > 3) return s.slice(0, -1);
  return s;
}

function inferCollectionNoun(targetPath, beforeRuleShortPath) {
  const combined = `${targetPath || ''} ${beforeRuleShortPath || ''}`;
  if (/message|chat|comment|thread/i.test(combined)) return 'messages';
  if (/note|memo/i.test(combined)) return 'notes';
  if (/task|todo|item|card/i.test(combined)) return 'items';
  if (/doc|page|post|article/i.test(combined)) return 'documents';
  if (/user|profile|account|member/i.test(combined)) return 'records';
  return 'records';
}

function extractWildcardMapFromRules(...ruleTexts) {
  const byParentKey = new Map();
  const isParamTok = (t) => /^[$@]/.test(t) || (/^\{.*\}$/.test(t) && !t.includes('database'));
  const cleanParamTok = (t) => {
    const s = String(t || '').trim();
    if (s.startsWith('{') && s.endsWith('}')) {
      return `$${s.slice(1, -1).replace(/=.*$/, '').trim()}`;
    }
    if (s.startsWith('$(') && s.endsWith(')')) {
      return `$${s.slice(2, -1).trim()}`;
    }
    return s;
  };

  for (const raw of ruleTexts) {
    const text = String(raw || '');
    if (!text) continue;

    // 1. Scan slash-delimited rule paths
    const pathRe = /(?:^|[\s"'`])([/$@a-zA-Z0-9_{}-]+(?:\/[$@a-zA-Z0-9_{}()-]+)+)/g;
    let pm;
    while ((pm = pathRe.exec(text)) !== null) {
      const segs = pm[1].split('/').filter(Boolean);
      for (let i = 1; i < segs.length; i += 1) {
        if (isParamTok(segs[i]) && !isParamTok(segs[i - 1])) {
          byParentKey.set(segs[i - 1], cleanParamTok(segs[i]));
        }
      }
    }

    // 2. Scan RTDB root.child('a').child($b) chains
    const chainRe = /root(?:\.child\(([^)]+)\))+/g;
    let cm;
    while ((cm = chainRe.exec(text)) !== null) {
      const segs = [];
      const childRe = /\.child\(([^)]+)\)/g;
      let sub;
      while ((sub = childRe.exec(cm[0])) !== null) {
        segs.push(sub[1].replace(/^['"]|['"]$/g, '').trim());
      }
      for (let i = 1; i < segs.length; i += 1) {
        if (isParamTok(segs[i]) && !isParamTok(segs[i - 1])) {
          byParentKey.set(segs[i - 1], cleanParamTok(segs[i]));
        }
      }
    }
  }

  return byParentKey;
}

function derivePathTokens({
  targetPath,
  beforeRuleAnchored,
  afterRuleAnchored,
  vulnerableRule = '',
  fixedRule = '',
  copy,
  victimName,
  victimUid,
  attackerName,
  attackerUid,
}) {
  if (Array.isArray(copy?.pathTokens) && copy.pathTokens.length > 0) {
    return copy.pathTokens.map((item) => ({
      text: String(item.text || item.path || ''),
      concreteValue: String(item.concreteValue || item.value || ''),
      isParam: Boolean(item.isParam),
      callout: item.callout
        ? {
            label: String(item.callout.label || ''),
            detail: String(item.callout.detail || ''),
          }
        : null,
    }));
  }

  const cleanTarget = String(targetPath || '/target')
    .replace(/^\/databases\/[^/]+\/documents/, '')
    .trim();
  const concreteTokens = cleanTarget.split('/').filter(Boolean);
  if (concreteTokens.length === 0) {
    return [
      {
        text: 'target',
        concreteValue: 'target',
        isParam: true,
        callout: {
          label: 'Target path',
          detail: copy?.targetContext || `Written directly by ${attackerUid}`,
        },
      },
    ];
  }

  const beforeTokens = String(beforeRuleAnchored || '')
    .replace(/^\/databases\/[^/]+\/documents/, '')
    .split('/')
    .filter(Boolean);
  const afterTokens = String(afterRuleAnchored || '')
    .replace(/^\/databases\/[^/]+\/documents/, '')
    .split('/')
    .filter(Boolean);

  const isParamToken = (tok) => /^[$@]/.test(tok) || (/^\{.*\}$/.test(tok) && !tok.includes('database'));
  const uidLower = String(victimUid || '').toLowerCase();
  const wildcardByParent = extractWildcardMapFromRules(
    beforeRuleAnchored,
    afterRuleAnchored,
    vulnerableRule,
    fixedRule,
  );

  // Determine the rule attachment index in concreteTokens
  let attachIdx = -1;
  if (beforeTokens.length > 0) {
    attachIdx = Math.min(concreteTokens.length - 1, beforeTokens.length - 1);
  } else {
    attachIdx = Math.max(0, concreteTokens.length - 2);
  }

  // Determine the leaf/record ID index (typically afterTokens last segment, or concreteTokens[attachIdx + 1] if leaf field follows, or last concrete token)
  let leafIdx = -1;
  if (afterTokens.length > attachIdx + 1 && isParamToken(afterTokens[attachIdx + 1])) {
    leafIdx = Math.min(concreteTokens.length - 1, attachIdx + 1);
  } else if (concreteTokens.length - 1 > attachIdx) {
    const nextIdx = attachIdx + 1;
    leafIdx = nextIdx;
  } else {
    leafIdx = concreteTokens.length - 1;
  }

  // Collect container parameter indices strictly before attachIdx
  const containerIndices = [];
  for (let i = 0; i < attachIdx; i += 1) {
    const bTok = beforeTokens[i] || '';
    const aTok = afterTokens[i] || '';
    if (isParamToken(bTok) || isParamToken(aTok)) {
      containerIndices.push(i);
    }
  }
  // If no explicit wildcard before attachIdx, highlight the primary container ID if path is deep (e.g. col/id/subcol/id)
  if (containerIndices.length === 0 && attachIdx >= 2) {
    const candidateIdx = concreteTokens[1] && !/^(spaces|data|v1|app)$/i.test(concreteTokens[1]) ? 1 : concreteTokens[2] && 2 < attachIdx ? 2 : -1;
    if (candidateIdx >= 0) {
      containerIndices.push(candidateIdx);
    }
  }
  // Keep at most the most relevant container parameter so we never have more than 3 callouts
  const selectedContainerIdx = containerIndices.length > 0 ? containerIndices[containerIndices.length - 1] : -1;

  const nounPlural = inferCollectionNoun(targetPath, beforeRuleAnchored);
  const nounSingular = singularizeToken(nounPlural);

  return concreteTokens.map((concreteVal, idx) => {
    const bTok = beforeTokens[idx] || '';
    const aTok = afterTokens[idx] || '';
    const prevConcrete = idx > 0 ? concreteTokens[idx - 1] : '';
    const inferredWildcard = prevConcrete ? wildcardByParent.get(prevConcrete) || '' : '';
    const rawParam = isParamToken(bTok)
      ? bTok
      : isParamToken(aTok)
        ? aTok
        : inferredWildcard;
    const containsVictim =
      Boolean(uidLower) &&
      (concreteVal.toLowerCase() === uidLower || concreteVal.toLowerCase().includes(uidLower));

    let displayText = rawParam || concreteVal;
    let isParam = Boolean(rawParam);
    let callout = null;

    if (idx === leafIdx) {
      if (!isParam) {
        const baseNoun = prevConcrete && !isParamToken(beforeTokens[idx - 1] || '')
          ? singularizeToken(humanizeToken(prevConcrete, nounSingular).replace(/\bhistory\b/i, '').trim() || nounSingular).replace(/\s+/g, '')
          : nounSingular;
        displayText = `$${baseNoun || 'record'}id`;
        isParam = true;
      }
      callout = {
        label: idx < concreteTokens.length - 1 ? 'Target record' : 'Target leaf',
        detail:
          copy?.targetContext ||
          (victimUid
            ? `Authored by ${victimUid} (${concreteVal})`
            : `Written directly by ${attackerUid} (${concreteVal})`),
      };
    } else if (idx === attachIdx) {
      callout = {
        label: leafIdx === attachIdx ? 'Rule and target node' : 'Write rule attaches here',
        detail:
          leafIdx === attachIdx
            ? `Checked here without owner verification (${concreteVal})`
            : `Applies to all child nodes (${concreteVal})`,
      };
    } else if (idx === selectedContainerIdx) {
      const parentWord = singularizeToken(humanizeToken(prevConcrete || 'container', 'container'));
      if (!isParam && prevConcrete) {
        displayText = `$${parentWord.replace(/\s+/g, '') || 'container'}id`;
        isParam = true;
      }
      callout = containsVictim
        ? {
            label: `${victimName}'s ${parentWord}`,
            detail: `Scoped to ${victimUid} (${concreteVal})`,
          }
        : {
            label: 'Shared container',
            detail: `Both ${victimName} and ${attackerName} are members (${concreteVal})`,
          };
    }

    return {
      text: displayText,
      concreteValue: concreteVal,
      isParam,
      callout,
    };
  });
}

function derivePathSegments({
  targetPath,
  copy,
  victimName,
  victimUid,
  attackerName,
  attackerUid,
  beforeRuleShortPath,
}) {
  if (Array.isArray(copy?.pathSegments) && copy.pathSegments.length > 0) {
    return copy.pathSegments.map((item) => ({
      path: item.path,
      label: item.label,
      detail: item.detail || '',
      tone: item.tone || 'neutral',
    }));
  }

  const cleanTarget = String(targetPath || '/target').trim();
  const strippedTarget = cleanTarget.replace(/^\/databases\/[^/]+\/documents/, '') || cleanTarget;
  const tokens = strippedTarget.split('/').filter(Boolean);

  if (tokens.length === 0) {
    return [
      {
        path: cleanTarget || '/target',
        label: 'Target database path',
        detail: copy?.targetContext || `Written directly by ${attackerUid}`,
        tone: 'danger',
      },
    ];
  }

  return [
    {
      path: strippedTarget.startsWith('/') ? strippedTarget : `/${strippedTarget}`,
      label: victimUid ? `${victimName}'s target path (${victimUid})` : 'Target path',
      detail: copy?.targetContext || `Targeted directly by ${attackerUid}`,
      tone: 'neutral',
    },
  ];
}

function splitTopLevelAndClauses(ruleBody) {
  let inner = String(ruleBody || '').trim();
  const quoteMatch = /^"(?:\.write|\.read|\.validate)"\s*:\s*"([\s\S]+)"$/.exec(inner);
  if (quoteMatch) {
    inner = quoteMatch[1];
  }
  const allowMatch = /^allow\s+[^:]+:\s*if\s+([\s\S]+?);?$/.exec(inner);
  if (allowMatch) {
    inner = allowMatch[1];
  }

  const parts = [];
  let depth = 0;
  let inSingleQuote = false;
  let start = 0;

  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === "'" && inner[i - 1] !== '\\') {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (inSingleQuote) continue;
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === '&' && inner[i + 1] === '&') {
      parts.push(inner.slice(start, i).trim());
      start = i + 2;
      i += 1;
    }
  }
  const tail = inner.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function compactRuleChain(expr) {
  let s = String(expr || '').trim().replace(/\s+/g, ' ');
  s = s.replace(/\/databases\/\$\(database\)\/documents\//g, '.../');
  s = s.replace(/root(?:\.child\(([^)]+)\))+/g, (full) => {
    const segments = [];
    const childRe = /\.child\(([^)]+)\)/g;
    let m;
    while ((m = childRe.exec(full)) !== null) {
      segments.push(m[1].replace(/^'|'$/g, ''));
    }
    if (segments.length <= 2) {
      return segments.join('/');
    }
    const tail = segments.slice(-3);
    return `.../${tail.join('/')}`;
  });
  s = s.replace(/data(?:\.child\(([^)]+)\)){2,}/g, (full) => {
    const segments = [];
    const childRe = /\.child\(([^)]+)\)/g;
    let m;
    while ((m = childRe.exec(full)) !== null) {
      segments.push(m[1].replace(/^'|'$/g, ''));
    }
    return `data.child('${segments.join('/')}')`;
  });
  return s;
}

function distillRuleLines(rawRuleBody, { maxLines = 4 } = {}) {
  const rawClauses = splitTopLevelAndClauses(rawRuleBody);
  if (rawClauses.length === 0) {
    const single = compactRuleChain(rawRuleBody);
    return single ? [single] : [];
  }

  const compactClauses = rawClauses.map((c) => compactRuleChain(c));
  const merged = [];
  for (const c of compactClauses) {
    const isShortAuth = /^auth\b|^request\.auth\b/.test(c) && !c.includes('.../') && c.length <= 36;
    if (
      merged.length > 0 &&
      isShortAuth &&
      merged[merged.length - 1].length + 4 + c.length <= 68
    ) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} && ${c}`;
    } else {
      merged.push(c);
    }
  }

  const trimmed = merged.slice(0, maxLines);
  return trimmed.map((line, idx) => {
    if (idx === 0) return line;
    return line.startsWith('&&') ? line : `&& ${line}`;
  });
}

function analyzeRuleClauses({
  vulnerableRuleBody,
  fixedRuleBody,
  attackerUid,
  targetPath,
}) {
  const beforeClauses = splitTopLevelAndClauses(vulnerableRuleBody);
  const afterClauses = splitTopLevelAndClauses(fixedRuleBody);
  const beforeNormalized = new Set(beforeClauses.map((c) => compactRuleChain(c)));
  const addedCompact = afterClauses
    .map((c) => compactRuleChain(c))
    .filter((c) => !beforeNormalized.has(c));

  const addedOwnerClause =
    addedCompact.find((c) => /speaker|author|owner|createdBy|userId|uid|!data\.exists|request\.resource/i.test(c)) ||
    addedCompact[0] ||
    (!beforeClauses.some((c) => /speaker|author|owner|createdBy|userId/i.test(c))
      ? `!data.exists() || data.child('owner/uid').val() == auth.uid`
      : '');

  return {
    beforeLines: distillRuleLines(vulnerableRuleBody),
    afterLines: distillRuleLines(fixedRuleBody, { maxLines: 6 }),
    addedOwnerClause,
    addedCompactSet: new Set(addedCompact),
  };
}

function buildRuleTreeStructure({
  parsedBefore,
  parsedAfter,
  beforeRuleAnchored,
  afterRuleAnchored,
  pathTokens,
  beforeLines,
  afterLines,
  addedCompactSet,
}) {
  const beforeTokens = String(parsedBefore.nodePath || beforeRuleAnchored || '')
    .split('/')
    .filter(Boolean);
  const afterTokens = String(parsedAfter.nodePath || afterRuleAnchored || '')
    .split('/')
    .filter(Boolean);

  const beforeAttachNode = beforeTokens[beforeTokens.length - 1] || '$target';
  const beforeParentNode =
    beforeTokens.length >= 2 && !/^[$@]/.test(beforeTokens[beforeTokens.length - 2])
      ? beforeTokens[beforeTokens.length - 2]
      : '';

  const leafParamToken =
    (pathTokens || []).find(
      (t) => t.callout?.label === 'Target record' || t.callout?.label === 'Target leaf',
    )?.text || '';
  let afterAttachNode = afterTokens[afterTokens.length - 1] || leafParamToken || beforeAttachNode;
  if (afterAttachNode === beforeAttachNode && leafParamToken && leafParamToken !== beforeAttachNode) {
    afterAttachNode = leafParamToken;
  }

  const ruleMovesDeeper = Boolean(afterAttachNode && afterAttachNode !== beforeAttachNode);

  // Why-slide tree: shows hierarchy where .write attaches and where the write actually lands
  const whyTree = [];
  let indentCursor = 0;
  if (beforeParentNode) {
    whyTree.push({
      indent: indentCursor,
      node: beforeParentNode,
      ruleKey: '',
      ruleLines: [],
      note: '',
      muted: true,
    });
    indentCursor += 1;
  }

  whyTree.push({
    indent: indentCursor,
    node: beforeAttachNode,
    ruleKey: '.write',
    ruleLines: beforeLines,
    note: ruleMovesDeeper ? 'Rule attached here' : 'Rule evaluated here (no author check)',
    isAttachPoint: true,
    isFlawHighlight: !ruleMovesDeeper,
  });

  if (ruleMovesDeeper) {
    whyTree.push({
      indent: indentCursor + 1,
      node: afterAttachNode,
      ruleKey: '',
      ruleLines: [],
      note: 'no rule — inherits parent .write without author check',
      isInheritedGap: true,
      isFlawHighlight: true,
    });
  }

  // Fix-slide Before vs After trees: compact 3-line summary + highlighted new ownership predicate
  const compactBeforeForDiff = beforeLines.length > 3
    ? [beforeLines[0], beforeLines[1], beforeLines[beforeLines.length - 1]]
    : beforeLines;
  const addedAfterLines = afterLines.filter((line) => {
    const bare = line.replace(/^&&\s*/, '').trim();
    return (
      addedCompactSet.has(bare) ||
      /!data\.exists|speaker|author|owner|createdBy|userId|request\.resource/i.test(bare)
    );
  });
  const sharedAfterLines = afterLines.filter((line) => !addedAfterLines.includes(line));
  const baseAfterForDiff = sharedAfterLines.length > 3
    ? [sharedAfterLines[0], sharedAfterLines[1], sharedAfterLines[sharedAfterLines.length - 1]]
    : sharedAfterLines;
  const compactAfterForDiff = [...baseAfterForDiff, ...addedAfterLines.slice(0, 2)];

  const beforeDiffTree = [
    {
      indent: 0,
      node: beforeAttachNode,
      ruleKey: '.write',
      note: ruleMovesDeeper ? 'Attached too high (only checks membership)' : 'Only checks membership',
      ruleLines: compactBeforeForDiff.map((text) => ({ text, highlight: false })),
    },
    ...(ruleMovesDeeper
      ? [
          {
            indent: 1,
            node: afterAttachNode,
            note: 'no author check — inherits parent .write',
            isFlawHighlight: true,
          },
        ]
      : []),
  ];

  const afterDiffTree = [];
  if (ruleMovesDeeper) {
    afterDiffTree.push({
      indent: 0,
      node: beforeAttachNode,
      note: '(delegates to child)',
      muted: true,
    });
  }
  afterDiffTree.push({
    indent: ruleMovesDeeper ? 1 : 0,
    node: afterAttachNode || beforeAttachNode,
    ruleKey: '.write',
    note: ruleMovesDeeper ? 'Moved here + author check added' : 'Author check added',
    isFixNodeHighlight: true,
    ruleLines: compactAfterForDiff.map((text) => {
      const bare = text.replace(/^&&\s*/, '').trim();
      const highlight =
        addedCompactSet.has(bare) ||
        /!data\.exists|speaker|author|owner|createdBy|userId|request\.resource/i.test(bare);
      return { text, highlight };
    }),
  });

  return {
    beforeAttachNode,
    afterAttachNode,
    ruleMovesDeeper,
    whyTree,
    beforeDiffTree,
    afterDiffTree,
  };
}

function eventMs(ev, key, fallback) {
  if (typeof ev?.[key] === 'number') return ev[key];
  const t = getEventTimeMs(ev);
  return t ?? fallback;
}

function behaviorPathTokens(pathTemplate, values = {}, callouts = {}) {
  return String(pathTemplate || '')
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      const isParam = seg.startsWith('$');
      return {
        text: seg,
        concreteValue: isParam ? String(values[seg] ?? seg) : seg,
        isParam,
        callout: isParam && callouts[seg] ? callouts[seg] : null,
      };
    });
}

/**
 * Deck for behavior findings (app-code fixes): the same 8-beat story, but the
 * "rule" slides show an order of operations and the before/after videos come
 * from two app builds recorded back to back.
 */
// Delay after actor views are ready before the attach-demo slide may start.
const UI_READY_SETTLE_MS = 150;

function buildBehaviorDeck({ scenario, eventList, captureMs, evidence = null }) {
  const behavior = scenario.behavior || {};
  const copy = scenario.copy || {};
  const deck = behavior.deck || {};
  const controlEvent = findEventForPhase(eventList, ['control']);
  const exploitEvent = findEventForPhase(eventList, ['exploit']);
  const fixEvent = findEventForPhase(eventList, ['fix']);
  const rawCapMs = Math.max(captureMs || 0, 3000);
  const uiFocus = evidence?.uiFocus || {};

  const victimName = scenario?.actors?.victim?.name || 'Alice';
  const victimUid = scenario?.actors?.victim?.uid || 'alice';
  const observerName = scenario?.actors?.attacker?.name || 'Bob';
  const observerUid = scenario?.actors?.attacker?.uid || 'bob';

  const pathTemplate = behavior.pathTemplate || behavior.check?.path || '/';
  const pathValues = behavior.pathValues || {};
  const pathTokens = behaviorPathTokens(pathTemplate, pathValues, behavior.pathCallouts || {});
  const targetPath = pathTemplate.replace(/^\/+/, '');
  const watchMethod = behavior.watchMethod || 'onValue';

  const controlMs = eventMs(controlEvent, 'settledAtMs', Math.round(rawCapMs * 0.2));
  const exDispatch = eventMs(exploitEvent, 'dispatchedAtMs', Math.round(rawCapMs * 0.35));
  const exSettled = Math.min(rawCapMs, eventMs(exploitEvent, 'settledAtMs', exDispatch + 2500));
  const fxDispatch = eventMs(fixEvent, 'dispatchedAtMs', Math.round(rawCapMs * 0.8));
  const fxExec = eventMs(fixEvent, 'executedAtMs', fxDispatch + 800);
  const fxSettled = Math.min(rawCapMs, eventMs(fixEvent, 'settledAtMs', fxExec + 1500));

  // Never open the demo before both actor views are signed in and prepared
  // (controlEvent.uiReadyAtMs); older bundles without it keep the old start.
  const uiReadyAtMs = typeof controlEvent?.uiReadyAtMs === 'number' ? controlEvent.uiReadyAtMs : null;
  const attachStart = Math.max(0, controlMs - 2200, uiReadyAtMs != null ? uiReadyAtMs + UI_READY_SETTLE_MS : 0);
  const attachEnd = Math.max(attachStart + 400, controlMs + 300);
  const exStart = Math.max(attachEnd, exDispatch - 900);
  const exPlayMs = 3600;
  const exImpactSec = Number(
    Math.max(0.5, Math.min(3.0, ((exDispatch + 700 - exStart) / Math.max(1, exSettled - exStart)) * (exPlayMs / 1000))).toFixed(2),
  );
  const fxStart = Math.max(exSettled, fxDispatch - 900);
  const fxPlayMs = 3300;
  const fxImpactSec = Number(
    Math.max(0.5, Math.min(2.8, ((fxExec - fxStart) / Math.max(1, fxSettled - fxStart)) * (fxPlayMs / 1000))).toFixed(2),
  );

  const wire = (decision, caption) => ({
    caller: observerUid,
    method: watchMethod,
    targetPath,
    pathTokens,
    ruleNode: '',
    decision,
    caption,
  });

  const slideDefs = [
    {
      id: 'title',
      kind: 'slide',
      variant: 'title',
      phase: 'hook',
      durationMs: 1700,
      title: copy.title,
      subtitle: copy.exploit,
      sourceStartMs: attachStart,
      sourceEndMs: attachStart,
      playDurationMs: 0,
    },
    {
      id: 'attach-demo',
      kind: 'video',
      variant: 'video',
      phase: 'hook',
      durationMs: 2600,
      title: deck.attachTitle || `${victimName} and ${observerName} are in the same space`,
      impactOffsetSec: 0.35,
      actionStatusPending: `Signed in as ${victimUid} and ${observerUid}`,
      actionStatusImpact: deck.attachStatus || `${observerName} sees ${victimName} here`,
      actorStatus: { role: 'attacker', text: `Sees ${victimName}`, tone: 'neutral' },
      uiOverlays: {
        focus: uiFocus.control || null,
        before: {
          victim: { label: 'Signed in' },
          attacker: { label: `${victimName} is here` },
          wire: wire(`${victimName.toUpperCase()} LISTED`, ''),
        },
        after: {
          victim: { label: 'Signed in' },
          attacker: { label: `${victimName} is here` },
          wire: wire(`${victimName.toUpperCase()} LISTED`, ''),
        },
      },
      sourceStartMs: attachStart,
      sourceEndMs: attachEnd,
      playDurationMs: 2300,
    },
    {
      id: 'path-slide',
      kind: 'slide',
      variant: 'path',
      phase: 'hook',
      durationMs: 3800,
      title: copy.pathTitle || 'Where presence lives',
      subtitle: copy.pathContext || '',
      targetPath: pathTemplate,
      pathTokens,
      sourceStartMs: attachEnd,
      sourceEndMs: attachEnd,
      playDurationMs: 0,
    },
    {
      id: 'attack-slide',
      kind: 'slide',
      variant: 'attack',
      phase: 'exploit',
      durationMs: 3600,
      title: copy.attackTitle || `${victimName} signs out`,
      subtitle: copy.attackContext || '',
      kvRows: Array.isArray(deck.problemFacts) ? deck.problemFacts : [],
      sourceStartMs: exStart,
      sourceEndMs: exStart,
      playDurationMs: 0,
    },
    {
      id: 'exploit-video',
      kind: 'video',
      variant: 'video',
      phase: 'exploit',
      durationMs: 3900,
      title: deck.exploitTitle || `${victimName} signs out. ${observerName} still sees her.`,
      impactOffsetSec: exImpactSec,
      actionStatusPending: `${victimName} clicks Sign out`,
      actionStatusImpact: deck.exploitStatus || `${victimName}'s entry is still in the list`,
      actorStatus: { role: 'attacker', text: `Still sees ${victimName}`, tone: 'neutral' },
      uiOverlays: {
        focus: uiFocus.exploitPre || uiFocus.control || null,
        focusAfter: uiFocus.exploitPost || uiFocus.exploitPre || null,
        before: {
          victim: { label: 'Signing out' },
          attacker: { label: `${victimName} is here` },
          wire: wire(`${victimName.toUpperCase()} LISTED`, ''),
        },
        after: {
          victim: { label: 'Signed out' },
          attacker: { label: `${victimName} still listed` },
          wire: wire('STILL LISTED', ''),
        },
      },
      sourceStartMs: exStart,
      sourceEndMs: exSettled,
      playDurationMs: exPlayMs,
    },
    {
      id: 'why-slide',
      kind: 'slide',
      variant: 'sequence',
      phase: 'exploit',
      durationMs: 4200,
      title: copy.whyTitle || 'Why the entry stays',
      subtitle: copy.why,
      sequence: Array.isArray(deck.beforeSequence) ? deck.beforeSequence : [],
      sourceStartMs: exSettled,
      sourceEndMs: exSettled,
      playDurationMs: 0,
    },
  ];

  if (fixEvent) {
    slideDefs.push(
      {
        id: 'fix-slide',
        kind: 'slide',
        variant: 'sequence',
        phase: 'fix',
        durationMs: 4200,
        title: copy.fixTitle || 'Clean up first, then sign out',
        subtitle: copy.fixContext || '',
        beforeSequence: Array.isArray(deck.beforeSequenceCompact) ? deck.beforeSequenceCompact : deck.beforeSequence,
        afterSequence: Array.isArray(deck.afterSequence) ? deck.afterSequence : [],
        sourceStartMs: fxStart,
        sourceEndMs: fxStart,
        playDurationMs: 0,
      },
      {
        id: 'fix-video',
        kind: 'video',
        variant: 'video',
        phase: 'fix',
        durationMs: 3600,
        title: deck.fixVideoTitle || `With the fix, ${victimName} leaves cleanly`,
        impactOffsetSec: fxImpactSec,
        actionStatusPending: `${victimName} clicks Sign out`,
        actionStatusImpact: deck.fixStatus || `${victimName}'s entry is removed`,
        actorStatus: { role: 'attacker', text: `${victimName} gone`, tone: 'neutral' },
        uiOverlays: {
          focus: uiFocus.fixPre || null,
          focusAfter: uiFocus.fixPost || uiFocus.fixPre || null,
          before: {
            victim: { label: 'Signing out' },
            attacker: { label: `${victimName} is here` },
            wire: wire(`${victimName.toUpperCase()} LISTED`, ''),
          },
          after: {
            victim: { label: 'Signed out' },
            attacker: { label: `${victimName} removed` },
            wire: wire('REMOVED', ''),
          },
        },
        sourceStartMs: fxStart,
        sourceEndMs: fxSettled,
        playDurationMs: fxPlayMs,
      },
    );
  }

  const slides = [];
  let cursorMs = 0;
  for (const def of slideDefs) {
    const startMs = cursorMs;
    const endMs = cursorMs + def.durationMs;
    cursorMs = endMs;
    slides.push({ ...def, startMs, endMs, startSec: startMs / 1000, endSec: endMs / 1000 });
  }
  return { slides, totalMs: cursorMs, totalSec: cursorMs / 1000 };
}

function buildPresentationDeck({ scenario, eventList, beats, captureMs, evidence = null }) {
  const showTitleCard = scenario?.stage?.slots?.showTitleCard !== false;
  const showOutroCard = scenario?.stage?.slots?.showOutroCard !== false;
  if (!showTitleCard && !showOutroCard) {
    return null;
  }
  if (scenario?.behavior) {
    return buildBehaviorDeck({ scenario, eventList, captureMs, evidence });
  }

  const controlEvent = findEventForPhase(eventList, ['control', 'hook', 'setup', 'baseline']);
  const exploitEvent = findEventForPhase(eventList, ['exploit', 'mutation', 'attack']);
  const fixEvent = findEventForPhase(eventList, ['fix', 'verify', 'patched']);

  const exploitBeat = beats.find((b) => b.id === 'exploit') || beats[0];
  const fixBeat = beats.find((b) => b.id === 'fix');

  const rawCapMs = Math.max(captureMs || 0, beats[beats.length - 1]?.endMs || 3000);
  const controlExecMs =
    typeof controlEvent?.settledAtMs === 'number'
      ? controlEvent.settledAtMs
      : typeof controlEvent?.executedAtMs === 'number'
        ? controlEvent.executedAtMs
        : (getEventTimeMs(controlEvent) ?? Math.round(rawCapMs * 0.2));

  const exploitStartMs = getEventTimeMs(exploitEvent) ?? Math.round(rawCapMs * 0.35);
  const exploitDispatchMs =
    typeof exploitEvent?.dispatchedAtMs === 'number'
      ? exploitEvent.dispatchedAtMs
      : typeof exploitEvent?.executedAtMs === 'number'
        ? exploitEvent.executedAtMs
        : exploitStartMs;
  const exploitExecMs =
    typeof exploitEvent?.executedAtMs === 'number'
      ? exploitEvent.executedAtMs
      : exploitDispatchMs;
  const fixStartMs = getEventTimeMs(fixEvent) ?? rawCapMs;
  const fixDispatchMs =
    typeof fixEvent?.dispatchedAtMs === 'number'
      ? fixEvent.dispatchedAtMs
      : typeof fixEvent?.executedAtMs === 'number'
        ? fixEvent.executedAtMs
        : fixStartMs;
  const fixExecMs =
    typeof fixEvent?.executedAtMs === 'number'
      ? fixEvent.executedAtMs
      : fixDispatchMs;

  const preFixBoundMs = fixEvent ? Math.max(exploitExecMs + 250, fixStartMs - 150) : rawCapMs;
  const exploitSettledMs =
    typeof exploitEvent?.settledAtMs === 'number'
      ? Math.min(preFixBoundMs, Math.max(exploitEvent.settledAtMs + 1400, exploitExecMs + 1600))
      : Math.min(preFixBoundMs, exploitExecMs + 1800);
  const fixSettledMs = Math.min(rawCapMs, Math.max(fixExecMs + 1100, rawCapMs - 120));

  const minPostControlMs = controlEvent ? Math.min(exploitDispatchMs, controlExecMs + 300) : 0;
  const exploitVideoStartMs = Math.max(minPostControlMs, exploitDispatchMs - 1350);
  const exploitImpactMs =
    typeof exploitEvent?.settledAtMs === 'number'
      ? Math.round((exploitDispatchMs + exploitEvent.settledAtMs) / 2)
      : exploitExecMs;
  const exploitPlayMs = 3300;
  const exploitTotalMs = 3600;
  const exploitVideoSpan = Math.max(1, exploitSettledMs - exploitVideoStartMs);
  const exploitImpactOffsetSec = Number(
    (
      Math.max(0.4, Math.min(2.4, ((exploitImpactMs - exploitVideoStartMs) / exploitVideoSpan) * (exploitPlayMs / 1000)))
    ).toFixed(2),
  );

  // Never open the demo before every actor view is signed in and prepared
  // (controlEvent.uiReadyAtMs); older bundles without it start at 0.
  const uiReadyAtMs = typeof controlEvent?.uiReadyAtMs === 'number' ? controlEvent.uiReadyAtMs : null;
  const attachStartMs = uiReadyAtMs != null ? Math.max(0, uiReadyAtMs + UI_READY_SETTLE_MS) : 0;
  const attachEndMs = Math.max(
    attachStartMs + 400,
    700,
    Math.min(exploitVideoStartMs, controlExecMs > 0 ? controlExecMs + 500 : exploitVideoStartMs),
  );
  const attachTotalMs = 2500;
  const attachPlayMs = 2200;

  const fixVideoStartMs = Math.max(preFixBoundMs, fixDispatchMs - 1100);
  const fixPlayMs = 2600;
  const fixTotalMs = 2900;
  const fixVideoSpan = Math.max(1, fixSettledMs - fixVideoStartMs);
  const fixImpactOffsetSec = Number(
    (
      Math.max(0.35, Math.min(2.0, ((fixExecMs - fixVideoStartMs) / fixVideoSpan) * (fixPlayMs / 1000)))
    ).toFixed(2),
  );

  const victimName = scenario?.actors?.victim?.name || scenario?.actors?.victim?.uid || 'Alice';
  const victimUid = scenario?.actors?.victim?.uid || 'alice';
  const attackerName = scenario?.actors?.attacker?.name || scenario?.actors?.attacker?.uid || 'Bob';
  const attackerUid = scenario?.actors?.attacker?.uid || 'bob';

  const service = exploitEvent?.service || 'database';
  const serviceName = formatServiceDisplayName(service);
  const targetPath = exploitEvent?.path || '/target';
  const sdkCall = exploitBeat?.sdkCall || `database.set('${targetPath}', ...)`;
  const vulnerableRule =
    (typeof evidence?.fixRules?.beforeFull === 'string' && evidence.fixRules.beforeFull.trim()) ||
    (typeof scenario?.fixRules?.before === 'string' && scenario.fixRules.before.trim()) ||
    exploitBeat?.matchedRule ||
    '".write": "auth != null"';
  const fixedRule =
    (typeof evidence?.fixRules?.afterFull === 'string' && evidence.fixRules.afterFull.trim()) ||
    (typeof scenario?.fixRules?.after === 'string' && scenario.fixRules.after.trim()) ||
    fixBeat?.matchedRule ||
    '';
  const hasFix = Boolean(fixBeat);

  const parsedBefore = parseRuleEntry(vulnerableRule);
  const parsedAfter = parseRuleEntry(fixedRule);
  const beforeRuleAnchored =
    scenario?.copy?.rulePathBefore ||
    resolveAnchoredRulePath(parsedBefore.nodePath, targetPath);
  const afterRuleAnchored =
    scenario?.copy?.rulePathAfter ||
    (fixedRule ? resolveAnchoredRulePath(parsedAfter.nodePath, targetPath, beforeRuleAnchored) : '');

  const pathTokens = derivePathTokens({
    targetPath,
    beforeRuleAnchored,
    afterRuleAnchored,
    vulnerableRule,
    fixedRule,
    copy: scenario?.copy,
    victimName,
    victimUid,
    attackerName,
    attackerUid,
  });

  const pathSegments = derivePathSegments({
    targetPath,
    copy: scenario?.copy,
    victimName,
    victimUid,
    attackerName,
    attackerUid,
    beforeRuleShortPath: parsedBefore.nodePath,
  });

  const {
    beforeLines,
    afterLines,
    addedOwnerClause,
    addedCompactSet,
  } = analyzeRuleClauses({
    vulnerableRuleBody: parsedBefore.body || vulnerableRule,
    fixedRuleBody: parsedAfter.body || fixedRule,
    attackerUid,
    targetPath,
  });

  const {
    beforeAttachNode,
    afterAttachNode,
    ruleMovesDeeper,
    whyTree,
    beforeDiffTree,
    afterDiffTree,
  } = buildRuleTreeStructure({
    parsedBefore,
    parsedAfter,
    beforeRuleAnchored,
    afterRuleAnchored,
    pathTokens,
    beforeLines,
    afterLines,
    addedCompactSet,
  });

  const nounPlural = inferCollectionNoun(targetPath, parsedBefore.nodePath);
  const nounSingular = singularizeToken(nounPlural);
  const rawTargetSegs = String(targetPath || '').split('/').filter(Boolean);
  const leafSegmentId = rawTargetSegs[rawTargetSegs.length - 1] || 'record';
  const sdkMethod = exploitEvent?.method || (service === 'firestore' ? 'setDoc' : 'set');
  const uiFocus = evidence?.uiFocus || {};

  const slideDefs = [
    {
      id: 'title',
      kind: 'slide',
      variant: 'title',
      phase: 'hook',
      durationMs: 1700,
      title: scenario?.copy?.title || 'Security rule vulnerability reproduction',
      subtitle:
        scenario?.copy?.exploit ||
        `${attackerName} can overwrite ${victimName}'s ${nounPlural} by targeting ${targetPath} directly with the ${serviceName} SDK.`,
      sourceStartMs: attachStartMs,
      sourceEndMs: attachStartMs,
      playDurationMs: 0,
    },
    {
      id: 'attach-demo',
      kind: 'video',
      variant: 'video',
      phase: 'hook',
      durationMs: attachTotalMs,
      title:
        scenario?.copy?.attachTitle ||
        `${victimName} writes a ${nounSingular} in the shared space`,
      impactOffsetSec: 0.35,
      actionStatusPending: `Connected as ${victimUid} and ${attackerUid}`,
      actionStatusImpact: `Write allowed under ${beforeAttachNode}`,
      actorStatus: { role: 'victim', text: 'Normal write', tone: 'neutral' },
      uiOverlays: {
        focus: uiFocus.control || uiFocus.exploitPre || uiFocus.exploitPost || null,
        before: {
          victim: { label: `${victimName}'s ${nounSingular} (${leafSegmentId})` },
          attacker: { label: `Synced view for ${attackerName}` },
          wire: {
            caller: victimUid,
            method: sdkMethod,
            targetPath,
            pathTokens,
            ruleNode: beforeAttachNode,
            decision: 'ALLOW',
            caption: `Written under ${beforeAttachNode}`,
          },
        },
        after: {
          victim: { label: `Node ${leafSegmentId} attached` },
          attacker: { label: `Shared node visible to ${attackerName}` },
          wire: {
            caller: victimUid,
            method: sdkMethod,
            targetPath,
            pathTokens,
            ruleNode: beforeAttachNode,
            decision: 'ALLOW',
            caption: `Write allowed by ${beforeAttachNode}`,
          },
        },
      },
      sourceStartMs: attachStartMs,
      sourceEndMs: attachEndMs,
      playDurationMs: attachPlayMs,
    },
    {
      id: 'path-slide',
      kind: 'slide',
      variant: 'path',
      phase: 'hook',
      durationMs: 3800,
      title: scenario?.copy?.pathTitle || `Where ${nounPlural} live`,
      subtitle:
        scenario?.copy?.pathContext ||
        (ruleMovesDeeper
          ? `Every ${nounSingular} sits inside a shared container. Because the write rule sits on ${beforeAttachNode}, any member inherits write permission to every child ${nounSingular}.`
          : `Writes target ${targetPath}, where the active rule checks container access without verifying who authored the ${nounSingular}.`),
      targetPath,
      pathTokens,
      pathSegments,
      sourceStartMs: exploitVideoStartMs,
      sourceEndMs: exploitVideoStartMs,
      playDurationMs: 0,
    },
    {
      id: 'attack-slide',
      kind: 'slide',
      variant: 'attack',
      phase: 'exploit',
      durationMs: 3600,
      title: scenario?.copy?.attackTitle || `Bypassing the UI as ${attackerName}`,
      subtitle:
        scenario?.copy?.attackContext ||
        `Signed in as ${attackerUid}, ${attackerName} calls the ${serviceName} SDK directly to overwrite ${victimName}'s existing ${nounSingular}.`,
      targetPath,
      pathTokens,
      callerSummary: victimUid
        ? `${attackerUid} (member of container, not author)`
        : `${attackerUid}`,
      code: sdkCall,
      sourceStartMs: exploitVideoStartMs,
      sourceEndMs: exploitVideoStartMs,
      playDurationMs: 0,
    },
    {
      id: 'exploit-video',
      kind: 'video',
      variant: 'video',
      phase: 'exploit',
      durationMs: exploitTotalMs,
      title: `${attackerName} overwrites ${victimName}'s ${nounSingular}`,
      impactOffsetSec: exploitImpactOffsetSec,
      actionStatusPending: `Sending ${service}.${exploitEvent?.method || 'set'} as ${attackerUid}`,
      actionStatusImpact: `Write allowed — updated in both views`,
      actorStatus: { role: 'attacker', text: 'Write allowed', tone: 'neutral' },
      uiOverlays: {
        focus: uiFocus.exploitPre || uiFocus.control || uiFocus.exploitPost || null,
        focusAfter: uiFocus.exploitPost || uiFocus.control || uiFocus.exploitPre || null,
        before: {
          victim: { label: `${victimName}'s ${nounSingular} (${leafSegmentId})` },
          attacker: { label: `Targeting ${leafSegmentId} via SDK` },
          wire: {
            caller: attackerUid,
            method: sdkMethod,
            targetPath,
            pathTokens,
            ruleNode: beforeAttachNode,
            decision: 'ARMED',
            caption: `Direct ${sdkMethod}(...) bypassing UI`,
          },
        },
        after: {
          victim: { label: `Overwritten in ${victimName}'s UI` },
          attacker: { label: `Spoofed via direct SDK write` },
          wire: {
            caller: attackerUid,
            method: sdkMethod,
            targetPath,
            pathTokens,
            ruleNode: beforeAttachNode,
            decision: 'ALLOW',
            caption: `Allowed by ${beforeAttachNode} (no author check)`,
          },
        },
      },
      sourceStartMs: exploitVideoStartMs,
      sourceEndMs: exploitSettledMs,
      playDurationMs: exploitPlayMs,
    },
    {
      id: 'why-slide',
      kind: 'slide',
      variant: 'why',
      phase: 'exploit',
      durationMs: 3800,
      title: 'Why the database allowed it',
      subtitle:
        scenario?.copy?.why ||
        (ruleMovesDeeper
          ? `The write rule sits on ${beforeAttachNode} and only checks membership. Because rules cascade downward, any member can overwrite existing nodes under ${afterAttachNode}.`
          : `The write rule checks caller membership but never verifies whether the target node belongs to ${attackerUid}.`),
      targetPath,
      ruleTree: whyTree,
      missingCheck: {
        label: 'Missing check',
        code: scenario?.copy?.missingCheckCode || addedOwnerClause || `!data.exists() || data.child('owner/uid').val() == auth.uid`,
      },
      sourceStartMs: exploitSettledMs,
      sourceEndMs: exploitSettledMs,
      playDurationMs: 0,
    },
  ];

  // When assurance could not confirm the fix, the fix slides say so in one quiet line.
  const fixAssurance = evidence?.fixAssurance;
  const assuranceNote =
    fixAssurance && fixAssurance.verified === false && typeof fixAssurance.note === 'string'
      ? fixAssurance.note
      : null;
  const assuranceNoteField = assuranceNote ? { assuranceNote } : {};

  if (hasFix) {
    slideDefs.push(
      {
        id: 'fix-slide',
        kind: 'slide',
        variant: 'fix',
        phase: 'fix',
        durationMs: 3800,
        title:
          scenario?.copy?.fixTitle ||
          (ruleMovesDeeper
            ? `Scoping writes to the ${nounSingular} author`
            : `Enforcing ${nounSingular} ownership in rules`),
        subtitle:
          scenario?.copy?.fixContext ||
          (ruleMovesDeeper
            ? `Move .write down to ${afterAttachNode} and require a new record or a matching author UID.`
            : `Require a new record or a matching author UID on ${afterAttachNode} so callers can only modify their own data.`),
        targetPath,
        beforeDiffTree,
        afterDiffTree,
        ...assuranceNoteField,
        sourceStartMs: fixVideoStartMs,
        sourceEndMs: fixVideoStartMs,
        playDurationMs: 0,
      },
      {
        id: 'fix-video',
        kind: 'video',
        variant: 'video',
        phase: 'fix',
        durationMs: fixTotalMs,
        title: 'Unauthorized write blocked',
        impactOffsetSec: fixImpactOffsetSec,
        ...assuranceNoteField,
        actionStatusPending: `Re-running ${service}.${exploitEvent?.method || 'set'} as ${attackerUid}`,
        actionStatusImpact: `PERMISSION_DENIED — ${victimName}'s ${nounSingular} stays unchanged`,
        actorStatus: { role: 'attacker', text: 'Write denied', tone: 'neutral' },
        uiOverlays: {
          focus: uiFocus.fixPost || uiFocus.control || uiFocus.exploitPost || null,
          before: {
            victim: { label: `Protected ${nounSingular} (${leafSegmentId})` },
            attacker: { label: `Repeating ${sdkMethod}(...) as ${attackerUid}` },
            wire: {
              caller: attackerUid,
              method: sdkMethod,
              targetPath,
              pathTokens,
              ruleNode: afterAttachNode || beforeAttachNode,
              decision: 'ARMED',
              caption: `Re-testing write under ${afterAttachNode || beforeAttachNode}`,
            },
          },
          after: {
            victim: { label: `Unchanged in ${victimName}'s UI` },
            attacker: { label: `SDK write rejected` },
            wire: {
              caller: attackerUid,
              method: sdkMethod,
              targetPath,
              pathTokens,
              ruleNode: afterAttachNode || beforeAttachNode,
              decision: 'DENIED',
              caption: `Blocked at ${afterAttachNode || beforeAttachNode}`,
            },
          },
        },
        sourceStartMs: fixVideoStartMs,
        sourceEndMs: fixSettledMs,
        playDurationMs: fixPlayMs,
      },
    );
  }

  const slides = [];
  let cursorMs = 0;
  for (const def of slideDefs) {
    const startMs = cursorMs;
    const endMs = cursorMs + def.durationMs;
    cursorMs = endMs;
    slides.push({
      ...def,
      startMs,
      endMs,
      startSec: startMs / 1000,
      endSec: endMs / 1000,
    });
  }

  return {
    slides,
    totalMs: cursorMs,
    totalSec: cursorMs / 1000,
  };
}

/**
 * Map a presentation stage timestamp (ms) onto the corresponding raw capture
 * source timestamp (ms), smoothly playing active video windows and holding settled frames.
 */
export function mapPresentationTimeToSourceMs(presentation, stageMs) {
  const deck = presentation?.slides ? presentation : presentation?.presentation;
  const slides = deck?.slides;
  if (!Array.isArray(slides) || slides.length === 0) {
    return stageMs;
  }

  const clampedStageMs = Math.max(0, Math.min(deck.totalMs, stageMs));
  let active = slides[slides.length - 1];
  for (const s of slides) {
    if (clampedStageMs >= s.startMs && clampedStageMs < s.endMs) {
      active = s;
      break;
    }
  }

  const srcStart = typeof active.sourceStartMs === 'number' ? active.sourceStartMs : 0;
  const srcEnd = typeof active.sourceEndMs === 'number' ? active.sourceEndMs : srcStart;
  if (active.kind !== 'video' || srcEnd <= srcStart) {
    return srcEnd;
  }

  const elapsedInSlide = Math.max(0, clampedStageMs - active.startMs);
  const slideDuration = Math.max(1, active.endMs - active.startMs);
  const playWindow =
    typeof active.playDurationMs === 'number' && active.playDurationMs > 0
      ? Math.min(slideDuration, active.playDurationMs)
      : slideDuration;
  const progress = Math.min(1, elapsedInSlide / playWindow);
  return Math.round(srcStart + progress * (srcEnd - srcStart));
}

export function computeStageTimeline({ scenario, events, durationMs, evidence = null } = {}) {
  const eventList = normalizeEventsList(events);
  const beatDefs = buildBeatDefinitions(scenario, eventList);

  const captureMs = typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0
    ? durationMs
    : 0;
  const maxPlausibleEventMs = Math.max(600_000, captureMs * 4);

  let maxEventMs = 0;
  for (const ev of eventList) {
    const t = getEventTimeMs(ev);
    if (t !== null && t <= maxPlausibleEventMs && t > maxEventMs) {
      maxEventMs = t;
    }
  }
  const observedMs = Math.max(captureMs, maxEventMs);

  let totalMs;
  if (observedMs > 0) {
    totalMs = Math.max(MIN_TIMELINE_MS, Math.round(observedMs + DEFAULT_END_HOLD_MS));
  } else {
    const defaultSum = beatDefs.reduce((sum, b) => sum + b.defaultDurationMs, 0);
    totalMs = Math.max(MIN_TIMELINE_MS, defaultSum);
  }

  const durations = allocateBeatDurations(beatDefs, totalMs);
  const beats = [];
  let cursorMs = 0;

  for (let i = 0; i < beatDefs.length; i++) {
    const def = beatDefs[i];
    const startMs = cursorMs;
    const endMs = i === beatDefs.length - 1 ? totalMs : cursorMs + durations[i];
    cursorMs = endMs;

    beats.push({
      id: def.id,
      phase: def.phase,
      startMs,
      endMs,
      startSec: startMs / 1000,
      endSec: endMs / 1000,
      caption: def.caption,
      badgeText: def.badgeText,
      badgeTone: def.badgeTone,
      sdkCall: def.sdkCall,
      matchedRule: def.matchedRule,
    });
  }

  const presentation = buildPresentationDeck({
    scenario,
    eventList,
    beats,
    captureMs: observedMs,
    evidence,
  });

  return {
    beats,
    totalMs,
    totalSec: totalMs / 1000,
    ...(presentation ? { presentation } : {}),
  };
}

function normalizeSourceFrames(captureArtifact, extractedFrameMap, fallbackFps) {
  if (Array.isArray(extractedFrameMap) && extractedFrameMap.length > 0) {
    return extractedFrameMap;
  }
  if (extractedFrameMap && Array.isArray(extractedFrameMap.frames) && extractedFrameMap.frames.length > 0) {
    return extractedFrameMap.frames;
  }
  if (captureArtifact && Array.isArray(captureArtifact.frames) && captureArtifact.frames.length > 0) {
    return captureArtifact.frames;
  }
  if (extractedFrameMap && typeof extractedFrameMap === 'object') {
    const roles = Object.keys(extractedFrameMap).filter((k) => Array.isArray(extractedFrameMap[k]));
    if (roles.length > 0) {
      const count = extractedFrameMap[roles[0]].length;
      const frames = [];
      for (let i = 0; i < count; i++) {
        const files = {};
        for (const role of roles) {
          files[role] = extractedFrameMap[role][i];
        }
        frames.push({
          tMs: (i * 1000) / fallbackFps,
          files,
        });
      }
      return frames;
    }
  }
  return [];
}

function toStageFrameUrl(filePath, baseDir) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return '';
  }
  if (/^(https?:|file:|data:|\/__pyric_)/i.test(filePath)) {
    return filePath;
  }
  if (baseDir) {
    const resolvedBase = path.resolve(baseDir);
    const resolvedFile = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(resolvedBase, filePath);
    const rel = path.relative(resolvedBase, resolvedFile);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return `/${rel.split(path.sep).join('/')}`;
    }
  }
  return filePath.split(path.sep).join('/');
}

/**
 * Resample variable-rate CDP frames or extracted video frames onto a constant-frame-rate
 * timeline (`totalFrames = Math.max(1, Math.round((durationMs / 1000) * fps))`).
 */
export function buildResampledPassFrames({
  captureArtifact,
  extractedFrameMap,
  startMs = 0,
  durationMs,
  fps = 30,
  baseDir,
  presentation = null,
} = {}) {
  const effectiveDurationMs =
    typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0
      ? durationMs
      : (captureArtifact?.durationMs ?? MIN_TIMELINE_MS);

  const totalFrames = Math.max(1, Math.round((effectiveDurationMs / 1000) * fps));
  const sourceFps = captureArtifact?.fps ?? fps;
  const sourceFrames = normalizeSourceFrames(captureArtifact, extractedFrameMap, sourceFps);

  if (sourceFrames.length === 0) {
    return {
      fps,
      totalFrames,
      startMs,
      durationMs: effectiveDurationMs,
      frames: [],
    };
  }

  const perRoleUrls = {};
  const frames = [];

  for (let i = 0; i < totalFrames; i++) {
    const tMs = startMs + (i * 1000) / fps;
    const tSec = tMs / 1000;
    const lookupMs = presentation ? mapPresentationTimeToSourceMs(presentation, tMs) : tMs;
    const sampled = sampleFrameAtTime(sourceFrames, lookupMs);
    const mappedFiles = {};

    for (const [role, rawPath] of Object.entries(sampled.files || {})) {
      const url = toStageFrameUrl(rawPath, baseDir);
      mappedFiles[role] = url;
      if (!perRoleUrls[role]) {
        perRoleUrls[role] = [];
      }
      perRoleUrls[role].push(url);
    }

    frames.push({
      frameIndex: i,
      tMs,
      tSec,
      files: mappedFiles,
    });
  }

  return {
    fps,
    totalFrames,
    startMs,
    durationMs: effectiveDurationMs,
    ...perRoleUrls,
    frames,
  };
}

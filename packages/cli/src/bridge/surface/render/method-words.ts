/**
 * The three words each method's name is built from, for the surfaces that spell
 * one tool per method.
 *
 * The `verb-prefixed`, `noun-prefixed`, and `verb-suffixed` surfaces exist to
 * measure whether word order changes how well a model picks a tool, so the
 * words are the whole subject of the measurement and they are stated here, once,
 * rather than parsed out of a method name. Most methods reuse the canonical
 * operation's own words; the identity methods do not, because four of them
 * share one operation and each still needs a name of its own.
 */
import { METHODS } from '../methods/index.js';
import { operationIds } from '../method-types.js';

/** The verb, service, and object one method's names are spelled from. */
export interface MethodWords {
  verb: string;
  service: string;
  object: string;
}

/** The methods whose words are not the canonical operation's own. */
const OVERRIDES: Readonly<Record<string, MethodWords>> = {
  'auth.impersonate': { verb: 'impersonate', service: 'auth', object: 'user' },
  'auth.actAsAdmin': { verb: 'become', service: 'auth', object: 'admin' },
  'auth.actAsAnonymous': { verb: 'become', service: 'auth', object: 'anonymous' },
  'auth.useAppSession': { verb: 'adopt', service: 'auth', object: 'session' },
  'firestore.getDocs': { verb: 'read', service: 'firestore', object: 'collection' },
  'rules.lint': { verb: 'lint', service: 'rules', object: 'source' },
  'rules.simulate': { verb: 'simulate', service: 'rules', object: 'request' },
  'rules.set': { verb: 'set', service: 'rules', object: 'source' },
};

/** The words a canonical id carries, which is `verb_service_object` by construction. */
function fromCanonicalId(id: string): MethodWords {
  const [verb, service, ...rest] = id.split('_');
  return { verb: verb!, service: service!, object: rest.join('_') };
}

function loadWords(): ReadonlyMap<string, MethodWords> {
  const words = new Map<string, MethodWords>();
  const claimed = new Set<string>();
  for (const method of METHODS) {
    const override = OVERRIDES[method.key];
    const ids = operationIds(method);
    const chosen = override ?? fromCanonicalId(ids[0]!);
    const name = `${chosen.verb}_${chosen.service}_${chosen.object}`;
    if (claimed.has(name)) throw new Error(`method words '${name}' are claimed twice`);
    claimed.add(name);
    words.set(method.key, chosen);
  }
  return words;
}

const WORDS = loadWords();

/** The words one method is named from. */
export function wordsFor(key: string): MethodWords {
  const words = WORDS.get(key);
  if (words === undefined) throw new Error(`no name words for method '${key}'`);
  return words;
}

/**
 * `Seed` sub-tab of the Firebase panel (SF-S2) — the host-owned,
 * USER-facing data-seed surface. The data parallel to the Auth tab:
 * where Auth lets the operator populate the sandbox's identity store,
 * this lets the operator populate the sandbox's Firestore with demo
 * data quickly — pick a collection, paste/enter documents as JSON,
 * apply. It is the human analog of the agent's
 * `seed_firestore_data_as_admin` tool: same effect (admin-bypass writes
 * that persist per session), human-driven.
 *
 * Why a separate tab from Data (FirestoreTab): the Data tab BROWSES and
 * edits one document at a time (a Firebase-Console analog). This is for
 * QUICK POPULATION — drop a whole collection in one shot. They share
 * the admin-write path; this is the "fill it fast" front door.
 *
 * Strictly session-scoped + ephemeral (app-spec section 3.6): writes go
 * through the active playground runtime, so shared Studio sessions use
 * the SharedWorker and isolated sessions use their in-process runner.
 * NOTHING here writes a workspace file or a spec field; this is
 * runtime state, never an artifact, never generated app code.
 *
 * Styling follows the house tab idiom (dark theme, `[data-pyric-*]`
 * tokens) — same skin language as AuthTab / FirestoreTab.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '@pyric/ui/primitives';

import { applySeedProposal } from '~/lib/seed-generator/apply-proposal';
import { buildSeedContextBundle } from '~/lib/seed-generator/context';
import { generateSeedProposal } from '~/lib/seed-generator/generate';
import { parseSeedProposal } from '~/lib/seed-generator/parse';
import type { SeedProposalV1 } from '~/lib/seed-generator/schema';
import { getPlaygroundRuntime } from '~/lib/sandbox/runtime';
import {
  applySeedAsync,
  clearCollectionAsync,
  isValidCollectionId,
  listSeededAsync,
  parseSeedJson,
} from '~/lib/sandbox/seed-apply';
import { useSeedGeneratorStore } from '~/lib/store/seed-generator';
import { useLlmStore } from '~/lib/store/llm';
import { PROVIDERS } from '~/lib/llm/registry';

import { SeedGenerationCard } from './SeedGenerationCard';

const INPUT_CLS =
  'w-full min-w-0 rounded-lg border border-[#2a2a35] bg-content-bg px-3 py-2 ' +
  'text-[13px] text-soft-white placeholder:text-slate-gray/70 outline-none ' +
  'focus:border-[#4a4a5a] transition-colors';

/** A starter blob so the empty state teaches the accepted JSON shapes. */
const PLACEHOLDER_JSON = `{
  "latte":     { "name": "Latte", "price": 5 },
  "cold-brew": { "name": "Cold Brew", "price": 4 }
}

— or an array (ids auto-generate):
[ { "name": "Espresso", "price": 3 } ]`;

function ContextChip({ label, active }: { label: string; active: boolean }) {
  return (
    <span
      className={[
        'rounded border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide',
        active
          ? 'border-[#5b5bd6]/50 text-[#a8a8ff]'
          : 'border-[#2a2a35]/60 text-slate-gray/50',
      ].join(' ')}
    >
      {label}
    </span>
  );
}

/** Pull root-collection ids out of the runner's flat snapshot — feeds
 *  the datalist so the user can reseed an existing collection without
 *  retyping it (and the "what's seeded" readout below). */
function rootCollectionIds(state: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  for (const path of Object.keys(state)) {
    const first = path.split('/', 1)[0];
    if (first) seen.add(first);
  }
  return [...seen].sort();
}

export function DataSeedTab() {
  const { toast } = useToast();
  const { providerId, modelId } = useLlmStore();
  const generation = useSeedGeneratorStore((s) => s.generation);

  const [collection, setCollection] = useState('');
  const [json, setJson] = useState('');
  const [hint, setHint] = useState('');
  const [contextChips, setContextChips] = useState({
    hasSpec: false,
    hasRules: false,
    hasApp: false,
    hasTests: false,
  });
  const [specSnapshot, setSpecSnapshot] = useState<
    Awaited<ReturnType<typeof buildSeedContextBundle>>['spec']
  >(null);

  const generateAbortRef = useRef<AbortController | null>(null);
  const lastHintRef = useRef('');

  // Poll-tick refreshes the collection datalist + the seeded readout on
  // a 1 s cadence — the sandbox emits no "collections changed" signal
  // (same approach the Firestore tab uses).
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    void buildSeedContextBundle().then((bundle) => {
      setContextChips(bundle.summary);
      setSpecSnapshot(bundle.spec);
    });
  }, [tick]);

  const [existingCollections, setExistingCollections] = useState<string[]>([]);
  useEffect(() => {
    let disposed = false;
    void getPlaygroundRuntime().readFirestoreState().then((state) => {
      if (!disposed) setExistingCollections(rootCollectionIds(state));
    });
    return () => {
      disposed = true;
    };
  }, [tick]);

  const coll = collection.trim();
  const collValid = coll.length > 0 && isValidCollectionId(coll);
  const [seeded, setSeeded] = useState<{ id: string; fieldCount: number }[]>([]);
  useEffect(() => {
    let disposed = false;
    if (!collValid) {
      setSeeded([]);
      return () => {
        disposed = true;
      };
    }
    void listSeededAsync(getPlaygroundRuntime(), coll).then((next) => {
      if (!disposed) setSeeded(next);
    });
    return () => {
      disposed = true;
    };
  }, [coll, collValid, tick]);

  const busy =
    generation?.state === 'streaming' ||
    generation?.state === 'applying';

  const apiKeyMissing = useMemo(() => {
    const def = PROVIDERS[providerId];
    return !def?.byok.getKey();
  }, [providerId]);

  const runGeneration = useCallback(
    (existingId?: string) => {
      const activeProviderDef = PROVIDERS[providerId];
      const apiKey = activeProviderDef?.byok.getKey();
      if (!apiKey) {
        toast({
          title: 'API key required',
          body: 'Add a key in Settings to use AI seed generation.',
          kind: 'error',
        });
        return;
      }

      generateAbortRef.current?.abort();
      const ac = new AbortController();
      generateAbortRef.current = ac;

      void (async () => {
        const bundle = await buildSeedContextBundle({ hint: lastHintRef.current });
        setContextChips(bundle.summary);
        setSpecSnapshot(bundle.spec);

        const store = useSeedGeneratorStore.getState();
        const id = existingId ?? store.start(lastHintRef.current, bundle.summary);
        if (existingId) {
          store.resetForRetry(existingId);
        }

        try {
          let received = false;
          for await (const chunk of generateSeedProposal({
            contextPayload: bundle.payload,
            hint: lastHintRef.current,
            providerId,
            modelId,
            apiKey,
            signal: ac.signal,
          })) {
            if (ac.signal.aborted) return;
            received = true;
            store.appendChunk(id, chunk);
          }
          if (ac.signal.aborted) return;
          if (!received) {
            store.setError(id, 'Model returned no text. Check your API key or try again.');
            return;
          }
          const raw = useSeedGeneratorStore.getState().generation?.rawStream ?? '';
          const parsed = parseSeedProposal(raw);
          if (!parsed.ok) {
            store.setError(id, parsed.error);
            return;
          }
          store.setParsed(id, parsed.proposal);
          store.setState(id, 'ready');
        } catch (e) {
          if (ac.signal.aborted) return;
          store.setError(id, e instanceof Error ? e.message : String(e));
        }
      })();
    },
    [providerId, modelId, toast],
  );

  const handleGenerate = useCallback(() => {
    lastHintRef.current = hint;
    runGeneration();
  }, [hint, runGeneration]);

  const handleApplyProposal = useCallback(
    (id: string, proposal: SeedProposalV1) => {
      const store = useSeedGeneratorStore.getState();
      store.setState(id, 'applying');
      void (async () => {
        try {
          const result = await applySeedProposal(getPlaygroundRuntime(), proposal, { spec: specSnapshot });
          setTick((n) => n + 1);
          store.setState(id, 'applied');

          const fs = result.firestore;
          const auth = result.auth;
          const parts: string[] = [];
          if (fs.applied > 0) {
            parts.push(`${fs.applied} doc${fs.applied === 1 ? '' : 's'} in ${fs.collections} collection${fs.collections === 1 ? '' : 's'}`);
          }
          if (auth.created.length > 0) {
            parts.push(`${auth.created.length} auth identit${auth.created.length === 1 ? 'y' : 'ies'}`);
          }
          toast({
            title: parts.length > 0 ? 'Seed applied' : 'Nothing applied',
            body:
              fs.failed + auth.failed > 0
                ? `${fs.failed + auth.failed} failure(s) — check data shapes.`
                : parts.join(' · ') || undefined,
            kind: fs.failed + auth.failed > 0 ? 'error' : 'success',
          });

          const firstColl = Object.keys(proposal.firestore)[0];
          if (firstColl && isValidCollectionId(firstColl)) {
            setCollection(firstColl);
            const docs = proposal.firestore[firstColl];
            setJson(JSON.stringify(docs, null, 2));
          }
        } catch (e) {
          store.setError(id, e instanceof Error ? e.message : String(e));
          toast({
            title: 'Seed apply failed',
            body: e instanceof Error ? e.message : String(e),
            kind: 'error',
          });
        }
      })();
    },
    [specSnapshot, toast],
  );

  const handleEditProposal = useCallback((id: string, proposal: SeedProposalV1) => {
    const firstColl = Object.keys(proposal.firestore)[0];
    if (firstColl && isValidCollectionId(firstColl)) {
      setCollection(firstColl);
      setJson(JSON.stringify(proposal.firestore[firstColl], null, 2));
    }
    useSeedGeneratorStore.getState().setState(id, 'discarded');
    toast({
      title: 'Loaded into manual editor',
      body:
        Object.keys(proposal.firestore).length > 1
          ? `Showing "${firstColl}" — use Apply to seed all collections at once.`
          : undefined,
      kind: 'info',
    });
  }, [toast]);

  const handleDiscard = useCallback((id: string) => {
    useSeedGeneratorStore.getState().setState(id, 'discarded');
  }, []);

  const handleRetry = useCallback(
    (id: string) => {
      void id;
      runGeneration(id);
    },
    [runGeneration],
  );

  const apply = useCallback(() => {
    if (!collValid) {
      toast({ title: 'Pick a collection', body: 'Enter a valid collection id (no slashes).', kind: 'error' });
      return;
    }
    const parsed = parseSeedJson(json);
    if (!parsed.ok) {
      toast({ title: 'Could not parse documents', body: parsed.error, kind: 'error' });
      return;
    }
    void applySeedAsync(getPlaygroundRuntime(), coll, parsed.docs).then((result) => {
      setTick((n) => n + 1);
      if (result.failed === 0) {
        toast({ title: `Seeded ${result.applied} doc${result.applied === 1 ? '' : 's'} → ${coll}`, kind: 'success' });
        setJson('');
      } else {
        toast({
          title: `Seeded ${result.applied}, ${result.failed} failed`,
          body: result.errors.map((e) => `${e.id}: ${e.error}`).join('; '),
          kind: 'error',
        });
      }
    }).catch((e) => {
      toast({ title: 'Seed failed', body: e instanceof Error ? e.message : String(e), kind: 'error' });
    });
  }, [coll, collValid, json, toast]);

  const clear = useCallback(() => {
    if (!collValid) return;
    void clearCollectionAsync(getPlaygroundRuntime(), coll).then((cleared) => {
      setTick((n) => n + 1);
      toast({
        title: cleared > 0 ? `Cleared ${cleared} doc${cleared === 1 ? '' : 's'} from ${coll}` : `${coll} was already empty`,
        kind: cleared > 0 ? 'success' : 'info',
      });
    }).catch((e) => {
      toast({ title: 'Clear failed', body: e instanceof Error ? e.message : String(e), kind: 'error' });
    });
  }, [coll, collValid, toast]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto custom-scrollbar bg-content-bg p-4 text-[13px] text-soft-white">
      <p className="text-[12px] leading-relaxed text-slate-gray">
        Populate this session&apos;s sandbox with demo data — the data analog of the
        Auth tab. Writes go straight to the sandbox (admin, bypasses your rules) and
        persist for this session only. This is runtime state, never written to a file
        or your app&apos;s code.
      </p>

      <section className="grid gap-3 rounded-lg border border-[#2a2a35] bg-sidebar-bg p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-slate-gray">Context</span>
          <ContextChip label="Spec" active={contextChips.hasSpec} />
          <ContextChip label="Rules" active={contextChips.hasRules} />
          <ContextChip label="App" active={contextChips.hasApp} />
          <ContextChip label="Tests" active={contextChips.hasTests} />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="seed-hint" className="text-[11px] uppercase tracking-wide text-slate-gray">
            Hint (optional)
          </label>
          <input
            id="seed-hint"
            type="text"
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            placeholder="e.g. coffee shop with 6 menu items and 2 sample orders"
            disabled={busy}
            className={INPUT_CLS}
          />
        </div>

        {apiKeyMissing ? (
          <p className="text-[11px] text-[#e6c79c]">
            Add an API key in Settings to generate demo data with AI.
          </p>
        ) : null}

        <button
          type="button"
          onClick={handleGenerate}
          disabled={busy || apiKeyMissing}
          className="h-8 w-fit shrink-0 rounded-lg bg-[#5b5bd6] px-4 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Generate demo data
        </button>

        {generation &&
        generation.state !== 'idle' &&
        generation.state !== 'discarded' ? (
          <SeedGenerationCard
            generation={generation}
            onApply={handleApplyProposal}
            onEdit={handleEditProposal}
            onDiscard={handleDiscard}
            onRetry={handleRetry}
            applyBusy={generation.state === 'applying'}
          />
        ) : null}
      </section>

      <div className="border-t border-[#2a2a35]/60 pt-2">
        <p className="mb-3 text-[11px] uppercase tracking-wide text-slate-gray">Manual seed</p>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="seed-collection" className="text-[11px] uppercase tracking-wide text-slate-gray">
          Collection
        </label>
        <input
          id="seed-collection"
          type="text"
          list="seed-collections"
          value={collection}
          onChange={(e) => setCollection(e.target.value)}
          placeholder="e.g. menuItems"
          className={`font-mono ${INPUT_CLS}`}
        />
        <datalist id="seed-collections">
          {existingCollections.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        {collection.length > 0 && !collValid ? (
          <span role="alert" className="text-[11px] text-[#f0a0a0]">
            Collection id must be a single segment (no slashes).
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="seed-json" className="text-[11px] uppercase tracking-wide text-slate-gray">
          Documents (JSON)
        </label>
        <textarea
          id="seed-json"
          value={json}
          onChange={(e) => setJson(e.target.value)}
          placeholder={PLACEHOLDER_JSON}
          spellCheck={false}
          rows={10}
          className={`resize-y font-mono leading-relaxed ${INPUT_CLS}`}
        />
        <span className="text-[11px] text-slate-gray">
          An object keyed by document id, or an array of document bodies (ids
          auto-generate; an <code className="font-mono">id</code> field is used when present).
        </span>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={apply}
          disabled={!collValid || json.trim().length === 0}
          className="h-8 shrink-0 rounded-lg bg-[#5b5bd6] px-4 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Seed data
        </button>
        <button
          type="button"
          onClick={clear}
          disabled={!collValid || seeded.length === 0}
          className="h-8 shrink-0 rounded-lg border border-[#2a2a35] px-4 text-[12px] text-slate-gray transition-colors hover:border-[#3a2a2a] hover:text-[#f0a0a0] disabled:opacity-40 disabled:hover:border-[#2a2a35] disabled:hover:text-slate-gray"
        >
          Clear collection
        </button>
      </div>

      {collValid ? (
        <section className="rounded-lg border border-[#2a2a35] bg-sidebar-bg p-3">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-gray">
            In <span className="font-mono normal-case tracking-normal text-soft-white">{coll}</span>{' '}
            <span className="text-slate-gray">
              ({seeded.length} doc{seeded.length === 1 ? '' : 's'})
            </span>
          </h3>
          {seeded.length === 0 ? (
            <p className="text-[12px] text-slate-gray">
              Nothing seeded here yet. Seeded docs appear here and in the Data tab.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {seeded.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3 font-mono text-[12px]">
                  <span className="truncate text-soft-white">{d.id}</span>
                  <span className="shrink-0 text-slate-gray">
                    {d.fieldCount} field{d.fieldCount === 1 ? '' : 's'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}

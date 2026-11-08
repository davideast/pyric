/**
 * Mode-keyed source and methodology copy for `ListenersView` and `ListenerPage`
 * (`sandbox` vs `live`).
 */
import type { ReactNode } from 'react';
import type { TrafficHostMode } from '../traffic/traffic-panel-copy.js';

export interface ListenerFooterCopy {
  readonly source: string;
  readonly methodology: ReactNode;
}

export const LISTENERS_VIEW_COPY: Record<TrafficHostMode, ListenerFooterCopy> = {
  sandbox: {
    source: 'Source: sandbox listener events · listeners attached now, deliveries in this window',
    methodology: (
      <div>
        <p>
          A listener is attached when the sandbox recorded its <code>attach</code> and has not
          recorded a <code>detach</code> or an error for it since. The count is that fold, not the
          number of attach events.
        </p>
        <p>
          <strong>Owners come from the attach, deliveries from the window.</strong> The owner is
          the React component the listener was opened in, else the tag the app gave it, else the
          target itself. Two listeners on the same target under the same owner are one thing
          attached twice, so they collapse into one row carrying <code>×N</code>. Delivery counts
          cover the displayed window only; a listener with none is idle, not gone.
        </p>
      </div>
    ),
  },
  live: {
    source: 'Source: observed live listeners · listeners attached now, deliveries in this window',
    methodology: (
      <div>
        <p>
          A listener is attached when a connected client SDK observed its <code>attach</code> and
          has not reported a <code>detach</code>, an error, or a closed connection for it since.
          One-shot Realtime Database reads (<code>onlyOnce</code>) detach automatically after their
          single delivery, and host restarts or same-tab reloads close prior listeners.
        </p>
        <p>
          <strong>Owners come from the attach, deliveries from the window.</strong> Callbacks
          invoked on attached Firestore and Realtime Database listeners count as deliveries inside
          the displayed window and respect the active <code>From</code> client or user scope; a
          listener with none in the window is idle, not gone.
        </p>
      </div>
    ),
  },
};

export const LISTENER_PAGE_COPY: Record<TrafficHostMode, ListenerFooterCopy> = {
  sandbox: {
    source:
      'Source: sandbox delivery events · every delivery this session recorded for this listener',
    methodology: (
      <div>
        <p>
          Every delivery event carries the result set the callback received: a Firestore delivery
          carries the documents in callback order, and a database delivery carries the value at the
          target path, whose keys are child paths when that value is an object. The paths under a
          delivery are that result set, not a re-read of the store.
        </p>
        <p>
          <strong>The labels come from the previous delivery.</strong> A path is <code>added</code>{' '}
          when the previous delivery did not carry it, <code>modified</code> when it did and the
          data differs, and <code>removed</code> when the previous delivery carried it and this one
          does not. A path whose data is identical is not listed. The first delivery is{' '}
          <code>initial</code>: every path in it arrived, so it lists none.
        </p>
        <p>
          Firestore charges a listener for the documents in its first snapshot, then for each
          document a later delivery adds or changes; a delivery that only drops documents costs
          nothing, and an empty first snapshot still costs one read. The estimate covers this
          session's deliveries, so a reconnect that re-read the result set and a second listener on
          the same query are not in it.
        </p>
      </div>
    ),
  },
  live: {
    source:
      'Source: observed live deliveries · every delivery observed in this session for this listener',
    methodology: (
      <div>
        <p>
          Every observed delivery records bounded path metadata without storing document or node
          values on the event stream: Firestore <code>onSnapshot</code> and Realtime Database{' '}
          <code>onChild*</code> listeners record changed and deleted paths, while full-node{' '}
          <code>onValue</code> listeners record the child key set delivered at the watched
          reference.
        </p>
        <p>
          <strong>The labels come from the previous delivery.</strong> Delta listeners mark newly
          seen paths <code>added</code>, re-delivered changed paths <code>modified</code>, and
          deleted paths <code>removed</code>; full-node <code>onValue</code> snapshots mark new
          child keys <code>added</code>, dropped keys <code>removed</code>, and keys still present{' '}
          <code>unchanged</code>. The first delivery is <code>initial</code>.
        </p>
        <p>
          Firestore charges a listener for the documents in its first snapshot, then for each
          document a later delivery adds or changes; a delivery that only drops documents costs
          nothing, and an empty first snapshot still costs one read.
        </p>
      </div>
    ),
  },
};

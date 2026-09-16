import { snapshotDispatcher } from './snapshot-registry.js';

const failed = (error) => ({
  status: 'failed', artifact_reference: null, bytes: null, captured_at: null,
  error: error instanceof Error ? error.message : String(error)
});

function identityOf(trigger) {
  if (!trigger?.session_id || !trigger?.page_id) return null;
  return `${trigger.session_id}:${trigger.page_id}`;
}

/** Stores only explicit local Playwright Page ownership; it never creates Pages. */
export class PageHandleRegistry {
  #pages = new Map();

  register({ session_id, page_id, page }) {
    const identity = identityOf({ session_id, page_id });
    if (!identity || !page) throw new Error('PageHandleRegistry requires session_id, page_id, and page.');
    this.#pages.set(identity, page);
    return () => this.#pages.delete(identity);
  }

  resolve(trigger) { return this.#pages.get(identityOf(trigger)); }
}

/** Local-only transport contract for tests and a future explicit Extension connector. */
export class InMemoryObservationSnapshotTransport {
  #listeners = new Set();

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('Observation transport listener must be a function.');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async publish(envelope) { return Promise.all([...this.#listeners].map((listener) => listener(envelope))); }
}

/** Dispatches ready Extension observations against an explicitly owned local Page. */
export class ObservationSnapshotBridge {
  #outcomes = new Map();

  constructor({ pageRegistry, dispatcher = snapshotDispatcher }) {
    if (!pageRegistry || typeof pageRegistry.resolve !== 'function') throw new Error('ObservationSnapshotBridge requires a PageHandleRegistry.');
    this.pageRegistry = pageRegistry;
    this.dispatcher = dispatcher;
  }

  attach(transport) { return transport.subscribe((envelope) => this.receive(envelope)); }

  receive({ trigger, observation }) {
    const identity = identityOf(trigger);
    const dedupeKey = trigger?.observation_id && identity ? `${trigger.platform}:${trigger.observation_id}:${identity}` : null;
    if (dedupeKey && this.#outcomes.has(dedupeKey)) return this.#outcomes.get(dedupeKey);
    const outcome = this.#capture({ trigger, observation });
    if (dedupeKey) this.#outcomes.set(dedupeKey, outcome);
    return outcome;
  }

  async #capture({ trigger, observation }) {
    const page = this.pageRegistry.resolve(trigger);
    if (!page) return { observation, snapshot_result: failed('No local Page is registered for the observation session/page identity.'), artifacts: [] };
    try {
      const dispatched = await this.dispatcher.captureWithArtifacts({ platform: trigger.platform, context: { page } });
      return { observation, snapshot_result: dispatched.snapshot_result, artifacts: dispatched.artifacts };
    } catch (error) {
      return { observation, snapshot_result: failed(error), artifacts: [] };
    }
  }
}

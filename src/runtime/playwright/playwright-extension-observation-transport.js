const MESSAGE_NAMESPACE = 'AI_GEO_OBSERVATION_SNAPSHOT';
const MESSAGE_TYPE = 'OBSERVATION_SNAPSHOT_READY';
const BINDING_NAME = '__aiGeoObservationSnapshotBinding';

function listenerScript({ bindingName, namespace, type }) {
  if (globalThis.__AI_GEO_OBSERVATION_SNAPSHOT_LISTENER__) return;
  globalThis.__AI_GEO_OBSERVATION_SNAPSHOT_LISTENER__ = true;
  globalThis.addEventListener('message', (event) => {
    if (event.source !== globalThis || event.data?.namespace !== namespace || event.data?.type !== type) return;
    globalThis[bindingName](event.data).catch(() => {});
  });
}

function identityScript({ session_id, page_id }) {
  const setIdentity = () => {
    if (!document.documentElement) return false;
    document.documentElement.setAttribute('data-ai-geo-observation-session-id', session_id);
    document.documentElement.setAttribute('data-ai-geo-observation-page-id', page_id);
    return true;
  };
  if (!setIdentity()) addEventListener('DOMContentLoaded', setIdentity, { once: true });
}

/** Browser-native Extension-to-Node transport; it has no platform behavior. */
export class PlaywrightExtensionObservationTransport {
  #listeners = new Set();

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('Observation transport listener must be a function.');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async attachPage({ page, session_id, page_id, pageRegistry }) {
    if (!page || !session_id || !page_id) throw new Error('Transport attach requires page, session_id, and page_id.');
    if (!pageRegistry || typeof pageRegistry.register !== 'function') throw new Error('Transport attach requires a PageHandleRegistry.');
    const unregister = pageRegistry.register({ session_id, page_id, page });
    await page.exposeBinding(BINDING_NAME, async (_source, envelope) => this.#publish(envelope));
    const listener = { bindingName: BINDING_NAME, namespace: MESSAGE_NAMESPACE, type: MESSAGE_TYPE };
    const identity = { session_id, page_id };
    await page.addInitScript(listenerScript, listener);
    await page.addInitScript(identityScript, identity);
    await page.evaluate(listenerScript, listener);
    await page.evaluate(identityScript, identity);
    return unregister;
  }

  async #publish(envelope) {
    if (!envelope?.trigger || !envelope.observation) throw new Error('Extension observation envelope is incomplete.');
    return Promise.all([...this.#listeners].map((listener) => listener({ trigger: envelope.trigger, observation: envelope.observation })));
  }
}

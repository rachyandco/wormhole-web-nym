/**
 * Mixnet — thin wrapper around the Nym SDK that survives restart.
 *
 * The SDK identifies a client by `clientId`; reusing the same id reuses the
 * persisted identity, so a restarted client keeps the same Nym address as
 * long as the previous gateway accepts us back.
 *
 * The wrapper tracks active subscriptions and re-binds them to the new SDK
 * client on `restart()`, so callers can hold a stable handle.
 */

import { createNymMixnetClient } from '@nymproject/sdk-full-fat';

export class Mixnet {
  #client     = null;
  #address    = null;
  #clientId   = null;
  #nymApiUrl  = null;
  #forceTls   = true;
  #subs       = new Set();
  #starting   = null;

  get address()   { return this.#address; }
  get isStarted() { return !!this.#client; }

  async start({ clientId, nymApiUrl, forceTls = true, onStatus, timeoutMs = 90_000 }) {
    if (this.#starting) return this.#starting;
    this.#clientId  = clientId;
    this.#nymApiUrl = nymApiUrl;
    this.#forceTls  = forceTls;
    this.#starting  = this.#startInternal({ onStatus, timeoutMs }).finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #startInternal({ onStatus, timeoutMs }) {
    onStatus?.('Creating Nym WebAssembly client…');
    const c = await createNymMixnetClient();

    await new Promise((resolve, reject) => {
      let done = false;
      c.events.subscribeToConnected(e => {
        if (done) return;
        done = true; clearTimeout(timeoutId);
        this.#address = e.args.address;
        resolve();
      });
      onStatus?.('Connecting to Nym mixnet…');
      c.client.start({
        clientId:  this.#clientId,
        nymApiUrl: this.#nymApiUrl,
        forceTls:  this.#forceTls,
      }).catch(err => {
        if (done) return;
        done = true; clearTimeout(timeoutId);
        reject(err);
      });
      const timeoutId = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error('Nym connection timeout'));
      }, timeoutMs);
    });

    this.#client = c;
    for (const sub of this.#subs) {
      sub._unsub = c.events.subscribeToRawMessageReceivedEvent(sub.fn);
    }
  }

  /** Returns true if the client looks alive and address matches our cached one. */
  async healthcheck() {
    if (!this.#client) return false;
    try {
      const a = await Promise.race([
        this.#client.client.selfAddress(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('probe timeout')), 5_000)),
      ]);
      return !!a && a === this.#address;
    } catch {
      return false;
    }
  }

  /**
   * Tear down the underlying SDK client and start a new one with the same
   * clientId. Returns whether the resulting Nym address differs from the old.
   */
  async restart({ onStatus } = {}) {
    for (const sub of this.#subs) {
      try { sub._unsub?.(); } catch {}
      sub._unsub = null;
    }
    if (this.#client) {
      try { await this.#client.client.stop(); } catch {}
      this.#client = null;
    }
    const previous = this.#address;
    this.#address = null;
    await this.start({
      clientId:  this.#clientId,
      nymApiUrl: this.#nymApiUrl,
      forceTls:  this.#forceTls,
      onStatus,
    });
    return { addressChanged: this.#address !== previous, previousAddress: previous };
  }

  subscribe(fn) {
    const sub = { fn, _unsub: null };
    if (this.#client) {
      sub._unsub = this.#client.events.subscribeToRawMessageReceivedEvent(fn);
    }
    this.#subs.add(sub);
    return () => {
      try { sub._unsub?.(); } catch {}
      this.#subs.delete(sub);
    };
  }

  rawSend(recipient, payload) {
    return this.#client.client.rawSend({ payload, recipient });
  }
}

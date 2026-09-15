import bs58 from 'bs58';
import { log } from '../config.js';

export class TransactionDispatcher {
  /**
   * @param {import('@solana/web3.js').Connection} connection
   * @param {object} [options]
   */
  constructor(connection, options = {}) {
    this.connection = connection;
    this.jitoEndpoints = options.jitoEndpoints || [
      'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
      'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
      'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
    ];
    this.enableJito = options.enableJito !== false;
    this.enableRpcFallback = options.enableRpcFallback !== false;
    this.timeoutMs = options.timeoutMs || 3000;
  }

  /**
   * Dispatches the raw signed transaction immediately to Jito bundle endpoints and RPC
   * @param {Buffer | Uint8Array} wireTransaction
   * @param {import('@solana/web3.js').Transaction} [transaction]
   * @returns {Promise<{ signature: string, routesDispatched: string[], dispatchDurationMs: number }>}
   */
  async dispatch(wireTransaction, transaction = null) {
    const startTime = performance.now();
    const wireBuf = Buffer.isBuffer(wireTransaction)
      ? wireTransaction
      : Buffer.from(wireTransaction, typeof wireTransaction === 'string' ? 'base64' : undefined);
    const wireBase58 = bs58.encode(wireBuf);
    let signature = null;

    if (transaction && transaction.signatures && transaction.signatures.length > 0) {
      const firstSig = transaction.signatures[0];
      const rawSig = (firstSig && typeof firstSig === 'object' && firstSig.signature) ? firstSig.signature : firstSig;
      signature = bs58.encode(Buffer.from(rawSig));
    } else {
      signature = bs58.encode(wireBuf.subarray(1, 65));
    }

    const dispatchPromises = [];
    const routesDispatched = [];

    // 1. Dispatch to Jito Block Engine Bundle endpoints concurrently
    if (this.enableJito) {
      for (const endpoint of this.jitoEndpoints) {
        routesDispatched.push(`JITO:${endpoint}`);
        dispatchPromises.push(
          this._sendJitoBundle(endpoint, [wireBase58]).catch((err) => {
            // Silently log or ignore Jito endpoint connection quirks
          })
        );
      }
    }

    // 2. Dispatch to fast private / direct Solana RPC with skipPreflight
    if (this.enableRpcFallback && this.connection) {
      routesDispatched.push('RPC_DIRECT');
      dispatchPromises.push(
        this.connection
          .sendRawTransaction(wireTransaction, {
            skipPreflight: true,
            maxRetries: 0,
          })
          .catch((err) => {
            // Log RPC send error
          })
      );
    }

    // Fire non-blocking requests in background without awaiting slow confirmation
    Promise.allSettled(dispatchPromises).catch(() => {});

    const dispatchDurationMs = performance.now() - startTime;

    return {
      signature,
      routesDispatched,
      dispatchDurationMs,
    };
  }

  /**
   * Sends raw bundle to Jito Block Engine via JSON-RPC 2.0
   * @private
   */
  async _sendJitoBundle(endpoint, bundleBase58Array) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendBundle',
          params: [bundleBase58Array],
        }),
        signal: controller.signal,
      });
      return await response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

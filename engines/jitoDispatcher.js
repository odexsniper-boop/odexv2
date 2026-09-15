import bs58 from 'bs58';
import { log } from '../config.js';

export class JitoDispatcher {
  /**
   * @param {import('@solana/web3.js').Connection} connection
   * @param {object} [options]
   */
  constructor(connection, options = {}) {
    this.connection = connection;
    this.jitoEndpoints = options.jitoEndpoints || [
      'https://mainnet.block-engine.jito.wtf/api/v1',
      'https://ny.mainnet.block-engine.jito.wtf/api/v1',
      'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1',
      'https://tokyo.mainnet.block-engine.jito.wtf/api/v1',
    ];
    this.enableJito = options.enableJito !== false;
    this.enableRpcFallback = options.enableRpcFallback !== false;
    this.timeoutMs = options.timeoutMs || 3000;
    this.preferBundles = options.preferBundles || false;

    // In-flight submissions map to prevent duplicate execution: executionId -> { status, signature, route }
    this.inFlightSubmissions = new Map();
  }

  /**
   * Submits a signed transaction using Jito Block Engine (JSON-RPC 2.0 with base64)
   * with controlled fallback to fast RPC ONLY if Jito submission fails.
   * FORBIDS duplicate submission if Jito accepted the transaction.
   *
   * @param {object} params
   * @param {Buffer | Uint8Array} params.wireTransaction
   * @param {import('@solana/web3.js').Transaction} [params.transaction]
   * @param {string} params.executionId
   * @param {boolean} [params.useBundle=false]
   * @returns {Promise<{ signature: string, route: string, jitoAccepted: boolean, dispatchDurationMs: number }>}
   */
  async dispatch({ wireTransaction, transaction = null, executionId, useBundle = false }) {
    const startTime = performance.now();

    // Ensure wireTransaction is always a Buffer
    const wireBuf = Buffer.isBuffer(wireTransaction)
      ? wireTransaction
      : Buffer.from(wireTransaction, typeof wireTransaction === 'string' ? 'base64' : undefined);

    // Extract signature (supports both VersionedTransaction and legacy Transaction)
    let signature = null;
    if (transaction && transaction.signatures && transaction.signatures.length > 0) {
      const firstSig = transaction.signatures[0];
      const rawSig = (firstSig && typeof firstSig === 'object' && firstSig.signature) ? firstSig.signature : firstSig;
      signature = bs58.encode(Buffer.from(rawSig));
    } else {
      signature = bs58.encode(wireBuf.subarray(1, 65));
    }

    // Modern Jito JSON-RPC standard uses base64
    const wireBase64 = wireBuf.toString('base64');

    // Duplicate check
    if (this.inFlightSubmissions.has(executionId)) {
      const existing = this.inFlightSubmissions.get(executionId);
      log(`[DISPATCHER] Idempotency intercepted: ${executionId} already submitted on ${existing.route}`);
      return {
        signature: existing.signature,
        route: existing.route,
        jitoAccepted: existing.jitoAccepted,
        dispatchDurationMs: 0,
      };
    }

    let jitoAccepted = false;
    let dispatchRoute = 'NONE';
    const dispatchStart = performance.now();

    // 1. Primary Route: Jito Block Engine Submission (Base64)
    if (this.enableJito) {
      const endpoint = this.jitoEndpoints[0];
      const method = useBundle || this.preferBundles ? 'sendBundle' : 'sendTransaction';
      const url = `${endpoint}/${method === 'sendBundle' ? 'bundles' : 'transactions'}`;
      const params = method === 'sendBundle' ? [[wireBase64]] : [wireBase64];

      try {
        const jitoResult = await this._submitJito(url, method, params);
        if (jitoResult && !jitoResult.error) {
          jitoAccepted = true;
          dispatchRoute = `JITO:${method.toUpperCase()}`;
          this.inFlightSubmissions.set(executionId, {
            status: 'ACCEPTED_PENDING_BLOCK',
            signature,
            route: dispatchRoute,
            jitoAccepted: true,
            submittedAt: Date.now(),
          });
          const dispatchEnd = performance.now();
          const dispatchMs = dispatchEnd - dispatchStart;
          return {
            signature,
            route: dispatchRoute,
            jitoAccepted: true,
            dispatchStart,
            dispatchEnd,
            dispatchMs,
            dispatchDurationMs: dispatchMs,
          };
        } else {
          log(`[JITO SUBMIT REJECTED] ${JSON.stringify(jitoResult?.error || 'Unknown error')}`);
        }
      } catch (err) {
        log(`[JITO SUBMIT ERROR] Failed reaching Jito: ${err.message}`);
      }
    }

    // 2. Controlled Fallback to Fast RPC
    // CRITICAL (Amendment 6 & 10): Only fallback if Jito genuinely failed to accept the submission.
    // If Jito accepted, DO NOT send a duplicate RPC transaction!
    if (!jitoAccepted && this.enableRpcFallback && this.connection) {
      dispatchRoute = 'RPC_FALLBACK';
      try {
        const rawSig = await this.connection.sendRawTransaction(wireBuf, {
          skipPreflight: true,
          maxRetries: 0,
        });
        if (rawSig) signature = rawSig;
        this.inFlightSubmissions.set(executionId, {
          status: 'SUBMITTED_RPC',
          signature,
          route: dispatchRoute,
          jitoAccepted: false,
          submittedAt: Date.now(),
        });
      } catch (rpcErr) {
        log(`[RPC FALLBACK ERROR] Failed to broadcast: ${rpcErr.message}`);
        throw rpcErr;
      }
    } else if (!jitoAccepted) {
      throw new Error('DISPATCH_FAILED: Neither Jito nor RPC fallback succeeded in broadcasting transaction');
    }

    const dispatchEnd = performance.now();
    const dispatchMs = dispatchEnd - dispatchStart;
    return {
      signature,
      route: dispatchRoute,
      jitoAccepted,
      dispatchStart,
      dispatchEnd,
      dispatchMs,
      dispatchDurationMs: dispatchMs,
    };
  }

  /**
   * Submits request to Jito Block Engine via JSON-RPC 2.0 with timeout
   * @private
   */
  async _submitJito(url, method, params) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params,
        }),
        signal: controller.signal,
      });
      return await res.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  cleanup(executionId) {
    this.inFlightSubmissions.delete(executionId);
  }
}

import bs58 from 'bs58';
import { log } from '../config.js';

export class RpcBlastDispatcher {
  /**
   * @param {import('@solana/web3.js').Connection} primaryConnection
   * @param {object} [options]
   */
  constructor(primaryConnection, options = {}) {
    this.primaryConnection = primaryConnection;
    
    const defaultEndpoints = [
      primaryConnection?.rpcEndpoint,
      'https://api.mainnet-beta.solana.com',
      'https://mainnet.block-engine.jito.wtf/api/v1/transactions'
    ].filter(Boolean);
    
    const allEndpoints = [...defaultEndpoints, ...(options.customEndpoints || [])];
    // De-duplicate endpoints
    this.endpoints = [...new Set(allEndpoints)];
    this.timeoutMs = options.timeoutMs || 3000;
  }

  /**
   * Submits a signed transaction via multiple RPCs simultaneously.
   *
   * @param {object} params
   * @param {Buffer | Uint8Array} params.wireTransaction
   * @param {import('@solana/web3.js').Transaction} [params.transaction]
   * @param {string} params.executionId
   * @returns {Promise<{ signature: string, route: string, jitoAccepted: boolean, dispatchDurationMs: number }>}
   */
  async dispatch({ wireTransaction, transaction = null, executionId }) {
    const dispatchStart = performance.now();

    // Ensure wireTransaction is always a Buffer
    const wireBuf = Buffer.isBuffer(wireTransaction)
      ? wireTransaction
      : Buffer.from(wireTransaction, typeof wireTransaction === 'string' ? 'base64' : undefined);

    // Extract signature
    let signature = null;
    if (transaction && transaction.signatures && transaction.signatures.length > 0) {
      const firstSig = transaction.signatures[0];
      const rawSig = (firstSig && typeof firstSig === 'object' && firstSig.signature) ? firstSig.signature : firstSig;
      signature = bs58.encode(Buffer.from(rawSig));
    } else {
      signature = bs58.encode(wireBuf.subarray(1, 65));
    }

    const wireBase64 = wireBuf.toString('base64');
    
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendTransaction',
      params: [
        wireBase64,
        {
          encoding: 'base64',
          preflightCommitment: 'processed',
          skipPreflight: true,
          maxRetries: 0
        }
      ]
    });

    const blastPromises = this.endpoints.map(async (url) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
      
      try {
        // Standard JSON-RPC fetch
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          signal: controller.signal
        });
        
        if (!res.ok) {
          throw new Error(`HTTP Error ${res.status}: ${res.statusText} from ${url}`);
        }

        const data = await res.json();
        
        if (data.error) {
          throw new Error(`RPC Error from ${url}: ${data.error.message || JSON.stringify(data.error)}`);
        }
        
        return { url, result: data.result };
      } catch (err) {
        throw err; // Caught by Promise.any
      } finally {
        clearTimeout(timeoutId);
      }
    });

    try {
      // Returns as soon as the FIRST RPC node confirms it accepted the packet
      const firstSuccess = await Promise.any(blastPromises);
      const dispatchEnd = performance.now();
      
      const dispatchDurationMs = dispatchEnd - dispatchStart;
      log(`[RPC BLAST] Fastest accept from ${firstSuccess.url} in ${dispatchDurationMs.toFixed(2)}ms`);
      
      return {
        signature: firstSuccess.result || signature,
        route: 'RPC_BLAST',
        jitoAccepted: false, // Explicitly false as we bypassed the Jito bundle API
        dispatchStart,
        dispatchEnd,
        dispatchDurationMs
      };
    } catch (aggregateError) {
      log(`[RPC BLAST ERROR] All RPC nodes rejected the transaction.`);
      throw new Error('DISPATCH_FAILED: All nodes in the blast radius failed or timed out.');
    }
  }

  cleanup(executionId) {
    // Stateless blasting, no in-flight map needed
  }
}

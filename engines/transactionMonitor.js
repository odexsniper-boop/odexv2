import { eventBus } from '../eventBus.js';
import { log } from '../config.js';

export class TransactionMonitor {
  /**
   * @param {import('@solana/web3.js').Connection} connection
   * @param {object} [options]
   */
  constructor(connection, options = {}) {
    this.connection = connection;
    this.pollIntervalMs = options.pollIntervalMs || 400; // 400ms quick poll
    this.timeoutMs = options.timeoutMs || 35_000; // 35s max timeout before expired
    this.pendingTxs = new Map(); // signature -> { context, startTime, resolve, reject, timer }
  }

  /**
   * Begins non-blocking tracking of a dispatched signature.
   * Returns a promise that resolves when confirmed, or rejects if failed/timed out.
   * @param {string} signature
   * @param {object} context
   * @returns {Promise<object>}
   */
  track(signature, context = {}) {
    eventBus.emit('EXECUTION_PROCESSING', { signature, context });

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let isSettled = false;

      const cleanup = () => {
        isSettled = true;
        if (pollTimer) clearInterval(pollTimer);
        if (wsSubId !== null && this.connection && this.connection.removeSignatureListener) {
          try {
            this.connection.removeSignatureListener(wsSubId);
          } catch (_) {}
        }
        this.pendingTxs.delete(signature);
      };

      const handleSuccess = (status) => {
        if (isSettled) return;
        cleanup();
        const confirmationLatencyMs = Date.now() - startTime;
        const result = {
          status: 'SUCCESS',
          signature,
          context,
          confirmationLatencyMs,
          slot: status ? status.slot : null,
        };
        eventBus.emit('EXECUTION_CONFIRMED', result);
        resolve(result);
      };

      const handleFailure = (errorReason) => {
        if (isSettled) return;
        cleanup();
        const failureResult = {
          status: 'FAILED',
          signature,
          context,
          reason: errorReason,
          latencyMs: Date.now() - startTime,
        };

        // Custom:6002 Structured Diagnostic (Amendment 3 & 22)
        if (typeof errorReason === 'string' && (errorReason.includes('6002') || errorReason.includes('TooMuchSolRequired'))) {
          log(`\n======================================================`);
          log(`[CUSTOM:6002 DIAGNOSTIC REPORT]`);
          log(`Execution ID:        ${context.executionId || 'N/A'}`);
          log(`Mint:                ${context.mint || 'N/A'}`);
          log(`Side:                ${context.action || 'BUY'}`);
          log(`Expected Tokens:     ${context.expectedTokensOut || 'N/A'}`);
          log(`Min Tokens Out:      ${context.minTokensOut || 'N/A'}`);
          log(`SOL Amount:          ${context.amount || 'N/A'} SOL`);
          log(`Max SOL Cost:        ${context.maxSolCostLamports ? Number(context.maxSolCostLamports)/1e9 + ' SOL' : 'N/A'}`);
          log(`Slippage BPS:        ${context.slippageBps || 'N/A'}`);
          log(`Virtual SOL Res:     ${context.virtualSolReserves || 'N/A'}`);
          log(`Virtual Token Res:   ${context.virtualTokenReserves || 'N/A'}`);
          log(`Token Program:       ${context.tokenProgramId || 'N/A'}`);
          log(`Route:               ${context.route || 'N/A'}`);
          log(`Signature:           ${signature}`);
          log(`Diagnosis:           On-chain curve moved beyond slippage boundary before block inclusion.`);
          log(`======================================================\n`);
        }

        eventBus.emit('EXECUTION_FAILED', failureResult);
        reject(new Error(`Transaction failed on-chain: ${errorReason}`));
      };

      // 1. WebSocket signature subscription for instant notification
      let wsSubId = null;
      if (this.connection && this.connection.onSignature) {
        try {
          wsSubId = this.connection.onSignature(
            signature,
            (res) => {
              if (res.err) {
                handleFailure(JSON.stringify(res.err));
              } else {
                handleSuccess(res);
              }
            },
            'confirmed'
          );
        } catch (_) {}
      }

      // 2. High-frequency RPC polling backup
      const pollTimer = setInterval(async () => {
        if (isSettled) return;

        // Check timeout
        if (Date.now() - startTime > this.timeoutMs) {
          handleFailure('TRANSACTION_TIMEOUT_NOT_CONFIRMED');
          return;
        }

        if (!this.connection) return;

        try {
          const res = await this.connection.getSignatureStatuses([signature]);
          if (res && res.value && res.value[0]) {
            const status = res.value[0];
            if (status.err) {
              handleFailure(JSON.stringify(status.err));
            } else if (
              status.confirmationStatus === 'confirmed' ||
              status.confirmationStatus === 'finalized'
            ) {
              handleSuccess(status);
            }
          }
        } catch (_) {}
      }, this.pollIntervalMs);

      this.pendingTxs.set(signature, {
        context,
        startTime,
        cleanup,
      });
    });
  }

  /**
   * Cancels all active monitors on shutdown
   */
  stop() {
    for (const [sig, item] of this.pendingTxs.entries()) {
      if (item.cleanup) item.cleanup();
    }
    this.pendingTxs.clear();
  }
}

import { log } from '../config.js';

export class BlockhashManager {
  /**
   * @param {import('@solana/web3.js').Connection} connection
   * @param {object} [options]
   */
  constructor(connection, options = {}) {
    this.connection = connection;
    this.pollIntervalMs = options.pollIntervalMs || 1500; // Poll every 1.5s
    this.safeBlockMargin = options.safeBlockMargin || 15; // Refresh if within 15 blocks of lastValidBlockHeight
    this.latestBlockhash = null;
    this.lastValidBlockHeight = null;
    this.currentBlockHeight = null;
    this.lastFetchedAt = 0;
    this.timer = null;
    this.isFetching = false;
    this.fallbackConnections = options.fallbackConnections || [];
  }

  /**
   * Starts background polling loop
   */
  start() {
    if (this.timer) return;
    this.refreshBlockhash().catch(() => {});
    this.timer = setInterval(() => {
      this.refreshBlockhash().catch(() => {});
    }, this.pollIntervalMs);
    if (this.timer.unref) {
      this.timer.unref(); // Prevent blocking process exit
    }
  }

  /**
   * Stops background polling
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Checks whether the currently cached blockhash is still valid on-chain.
   * Uses Solana's actual block-height validity (lastValidBlockHeight) rather than an arbitrary 30s rule.
   * @returns {boolean}
   */
  isBlockhashValid() {
    if (!this.latestBlockhash || !this.lastValidBlockHeight) {
      return false;
    }
    if (this.currentBlockHeight && (this.currentBlockHeight + this.safeBlockMargin >= this.lastValidBlockHeight)) {
      return false;
    }
    return true;
  }

  /**
   * Synchronously returns the latest cached blockhash from in-memory cache.
   * Measures actual lookup latency (does not claim literal 0ms).
   * @returns {{ blockhash: string, lastValidBlockHeight: number, fetchedAt: number, lookupMs: number, isValid: boolean } | null}
   */
  getLatestBlockhash() {
    const lookupStart = performance.now();
    const isValid = this.isBlockhashValid();
    const lookupMs = performance.now() - lookupStart;

    if (!this.latestBlockhash) {
      return null;
    }

    return {
      blockhash: this.latestBlockhash,
      lastValidBlockHeight: this.lastValidBlockHeight,
      currentBlockHeight: this.currentBlockHeight,
      fetchedAt: this.lastFetchedAt,
      isValid,
      lookupMs,
    };
  }

  /**
   * Retrieves a valid blockhash synchronously from RAM if valid,
   * or triggers a synchronous refresh before signing if missing, invalid, or near expiration.
   * @returns {Promise<{ blockhash: string, lastValidBlockHeight: number, fetchedAt: number, lookupMs: number, refreshMs?: number }>}
   */
  async getOrRefreshBlockhash() {
    const lookupStart = performance.now();
    if (this.isBlockhashValid()) {
      return {
        blockhash: this.latestBlockhash,
        lastValidBlockHeight: this.lastValidBlockHeight,
        currentBlockHeight: this.currentBlockHeight,
        fetchedAt: this.lastFetchedAt,
        lookupMs: performance.now() - lookupStart,
      };
    }

    const refreshStart = performance.now();
    await this.refreshBlockhash();
    const refreshMs = performance.now() - refreshStart;

    return {
      blockhash: this.latestBlockhash,
      lastValidBlockHeight: this.lastValidBlockHeight,
      currentBlockHeight: this.currentBlockHeight,
      fetchedAt: this.lastFetchedAt,
      lookupMs: performance.now() - lookupStart,
      refreshMs,
    };
  }

  /**
   * Actively refreshes blockhash and block height from the RPC connection with fallback
   */
  async refreshBlockhash() {
    if (this.isFetching || !this.connection) return;
    this.isFetching = true;
    try {
      const heightPromise = typeof this.connection.getBlockHeight === 'function'
        ? this.connection.getBlockHeight('confirmed').catch(() => null)
        : Promise.resolve(null);

      const [res, currentHeight] = await Promise.all([
        this.connection.getLatestBlockhash('confirmed'),
        heightPromise,
      ]);

      if (res && res.blockhash) {
        this.latestBlockhash = res.blockhash;
        this.lastValidBlockHeight = res.lastValidBlockHeight;
        this.currentBlockHeight = currentHeight || (res.lastValidBlockHeight ? res.lastValidBlockHeight - 150 : null);
        this.lastFetchedAt = Date.now();
      }
    } catch (err) {
      // Try fallback connections if configured
      for (const fallback of this.fallbackConnections) {
        try {
          const heightPromise = typeof fallback.getBlockHeight === 'function'
            ? fallback.getBlockHeight('confirmed').catch(() => null)
            : Promise.resolve(null);

          const [res, currentHeight] = await Promise.all([
            fallback.getLatestBlockhash('confirmed'),
            heightPromise,
          ]);
          if (res && res.blockhash) {
            this.latestBlockhash = res.blockhash;
            this.lastValidBlockHeight = res.lastValidBlockHeight;
            this.currentBlockHeight = currentHeight || (res.lastValidBlockHeight ? res.lastValidBlockHeight - 150 : null);
            this.lastFetchedAt = Date.now();
            break;
          }
        } catch (_) {}
      }
    } finally {
      this.isFetching = false;
    }
  }
}

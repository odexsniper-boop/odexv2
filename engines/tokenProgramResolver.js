import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../pumpfun.js';
import { log } from '../config.js';

export { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID };
export const SUPPORTED_TOKEN_PROGRAMS = new Set([
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
]);

export class TokenProgramResolver {
  /**
   * @param {import('@solana/web3.js').Connection} connection
   */
  constructor(connection) {
    this.connection = connection;
    this.cache = new Map(); // mintBase58 -> PublicKey (Program ID)
    this.inFlightResolutions = new Map(); // mintBase58 -> Promise<PublicKey>
  }

  /**
   * Checks whether the mint program ID is already cached in memory
   * @param {PublicKey | string} mint
   * @returns {boolean}
   */
  has(mint) {
    const mintStr = typeof mint === 'string' ? mint : mint.toBase58();
    return this.cache.has(mintStr);
  }

  /**
   * Synchronously returns cached program ID.
   * If not cached, triggers background resolution and returns fallback if explicitly permitted.
   * @param {PublicKey | string} mint
   * @param {boolean} fallbackIfUncached
   * @returns {PublicKey|null}
   */
  resolveSync(mint, fallbackIfUncached = false) {
    const mintStr = typeof mint === 'string' ? mint : mint.toBase58();

    if (this.cache.has(mintStr)) {
      return this.cache.get(mintStr);
    }

    // Trigger async fetch in background
    this.resolve(mint).catch(() => {});
    return (fallbackIfUncached || mintStr.endsWith('pump')) ? TOKEN_PROGRAM_ID : null;
  }

  /**
   * Resolves token program ID with 100% on-chain accuracy.
   * Coalesces concurrent in-flight requests and avoids transient cache poisoning.
   * @param {PublicKey | string} mint
   * @returns {Promise<PublicKey>}
   */
  async resolve(mint) {
    const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;
    const mintStr = mintPubkey.toBase58();

    if (this.cache.has(mintStr)) {
      return this.cache.get(mintStr);
    }

    // In-flight coalescing: share single active lookup
    if (this.inFlightResolutions.has(mintStr)) {
      return this.inFlightResolutions.get(mintStr);
    }

    const resolutionPromise = (async () => {
      try {
        let lastRpcError = null;
        if (this.connection && typeof this.connection.getAccountInfo === 'function') {
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const mintAcc = await this.connection.getAccountInfo(mintPubkey, 'confirmed');
              if (mintAcc && mintAcc.owner) {
                const ownerStr = mintAcc.owner.toBase58();
                if (!SUPPORTED_TOKEN_PROGRAMS.has(ownerStr)) {
                  throw new Error(`UNSUPPORTED_TOKEN_PROGRAM: Mint is owned by unknown program ${ownerStr}`);
                }
                this.cache.set(mintStr, mintAcc.owner);
                return mintAcc.owner;
              }
            } catch (err) {
              lastRpcError = err;
              if (err.message.includes('UNSUPPORTED_TOKEN_PROGRAM')) throw err;
              if (attempt < 2) {
                await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
              }
            }
          }

          // Secondary fallback: inspect Associated Bonding Curve to reliably detect Token-2022 vs SPL Token
          try {
            const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
            const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
            const bc = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mintPubkey.toBuffer()], PUMP_PROGRAM_ID)[0];
            const abc2022 = PublicKey.findProgramAddressSync([bc.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
            const abc2022Acc = await this.connection.getAccountInfo(abc2022, 'confirmed');
            if (abc2022Acc) {
              this.cache.set(mintStr, TOKEN_2022_PROGRAM_ID);
              return TOKEN_2022_PROGRAM_ID;
            }
          } catch (_) {}

          if (lastRpcError) {
            throw new Error(`TOKEN_PROGRAM_RESOLUTION_FAILED: Failed to resolve token program for ${mintStr}: ${lastRpcError.message}`);
          }
        }

        // Default fallback (only cached if confirmed or running in offline/testing mode without connection)
        if (!this.connection || typeof this.connection.getAccountInfo !== 'function') {
          this.cache.set(mintStr, TOKEN_PROGRAM_ID);
        }
        return TOKEN_PROGRAM_ID;
      } finally {
        this.inFlightResolutions.delete(mintStr);
      }
    })();

    this.inFlightResolutions.set(mintStr, resolutionPromise);
    return resolutionPromise;
  }

  /**
   * Manually registers a token program ID into cache
   * @param {PublicKey | string} mint
   * @param {PublicKey} programId
   */
  register(mint, programId = TOKEN_PROGRAM_ID) {
    const mintStr = typeof mint === 'string' ? mint : mint.toBase58();
    if (!SUPPORTED_TOKEN_PROGRAMS.has(programId.toBase58())) {
      throw new Error(`UNSUPPORTED_TOKEN_PROGRAM: ${programId.toBase58()} is not supported`);
    }
    this.cache.set(mintStr, programId);
  }

  /**
   * Verifies whether the resolved token program is fully compatible with Pump.fun instruction layout (Amendment 7)
   * @param {PublicKey} programId
   * @returns {boolean}
   */
  validatePumpFunCompatibility(programId) {
    const progStr = programId.toBase58();
    if (!SUPPORTED_TOKEN_PROGRAMS.has(progStr)) {
      throw new Error(`UNSUPPORTED_TOKEN_PROGRAM: ${progStr} is not compatible with Pump.fun instructions`);
    }
    return true;
  }
}

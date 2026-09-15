import { PublicKey } from '@solana/web3.js';
import {
  PUMP_PROGRAM_ID,
  PUMP_GLOBAL,
  PUMP_FEE_RECIPIENT,
  PUMP_MAYHEM_FEE_RECIPIENT,
  PUMP_EVENT_AUTHORITY,
  FEE_PROGRAM,
  PUMP_BUYBACK_FEE_RECIPIENTS,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getBondingCurvePDA,
  getAssociatedBondingCurvePDA,
} from '../pumpfun.js';
import { log } from '../config.js';

export class ExecutionCache {
  /**
   * @param {import('@solana/web3.js').Connection} connection
   * @param {object} [options]
   */
  constructor(connection, options = {}) {
    this.connection = connection;
    this.refreshIntervalMs = options.refreshIntervalMs || 30_000; // 30s background cache refresh

    // Global state cache
    this.feeRecipient = PUMP_FEE_RECIPIENT;
    this.mayhemFeeRecipient = PUMP_MAYHEM_FEE_RECIPIENT;
    this.buybackRecipients = [...PUMP_BUYBACK_FEE_RECIPIENTS];
    this.isGlobalStateLoaded = false;
    this.lastGlobalRefreshAt = 0;

    // Pre-computed static PDAs
    this.globalVolumeAccumulator = PublicKey.findProgramAddressSync(
      [Buffer.from('global_volume_accumulator')],
      PUMP_PROGRAM_ID
    )[0];

    this.feeConfig = PublicKey.findProgramAddressSync(
      [Buffer.from('fee_config'), PUMP_PROGRAM_ID.toBuffer()],
      FEE_PROGRAM
    )[0];

    // Per-mint and per-wallet memoization caches
    this.mintPdasCache = new Map(); // mintKey -> { bc, abc, bcv2 }
    this.userPdasCache = new Map(); // userStr -> { uva, atas: Map<mintKey, ata> }
    this.creatorVaultCache = new Map(); // creatorStr -> creatorVaultPDA
    this.mintMetaCache = new Map(); // mintStr -> { creator, isMayhemMode }
    this.reservesCache = new Map(); // mintStr -> { virtualSol, virtualToken, lastUpdated }

    this.timer = null;
  }

  /**
   * Starts background refreshing of PUMP_GLOBAL state
   */
  start() {
    if (this.timer) return;
    this.refreshGlobalState().catch(() => {});
    this.timer = setInterval(() => {
      this.refreshGlobalState().catch(() => {});
    }, this.refreshIntervalMs);
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Registers mint metadata (creator, isMayhemMode) in RAM
   */
  registerToken(mint, { creator = null, isMayhemMode = false } = {}) {
    const mintStr = typeof mint === 'string' ? mint : mint.toBase58();
    const existing = this.mintMetaCache.get(mintStr) || {};
    this.mintMetaCache.set(mintStr, {
      creator: creator || existing.creator || null,
      isMayhemMode: isMayhemMode ?? existing.isMayhemMode ?? false,
    });
  }

  getTokenMeta(mint) {
    const mintStr = typeof mint === 'string' ? mint : mint.toBase58();
    return this.mintMetaCache.get(mintStr) || null;
  }

  /**
   * Pre-warms in-memory execution state as soon as a token is discovered
   */
  prewarmToken(mint, { creator = null, isMayhemMode = false } = {}) {
    this.registerToken(mint, { creator, isMayhemMode });
    if (creator) {
      this.getCreatorVault(creator);
    }
  }

  /**
   * Updates live bonding curve reserves in RAM
   * @param {string | PublicKey} mint
   * @param {bigint | number | string} virtualSolReserves
   * @param {bigint | number | string} virtualTokenReserves
   * @param {string} [source='live_stream']
   */
  updateReserves(mint, virtualSolReserves, virtualTokenReserves, source = 'live_stream') {
    const mintStr = typeof mint === 'string' ? mint : mint.toBase58();
    this.reservesCache.set(mintStr, {
      virtualSolReserves: BigInt(virtualSolReserves),
      virtualTokenReserves: BigInt(virtualTokenReserves),
      lastUpdated: Date.now(),
      source,
    });
  }

  /**
   * Retrieves live bonding curve reserves from RAM synchronously.
   * Returns null if missing or older than maxAgeMs (default: 5000ms).
   */
  getReserves(mint, maxAgeMs = 5000) {
    const startLookup = performance.now();
    const mintStr = typeof mint === 'string' ? mint : mint.toBase58();
    const entry = this.reservesCache.get(mintStr);
    const lookupMs = performance.now() - startLookup;
    if (!entry) return null;
    if (Date.now() - entry.lastUpdated > maxAgeMs) {
      return { ...entry, isStale: true, lookupMs };
    }
    return { ...entry, isStale: false, lookupMs };
  }

  /**
   * Resolves creator vault PDA from token creator's public key synchronously from in-memory cache
   */
  getCreatorVault(creatorPubkey) {
    if (!creatorPubkey) return null;
    const creatorPub = typeof creatorPubkey === 'string' ? new PublicKey(creatorPubkey) : creatorPubkey;
    const creatorStr = creatorPub.toBase58();

    let cv = this.creatorVaultCache.get(creatorStr);
    if (!cv) {
      cv = PublicKey.findProgramAddressSync(
        [Buffer.from('creator-vault'), creatorPub.toBuffer()],
        PUMP_PROGRAM_ID
      )[0];
      this.creatorVaultCache.set(creatorStr, cv);
    }
    return cv;
  }

  /**
   * Refreshes PUMP_GLOBAL account data asynchronously in the background
   */
  async refreshGlobalState() {
    if (!this.connection) return;
    try {
      const globalAccount = await this.connection.getAccountInfo(PUMP_GLOBAL);
      if (globalAccount && globalAccount.data) {
        if (globalAccount.data.length >= 515) {
          this.mayhemFeeRecipient = new PublicKey(globalAccount.data.slice(483, 515));
        }
        if (globalAccount.data.length >= 997) {
          const fresh = [];
          for (let j = 0; j < 8; j++) {
            fresh.push(new PublicKey(globalAccount.data.slice(741 + j * 32, 741 + (j + 1) * 32)));
          }
          if (fresh.length === 8) {
            this.buybackRecipients = fresh;
          }
        }
        this.isGlobalStateLoaded = true;
        this.lastGlobalRefreshAt = Date.now();
      }
    } catch (err) {
      // Keep using default/cached recipients
    }
  }

  /**
   * Resolves or retrieves cached mint PDAs in 0ms (bondingCurve, associatedBondingCurve, bondingCurveV2)
   */
  getMintPDAs(mintPubkey, tokenProgramId) {
    const mintStr = mintPubkey.toBase58();
    const tokenProgStr = tokenProgramId.toBase58();
    const cacheKey = `${mintStr}:${tokenProgStr}`;

    const cached = this.mintPdasCache.get(cacheKey);
    if (cached) return cached;

    const bc = getBondingCurvePDA(mintPubkey);
    const abc = getAssociatedBondingCurvePDA(mintPubkey, bc, tokenProgramId);
    const bcv2 = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve-v2'), mintPubkey.toBuffer()],
      PUMP_PROGRAM_ID
    )[0];

    const result = { bc, abc, bcv2 };
    this.mintPdasCache.set(cacheKey, result);
    return result;
  }

  /**
   * Resolves or retrieves cached user PDAs in 0ms (userVolumeAccumulator, userAta)
   */
  getUserPDAs(userPubkey, mintPubkey, tokenProgramId) {
    const userStr = userPubkey.toBase58();
    let userEntry = this.userPdasCache.get(userStr);

    if (!userEntry) {
      const uva = PublicKey.findProgramAddressSync(
        [Buffer.from('user_volume_accumulator'), userPubkey.toBuffer()],
        PUMP_PROGRAM_ID
      )[0];

      userEntry = {
        uva,
        atas: new Map(),
      };
      this.userPdasCache.set(userStr, userEntry);
    }

    const ataKey = `${mintPubkey.toBase58()}:${tokenProgramId.toBase58()}`;
    let ata = userEntry.atas.get(ataKey);
    if (!ata) {
      ata = PublicKey.findProgramAddressSync(
        [userPubkey.toBuffer(), tokenProgramId.toBuffer(), mintPubkey.toBuffer()],
        ASSOCIATED_TOKEN_PROGRAM_ID
      )[0];
      userEntry.atas.set(ataKey, ata);
    }

    return {
      creatorVault: this.getCreatorVault(userPubkey),
      userVolumeAccumulator: userEntry.uva,
      userAta: ata,
    };
  }

  /**
   * Synchronously returns fee recipients based on mayhem mode flag
   */
  getFeeRecipients(isMayhemMode = false) {
    return {
      feeRecipient: isMayhemMode ? this.mayhemFeeRecipient : this.feeRecipient,
      buybackRecipients: this.buybackRecipients,
    };
  }
}

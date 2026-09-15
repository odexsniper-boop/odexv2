import { PublicKey } from '@solana/web3.js';
import { PUMP_PROGRAM_ID, getBondingCurvePDA, getAssociatedBondingCurvePDA } from '../pumpfun.js';
import { eventBus } from '../eventBus.js';
import { log } from '../config.js';

// Instruction 8-byte discriminator for Pump.fun "create"
// [24, 30, 200, 40, 5, 28, 7, 119]
const CREATE_DISCRIMINATOR = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]);

export class TokenDetector {
  /**
   * Fast-path parser for raw Solana transaction or Geyser instruction
   */
  static parseLaunchTransaction(tx) {
    if (!tx || !tx.transaction || !tx.meta) return null;

    const message = tx.transaction.message;
    const accountKeys = message.staticAccountKeys || message.accountKeys || [];
    const instructions = message.compiledInstructions || message.instructions || [];

    for (const ix of instructions) {
      const programId = accountKeys[ix.programIdIndex];
      if (!programId || !programId.equals(PUMP_PROGRAM_ID)) continue;

      const data = Buffer.from(ix.data);
      // Check if it matches "create" discriminator
      if (data.length >= 8 && data.subarray(0, 8).equals(CREATE_DISCRIMINATOR)) {
        // Extract accounts:
        // 0: mint
        // 1: mintAuthority
        // 2: bondingCurve
        // 3: associatedBondingCurve
        // 4: global
        // 5: mplTokenMetadata
        // 6: user (creator)
        const mint = accountKeys[ix.accountKeyIndexes[0]];
        const creator = accountKeys[ix.accountKeyIndexes[6]];
        const bondingCurve = accountKeys[ix.accountKeyIndexes[2]] || getBondingCurvePDA(mint);

        // Check if there was an initial dev buy in the same transaction
        let devBuySol = 0;
        let bundleCount = 0;
        const buyerAccounts = new Set();

        // Scan sibling instructions for immediate buys
        for (const siblingIx of instructions) {
          const siblingProg = accountKeys[siblingIx.programIdIndex];
          if (siblingProg && siblingProg.equals(PUMP_PROGRAM_ID)) {
            const siblingData = Buffer.from(siblingIx.data);
            if (siblingData.length >= 8 && siblingData.subarray(0, 8).equals(Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]))) {
              // Buy instruction
              bundleCount++;
              const buyer = accountKeys[siblingIx.accountKeyIndexes[6]];
              if (buyer) {
                buyerAccounts.add(buyer.toBase58());
                if (creator && buyer.equals(creator)) {
                  // Dev bought
                  devBuySol += 1; // Mark dev participation
                }
              }
            }
          }
        }

        // Estimate bundle share (typical curve initial virtual token reserves = 1,073,000,000 tokens)
        // Bundled buy instructions in same slot
        const bundlePercent = Math.min(100, bundleCount * 3.5); // ~3.5% per sniper bundle
        const isMultiWalletBundle = bundleCount >= 3 && buyerAccounts.size >= 2;

        const launchEvent = {
          mint: mint.toBase58(),
          creator: creator ? creator.toBase58() : 'UNKNOWN',
          bondingCurve: bondingCurve.toBase58(),
          slot: tx.slot,
          blockTime: tx.blockTime,
          devBought: devBuySol > 0,
          bundledBuysCount: bundleCount,
          bundlePercent,
          isMultiWalletBundle,
          uniqueBuyersInBundle: buyerAccounts.size,
          rawTx: tx,
          timestamp: Date.now(),
        };

        eventBus.emit('TOKEN_DETECTED', launchEvent);
        log(`[TOKEN DETECTED] Mint: ${launchEvent.mint.slice(0, 8)}... | Creator: ${launchEvent.creator.slice(0, 8)}... | Bundle Buys: ${bundleCount}`);
        return launchEvent;
      }
    }

    return null;
  }
}

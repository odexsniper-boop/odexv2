import { VersionedTransaction, PublicKey } from '@solana/web3.js';
import fetch from 'node-fetch';
import { log } from '../config.js';

export class PumpPortalBuilder {
  constructor(executionCache, tokenResolver) {
    this.cache = executionCache;
    this.tokenResolver = tokenResolver;
  }

  async buildSignedBuyTransaction({
    wallet,
    mint,
    tokenAmount, 
    maxSolCostLamports,
    creator = null,
    tokenProgramId = null,
    computeUnits = 120_000,
    priorityFeeMicroLamports = 100_000,
    includeJitoTip = true,
    jitoTipLamports = 10_000_000,
    isMayhemMode = null,
  }) {
    const buildStart = performance.now();
    const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;
    const mintStr = mintPubkey.toBase58();
    const solAmount = Number(maxSolCostLamports) / 1e9;
    const priorityFee = Number(priorityFeeMicroLamports) / 1e9;

    const response = await fetch("https://pumpportal.fun/api/trade-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            publicKey: wallet.publicKey.toBase58(),
            action: "buy",
            mint: mintStr,
            amount: solAmount,
            denominatedInSol: "true",
            slippage: 15,
            priorityFee: priorityFee,
            pool: "pump"
        })
    });

    if (!response.ok) {
        throw new Error(`PumpPortal API Error: ${response.status} ${await response.text()}`);
    }

    const data = await response.arrayBuffer();
    const transaction = VersionedTransaction.deserialize(new Uint8Array(data));
    const buildDurationMs = performance.now() - buildStart;

    const signStart = performance.now();
    transaction.sign([wallet]);
    const wireTransaction = Buffer.from(transaction.serialize());
    const wireBase64 = wireTransaction.toString('base64');
    const signDurationMs = performance.now() - signStart;

    const progIdRaw = tokenProgramId || (await this.tokenResolver.resolveSync(mintPubkey));
    const { userAta } = this.cache.getUserPDAs(wallet.publicKey, mintPubkey, progIdRaw);

    return {
      wireTransaction,
      wireBase64,
      transaction,
      userAta,
      progId: progIdRaw,
      buildDurationMs,
      signDurationMs
    };
  }

  async buildSignedSellTransaction({
    wallet,
    mint,
    tokenAmountRaw,
    minSolOutputLamports,
    tokenProgramId = null,
    computeUnits = 120_000,
    priorityFeeMicroLamports = 100_000,
    includeJitoTip = true,
    jitoTipLamports = 10_000_000,
  }) {
    const buildStart = performance.now();
    const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;
    const mintStr = mintPubkey.toBase58();
    const priorityFee = Number(priorityFeeMicroLamports) / 1e9;

    // The bot typically sells 100% of the bag
    const response = await fetch("https://pumpportal.fun/api/trade-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            publicKey: wallet.publicKey.toBase58(),
            action: "sell",
            mint: mintStr,
            amount: "100%", 
            denominatedInSol: "false",
            slippage: 15,
            priorityFee: priorityFee,
            pool: "pump"
        })
    });

    if (!response.ok) {
        throw new Error(`PumpPortal API Error: ${response.status} ${await response.text()}`);
    }

    const data = await response.arrayBuffer();
    const transaction = VersionedTransaction.deserialize(new Uint8Array(data));
    const buildDurationMs = performance.now() - buildStart;

    const signStart = performance.now();
    transaction.sign([wallet]);
    const wireTransaction = Buffer.from(transaction.serialize());
    const wireBase64 = wireTransaction.toString('base64');
    const signDurationMs = performance.now() - signStart;

    const progIdRaw = tokenProgramId || (await this.tokenResolver.resolveSync(mintPubkey));
    const { userAta } = this.cache.getUserPDAs(wallet.publicKey, mintPubkey, progIdRaw);

    return {
      wireTransaction,
      wireBase64,
      transaction,
      userAta,
      progId: progIdRaw,
      buildDurationMs,
      signDurationMs
    };
  }
}

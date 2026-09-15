import {
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  SystemProgram,
  PublicKey,
} from '@solana/web3.js';
import {
  PUMP_PROGRAM_ID,
  PUMP_GLOBAL,
  PUMP_EVENT_AUTHORITY,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  RENT_PROGRAM_ID,
  FEE_PROGRAM,
  getRandomJitoTipAccount,
} from '../pumpfun.js';

// Instruction 8-byte discriminators for Pump.fun
const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

export class TransactionBuilder {
  /**
   * @param {import('./executionCache.js').ExecutionCache} executionCache
   * @param {import('./blockhashManager.js').BlockhashManager} blockhashManager
   * @param {import('./tokenProgramResolver.js').TokenProgramResolver} tokenResolver
   */
  constructor(executionCache, blockhashManager, tokenResolver) {
    this.cache = executionCache;
    this.blockhashManager = blockhashManager;
    this.tokenResolver = tokenResolver;
  }

  /**
   * Compiles and locally signs a Buy transaction.
   * Enforces strict transparent slippage math (NO hidden +5% cushions).
   */
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
    const startTime = performance.now();
    const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;

    // Resolve token program ID with 100% accuracy (0ms if in RAM)
    const progId = tokenProgramId || (await this.tokenResolver.resolve(mintPubkey));

    let meta = this.cache ? this.cache.getTokenMeta(mintPubkey) : null;
    if ((!meta || !meta.creator) && this.cache && this.cache.connection) {
      try {
        const bcPub = this.cache.getMintPDAs(mintPubkey, progId).bc;
        const bcAcc = await this.cache.connection.getAccountInfo(bcPub);
        if (bcAcc && bcAcc.data && bcAcc.data.length >= 81) {
          const onChainCreator = new PublicKey(bcAcc.data.subarray(49, 81));
          const onChainMayhem = bcAcc.data.length >= 82 ? bcAcc.data.readUInt8(81) === 1 : false;
          this.cache.registerToken(mintPubkey, { creator: onChainCreator, isMayhemMode: onChainMayhem });
          meta = this.cache.getTokenMeta(mintPubkey);
        }
      } catch (e) {}
    }
    const resolvedCreator = (meta && meta.creator) ? meta.creator : (creator || wallet.publicKey);
    const resolvedMayhem = isMayhemMode !== null ? isMayhemMode : (meta ? meta.isMayhemMode : false);

    // Cached PDAs
    const { bc, abc, bcv2 } = this.cache.getMintPDAs(mintPubkey, progId);
    const { userVolumeAccumulator, userAta } = this.cache.getUserPDAs(
      wallet.publicKey,
      mintPubkey,
      progId
    );
    const creatorVault = this.cache.getCreatorVault(resolvedCreator);
    const { feeRecipient, buybackRecipients } = this.cache.getFeeRecipients(resolvedMayhem);

    const tx = new Transaction();

    // 1. Compute budget & priority fees
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }));
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }));

    // 2. Idempotent ATA create instruction (derived with the correct token program ID!)
    tx.add(
      new TransactionInstruction({
        programId: ASSOCIATED_TOKEN_PROGRAM_ID,
        keys: [
          { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
          { pubkey: userAta, isSigner: false, isWritable: true },
          { pubkey: wallet.publicKey, isSigner: false, isWritable: false },
          { pubkey: mintPubkey, isSigner: false, isWritable: false },
          { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: progId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([1]), // CreateIdempotent
      })
    );

    // 3. Pump.fun Buy instruction data
    const data = Buffer.alloc(24);
    BUY_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(BigInt(tokenAmount), 8);
    data.writeBigUInt64LE(BigInt(maxSolCostLamports), 16);

    const buyKeys = [
      { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false }, // 0
      { pubkey: feeRecipient, isSigner: false, isWritable: true }, // 1
      { pubkey: mintPubkey, isSigner: false, isWritable: false }, // 2
      { pubkey: bc, isSigner: false, isWritable: true }, // 3
      { pubkey: abc, isSigner: false, isWritable: true }, // 4
      { pubkey: userAta, isSigner: false, isWritable: true }, // 5
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // 6
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false }, // 7
      { pubkey: progId, isSigner: false, isWritable: false }, // 8 token_program
      { pubkey: creatorVault, isSigner: false, isWritable: true }, // 9 creator_vault
      { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false }, // 10
      { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false }, // 11
      { pubkey: this.cache.globalVolumeAccumulator, isSigner: false, isWritable: false }, // 12
      { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true }, // 13
      { pubkey: this.cache.feeConfig, isSigner: false, isWritable: false }, // 14
      { pubkey: FEE_PROGRAM, isSigner: false, isWritable: false }, // 15
    ];
    buyKeys.push({ pubkey: bcv2, isSigner: false, isWritable: true });
    for (const recipient of buybackRecipients) {
      buyKeys.push({ pubkey: recipient, isSigner: false, isWritable: true });
    }

    tx.add(
      new TransactionInstruction({
        programId: PUMP_PROGRAM_ID,
        keys: buyKeys,
        data,
      })
    );

    // 4. Jito tip instruction (ONLY added if using Jito route and configured)
    if (includeJitoTip && jitoTipLamports > 0) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: getRandomJitoTipAccount(),
          lamports: jitoTipLamports,
        })
      );
    }

    // 5. Blockhash & Local signing (Block-height verified, Amendment 1 & 16)
    let blockhashInfo = null;
    if (this.blockhashManager) {
      blockhashInfo = await this.blockhashManager.getOrRefreshBlockhash();
    }
    if (blockhashInfo) {
      tx.recentBlockhash = blockhashInfo.blockhash;
      tx.lastValidBlockHeight = blockhashInfo.lastValidBlockHeight;
    }
    tx.feePayer = wallet.publicKey;

    const signStart = performance.now();
    let signedTx = tx;
    if (typeof wallet.signTransaction === 'function') {
      signedTx = (await wallet.signTransaction(tx)) || tx;
    } else {
      tx.sign(wallet);
      signedTx = tx;
    }
    const signDurationMs = performance.now() - signStart;

    const wireTransaction = Buffer.from(signedTx.serialize());
    const wireBase64 = wireTransaction.toString('base64');
    const buildDurationMs = performance.now() - startTime;

    return {
      transaction: signedTx,
      wireTransaction,
      wireBase64,
      userAta,
      progId,
      creatorVault,
      buildDurationMs,
      signDurationMs,
      blockhash: tx.recentBlockhash,
    };
  }

  /**
   * Compiles and locally signs a Sell transaction
   */
  async buildSignedSellTransaction({
    wallet,
    mint,
    tokenAmount,
    minSolOutputLamports,
    creator = null,
    tokenProgramId = null,
    computeUnits = 100_000,
    priorityFeeMicroLamports = 100_000,
    includeJitoTip = true,
    jitoTipLamports = 10_000_000,
    isMayhemMode = null,
  }) {
    const startTime = performance.now();
    const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;

    const progId = tokenProgramId || (await this.tokenResolver.resolve(mintPubkey));

    let meta = this.cache ? this.cache.getTokenMeta(mintPubkey) : null;
    if ((!meta || !meta.creator) && this.cache && this.cache.connection) {
      try {
        const bcPub = this.cache.getMintPDAs(mintPubkey, progId).bc;
        const bcAcc = await this.cache.connection.getAccountInfo(bcPub);
        if (bcAcc && bcAcc.data && bcAcc.data.length >= 81) {
          const onChainCreator = new PublicKey(bcAcc.data.subarray(49, 81));
          const onChainMayhem = bcAcc.data.length >= 82 ? bcAcc.data.readUInt8(81) === 1 : false;
          this.cache.registerToken(mintPubkey, { creator: onChainCreator, isMayhemMode: onChainMayhem });
          meta = this.cache.getTokenMeta(mintPubkey);
        }
      } catch (e) {}
    }
    const resolvedCreator = (meta && meta.creator) ? meta.creator : (creator || wallet.publicKey);
    const resolvedMayhem = isMayhemMode !== null ? isMayhemMode : (meta ? meta.isMayhemMode : false);

    const { bc, abc, bcv2 } = this.cache.getMintPDAs(mintPubkey, progId);
    const { userVolumeAccumulator, userAta } = this.cache.getUserPDAs(
      wallet.publicKey,
      mintPubkey,
      progId
    );
    const creatorVault = this.cache.getCreatorVault(resolvedCreator);
    const { feeRecipient, buybackRecipients } = this.cache.getFeeRecipients(resolvedMayhem);

    const tx = new Transaction();

    // 1. Compute budget & priority fees
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }));
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }));

    // 2. Idempotent ATA create instruction (with correct token program ID!)
    tx.add(
      new TransactionInstruction({
        programId: ASSOCIATED_TOKEN_PROGRAM_ID,
        keys: [
          { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
          { pubkey: userAta, isSigner: false, isWritable: true },
          { pubkey: wallet.publicKey, isSigner: false, isWritable: false },
          { pubkey: mintPubkey, isSigner: false, isWritable: false },
          { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: progId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([1]),
      })
    );

    // 3. Pump.fun Sell instruction data
    const data = Buffer.alloc(8 + 8 + 8);
    SELL_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(BigInt(tokenAmount), 8);
    data.writeBigUInt64LE(BigInt(minSolOutputLamports), 16);

    const sellKeys = [
      { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false }, // 0
      { pubkey: feeRecipient, isSigner: false, isWritable: true }, // 1
      { pubkey: mintPubkey, isSigner: false, isWritable: false }, // 2
      { pubkey: bc, isSigner: false, isWritable: true }, // 3
      { pubkey: abc, isSigner: false, isWritable: true }, // 4
      { pubkey: userAta, isSigner: false, isWritable: true }, // 5
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // 6
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false }, // 7
      { pubkey: creatorVault, isSigner: false, isWritable: true }, // 8
      { pubkey: progId, isSigner: false, isWritable: false }, // 9
      { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false }, // 10
      { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false }, // 11
      { pubkey: this.cache.feeConfig, isSigner: false, isWritable: false }, // 12
      { pubkey: FEE_PROGRAM, isSigner: false, isWritable: false }, // 13
    ];
    if (resolvedMayhem) {
      sellKeys.push({ pubkey: userVolumeAccumulator, isSigner: false, isWritable: true });
    }
    sellKeys.push({ pubkey: bcv2, isSigner: false, isWritable: true });
    for (const recipient of buybackRecipients) {
      sellKeys.push({ pubkey: recipient, isSigner: false, isWritable: true });
    }

    tx.add(
      new TransactionInstruction({
        programId: PUMP_PROGRAM_ID,
        keys: sellKeys,
        data,
      })
    );

    // 4. Jito tip instruction (ONLY if routing via Jito)
    if (includeJitoTip && jitoTipLamports > 0) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: getRandomJitoTipAccount(),
          lamports: jitoTipLamports,
        })
      );
    }

    // 5. Blockhash & Local signing (Block-height verified, Amendment 1 & 16)
    let blockhashInfo = null;
    if (this.blockhashManager) {
      blockhashInfo = await this.blockhashManager.getOrRefreshBlockhash();
    }
    if (blockhashInfo) {
      tx.recentBlockhash = blockhashInfo.blockhash;
      tx.lastValidBlockHeight = blockhashInfo.lastValidBlockHeight;
    }
    tx.feePayer = wallet.publicKey;

    const signStart = performance.now();
    let signedTx = tx;
    if (typeof wallet.signTransaction === 'function') {
      signedTx = (await wallet.signTransaction(tx)) || tx;
    } else {
      tx.sign(wallet);
      signedTx = tx;
    }
    const signDurationMs = performance.now() - signStart;

    const wireTransaction = Buffer.from(signedTx.serialize());
    const wireBase64 = wireTransaction.toString('base64');
    const buildDurationMs = performance.now() - startTime;

    return {
      transaction: signedTx,
      wireTransaction,
      wireBase64,
      userAta,
      progId,
      creatorVault,
      buildDurationMs,
      signDurationMs,
      blockhash: tx.recentBlockhash,
    };
  }
}

import crypto from 'crypto';

/**
 * V2 Economic Event Classifier
 * 
 * Purpose: Isolate genuine market swaps from all other on-chain noise.
 * Explicitly excludes virtual liquidity, Jito tips, priority fees, and duplicates.
 */

const JITO_TIP_ACCOUNTS = new Set([
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvVkY',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
    'DfXygSm4jMR5wFMSwD7o692jAyms32gG2tTADeZJj13b',
    'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwTc53',
    'DttWaMuVvTiduZRnguLF7FsBog82KNQAqnR6HkeEMx3o',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBn1rvA25U'
]);

export class EconomicEventClassifier {
    constructor() {
        this.processedCanonicalIds = new Set();
    }

    _hash(str) {
        return crypto.createHash('sha256').update(str).digest('hex');
    }

    classifyTransaction(tx, mint, curvePda, curveTokenAccount) {
        const events = [];
        const sig = tx.signature;
        const slot = tx.slot || 0;
        const txIndex = tx.transactionIndex || 0;
        const timestamp = tx.timestamp || Date.now();

        let curveSolDelta = 0;
        let isCurveSolChanged = false;
        if (tx.accountData) {
            const curveAcct = tx.accountData.find(a => a.account === curvePda);
            if (curveAcct && curveAcct.nativeBalanceChange !== undefined) {
                curveSolDelta = curveAcct.nativeBalanceChange / 1e9;
                isCurveSolChanged = true;
            }
        }

        let cleanTokenVolume = 0;
        let isBuy = false;
        let isSell = false;
        let initiator = null;
        let innerInstructionIndex = 0;
        const evidence = [];

        if (isCurveSolChanged && curveSolDelta > 0) evidence.push('curve_received_SOL');
        if (isCurveSolChanged && curveSolDelta < 0) evidence.push('curve_sent_SOL');

        if (tx.accountData) {
            for (const acct of tx.accountData) {
                if (JITO_TIP_ACCOUNTS.has(acct.account) && acct.nativeBalanceChange > 0) {
                    events.push({ classification: 'MEV_EVENT', source_event_ids: [sig], amount: acct.nativeBalanceChange / 1e9, account: acct.account, slot, transaction_index: txIndex });
                }
                if (acct.account === 'ComputeBudget111111111111111111111111111111') {
                    events.push({ classification: 'FEE_EVENT', source_event_ids: [sig], evidence: ['ComputeBudget usage'], slot, transaction_index: txIndex });
                }
            }
        }

        if (tx.tokenTransfers) {
            for (const transfer of tx.tokenTransfers) {
                if (transfer.mint !== mint) continue;
                innerInstructionIndex++;

                if (transfer.fromUserAccount === curvePda || transfer.fromTokenAccount === curveTokenAccount) {
                    isBuy = true;
                    cleanTokenVolume += transfer.tokenAmount;
                    initiator = transfer.toUserAccount;
                    evidence.push('curve_sent_tokens');
                }
                
                if (transfer.toUserAccount === curvePda || transfer.toTokenAccount === curveTokenAccount) {
                    if (transfer.tokenAmount >= 700000000) { 
                        events.push({
                            classification: 'VIRTUAL_LIQUIDITY_EVENT',
                            source_event_ids: [sig],
                            cleanTokenVolume: transfer.tokenAmount,
                            cleanSOLVolume: 30.0,
                            slot, transaction_index: txIndex
                        });
                        return events;
                    } else {
                        isSell = true;
                        cleanTokenVolume += transfer.tokenAmount;
                        initiator = transfer.fromUserAccount;
                        evidence.push('curve_received_tokens');
                    }
                }
            }
        }

        if (curveSolDelta !== 0 && cleanTokenVolume > 0) {
            const cleanSOLVolume = Math.abs(curveSolDelta);
            const side = isBuy ? 'BUY' : (isSell ? 'SELL' : null);
            const flowDirectionMatch = (curveSolDelta > 0 && isBuy) || (curveSolDelta < 0 && isSell);
            
            if (flowDirectionMatch) {
                evidence.push('valid_trade_instruction');
                const canonicalStr = `${sig}-${slot}-${txIndex}-0-${innerInstructionIndex}-${mint}-${initiator}-${side}`;
                const canonical_event_id = this._hash(canonicalStr);

                if (this.processedCanonicalIds.has(canonical_event_id)) {
                    events.push({ classification: 'DUPLICATE_EVENT', canonical_event_id, source_event_ids: [sig], evidence: ['Transaction signature and inner instruction already processed'], slot, transaction_index: txIndex });
                    return events;
                }
                this.processedCanonicalIds.add(canonical_event_id);

                events.push({
                    classification: 'ECONOMIC_TRADE',
                    side,
                    confidence: 0.99,
                    evidence,
                    canonical_event_id,
                    source_event_ids: [sig],
                    cleanSOLVolume,
                    cleanTokenVolume,
                    effectivePrice: cleanSOLVolume / cleanTokenVolume,
                    initiator: initiator || tx.feePayer,
                    event_time: timestamp,
                    slot,
                    transaction_index: txIndex,
                    instruction_index: 0,
                    inner_instruction_index: innerInstructionIndex,
                    historical_availability_timestamp: Date.now()
                });
            } else {
                events.push({ classification: 'OTHER', source_event_ids: [sig], evidence: ['Conflicting flow direction'], cleanSOLVolume: curveSolDelta, slot, transaction_index: txIndex });
            }
        } else {
            if (!events.some(e => e.classification === 'VIRTUAL_LIQUIDITY_EVENT' || e.classification === 'MEV_EVENT' || e.classification === 'FEE_EVENT')) {
                events.push({ classification: 'SYSTEM_EVENT', source_event_ids: [sig], evidence: ['No economic exchange with AMM'], slot, transaction_index: txIndex });
            }
        }
        return events;
    }
}

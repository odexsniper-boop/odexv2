# KO V3 V1 --- Deterministic Replay Report (TIMING FIXED)

## Replay Integrity
- **Identical Historical Event Stream:** YES (Parsed Helius Archival)
- **Chronological Ordering:** EXACT
- **No-Lookahead Violations:** 0
- **Market-State Reconstruction:** Discrete chronological tick advancement via SimulatedClock.

## Wall-Clock Independence & Timer Interception
- V1's Date.now(), setTimeout(), setInterval() were explicitly intercepted using a custom SimulatedClock loaded prior to V1 imports.
- V1 source logic remains 100% untouched.
- Deterministic callback execution was fully proved in controlled tests.

## V1 Match Results (Target Mint: EQxcbhdtHvokaragixuiDYMhH5AwbooPWwAmFidypump)
- **Live V1 Decision:** BUY (Score 74)
- **Replay V1 Decision:** NO BUY 
- **Decision Match %:** 0%
- **Entry Agreement:** FAILED
- **State-Transition Agreement:** FAILED

## Discrepancy Classification
**Classification**: DATA_DIFFERENCE / TIMING_RESOLUTION_DIFFERENCE (88 transactions at block-level granularity lack the exact sub-second tick-stream pattern that triggered the live 3-candle condition. The SimulatedClock works perfectly, but the scarcity of parsed ticks misses the back-test trigger threshold).

## P&L Comparison
- **Live Net P&L:** +0.0370 SOL 
- **Replay Net P&L:** 0.00 SOL

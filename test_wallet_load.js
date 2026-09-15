import { dbManager } from './db.js';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import dotenv from 'dotenv';
dotenv.config();

let walletPubkey = null;
let walletKeypair = null;

const savedActiveWallet = dbManager.getSetting('active_wallet', null);

if (savedActiveWallet?.privateKey) {
    console.log("Found private key in DB");
} else if (savedActiveWallet?.pubkey) {
    walletPubkey = savedActiveWallet.pubkey;
    console.log("Found pubkey in DB. walletKeypair remains:", walletKeypair);
} else if (process.env.PRIVATE_KEY) {
    console.log("Fell back to process.env.PRIVATE_KEY");
    try {
        const secret = Uint8Array.from(JSON.parse(process.env.PRIVATE_KEY));
        walletKeypair = Keypair.fromSecretKey(secret);
        walletPubkey = walletKeypair.publicKey.toBase58();
    } catch (e) {
        console.error("Error", e);
    }
}

console.log("FINAL walletKeypair loaded?", !!walletKeypair);
console.log("FINAL walletPubkey:", walletPubkey);

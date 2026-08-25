/**
 * Generate a throwaway deployer key locally.
 *   npm run wallet:new
 *
 * Nothing leaves this machine. Copy the private key into .env, fund the address from a
 * Sepolia faucet, and treat it as disposable - it is a testnet key, not a wallet.
 */
const { ethers } = require("hardhat");

const w = ethers.Wallet.createRandom();

console.log("");
console.log("  address      " + w.address);
console.log("  private key  " + w.privateKey);
console.log("");
console.log("  1. Put it in .env:   PRIVATE_KEY=" + w.privateKey);
console.log("  2. Fund the address at one of:");
console.log("       https://www.alchemy.com/faucets/ethereum-sepolia");
console.log("       https://cloud.google.com/application/web3/faucet/ethereum/sepolia");
console.log("       https://sepoliafaucet.io");
console.log("  3. npm run preflight");
console.log("");
console.log("  This key becomes the platform's root admin. Never reuse it on mainnet.");
console.log("");

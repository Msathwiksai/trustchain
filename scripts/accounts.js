/**
 * Print the seeded demo accounts with the private keys to import into MetaMask.
 *   npm run accounts
 *
 * These are the well-known Hardhat development keys. They are public by design and
 * must never hold real funds.
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const MNEMONIC = "test test test test test test test test test test test junk";

function main() {
  const file = path.join(__dirname, "..", "deployments", "localhost.json");
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  if (!cfg?.accounts) {
    console.log("No deployments/localhost.json yet - run `npm run seed:local` first.");
    return;
  }

  const wallets = new Map();
  for (let i = 0; i < 10; i++) {
    const w = ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`);
    wallets.set(w.address.toLowerCase(), w.privateKey);
  }

  console.log(`\nNetwork      ${cfg.network} (chain id ${cfg.chainId}) at http://127.0.0.1:8545`);
  console.log(`AssetNFT     ${cfg.assetNFT}\n`);
  console.log("Import these into MetaMask (Account menu -> Import account -> Private key):\n");
  for (const a of cfg.accounts) {
    console.log(`  ${a.name.padEnd(9)} ${a.role.padEnd(8)} ${a.address}`);
    console.log(`  ${" ".repeat(18)}${wallets.get(a.address.toLowerCase()) ?? "(not a default hardhat account)"}\n`);
  }
  console.log("If you restart the node, use MetaMask -> Settings -> Advanced -> Clear activity");
  console.log("to reset the cached nonces, otherwise transactions will hang as pending.\n");
}

main();

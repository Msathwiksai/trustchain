/**
 * Read the platform straight off the blockchain, in a terminal, with no wallet, no key,
 * no server of ours and no permission from anybody.
 *
 * Deliberately plain Node: it talks to a public Ethereum endpoint over HTTPS and carries
 * its own minimal ABI, so it needs neither Hardhat, nor compiled artifacts, nor a .env.
 * Anyone can run it on any machine and get the same answer we do - which is the entire
 * claim the platform makes, demonstrated rather than asserted.
 *
 *   node scripts/chain.js                     the whole platform
 *   node scripts/chain.js audit 20            the last 20 recorded actions
 *   node scripts/chain.js blocks              the blocks, and how each names the one before
 *   node scripts/chain.js verify 5 <file>     hash a real file and ask the contract
 */
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "sepolia.json"), "utf8"));
const RPC = process.env.RPC_URL || cfg.rpcUrl || "https://ethereum-sepolia-rpc.publicnode.com";

// Only the read functions this script calls - the full ABI is in the repo and on Etherscan.
const ABI = {
  did: [
    "function allDids(uint256,uint256) view returns (bytes32[])",
    "function resolve(bytes32) view returns (tuple(address controller,uint64 createdAt,uint64 updatedAt,bool revoked,string docURI))",
  ],
  roles: ["function rolesOfDid(bytes32) view returns (bytes32[])", "function permissionsOf(address) view returns (uint256)"],
  assets: [
    "function totalMinted() view returns (uint256)",
    "function assetOf(uint256) view returns (tuple(bytes32 issuerDid,bytes32 originDid,bytes32 currentDid,bytes32 assetHash,uint64 mintedAt,bool soulbound,bool frozen,bool revoked,string category))",
    "function verify(uint256,bytes32) view returns (uint8,bool,bytes32,bytes32)",
  ],
  audit: [
    "function entryCount() view returns (uint256)",
    "function getEntries(uint256,uint256) view returns (tuple(uint64 timestamp,uint64 blockNumber,address actor,bytes32 action,bytes32 subject,bytes32 dataHash)[])",
    "function writersLocked() view returns (bool)",
  ],
};

const ACTIONS = {};
for (const a of [
  "IDENTITY_REGISTERED", "IDENTITY_UPDATED", "IDENTITY_REVOKED", "CONTROLLER_PROPOSED", "CONTROLLER_CHANGED",
  "GUARDIANS_SET", "RECOVERY_STARTED", "RECOVERY_APPROVED", "RECOVERY_CANCELLED", "RECOVERY_EXECUTED",
  "ROLE_GRANTED", "ROLE_REVOKED", "ROLE_CREATED", "ASSET_MINTED", "ASSET_TRANSFERRED", "ASSET_FROZEN",
  "ASSET_UNFROZEN", "ASSET_BURNED", "ASSET_REVOKED", "ASSET_REINSTATED", "ASSET_CLAIMED",
]) ACTIONS[ethers.id(a)] = a;

const ROLES = {};
for (const r of ["ADMIN", "MANAGER", "AUDITOR", "USER"]) ROLES[ethers.id("ROLE_" + r)] = r[0] + r.slice(1).toLowerCase();

const B = (s) => "\x1b[1m" + s + "\x1b[0m";
const DIM = (s) => "\x1b[2m" + s + "\x1b[0m";
const GREEN = (s) => "\x1b[32m" + s + "\x1b[0m";
const RED = (s) => "\x1b[31m" + s + "\x1b[0m";
const YELLOW = (s) => "\x1b[33m" + s + "\x1b[0m";

const provider = new ethers.JsonRpcProvider(RPC, cfg.chainId);
const did = new ethers.Contract(cfg.didRegistry, ABI.did, provider);
const roles = new ethers.Contract(cfg.roleManager, ABI.roles, provider);
const assets = new ethers.Contract(cfg.assetNFT, ABI.assets, provider);
const audit = new ethers.Contract(cfg.auditTrail, ABI.audit, provider);

/** Address -> readable name, preferring what the identity says about itself. */
async function directory() {
  const names = new Map();
  for (const a of cfg.accounts ?? []) names.set(a.address.toLowerCase(), a.name);
  const people = [];
  for (const hash of await did.allDids(0, 500)) {
    const id = await did.resolve(hash);
    const claimed = id.docURI.split("/").pop();
    const name = names.get(id.controller.toLowerCase()) ?? claimed;
    names.set(id.controller.toLowerCase(), name);
    people.push({ hash, name, controller: id.controller, revoked: id.revoked,
                  roles: [...(await roles.rolesOfDid(hash))].map((r) => ROLES[r] ?? r.slice(0, 10)) });
  }
  return { names, people };
}

async function header() {
  const head = await provider.getBlockNumber();
  console.log(B(`\n  TrustChain on ${cfg.network} (chain ${cfg.chainId})`));
  console.log(DIM(`  read from ${RPC} - no wallet, no key, no server of ours`));
  console.log(DIM(`  network is at block ${head.toLocaleString("en-US")}, platform deployed at ${cfg.deployedAtBlock.toLocaleString("en-US")}\n`));
  return head;
}

async function showIdentities(dir) {
  console.log(B("  IDENTITIES"));
  for (const p of dir.people) {
    const tag = p.revoked ? RED("revoked") : GREEN("active");
    console.log(
      `    ${p.name.padEnd(16)} ${DIM(p.controller)}  ${(p.roles.join(", ") || DIM("no role")).padEnd(20)} ${tag}`
    );
  }
  console.log();
}

async function showAssets(dir) {
  const total = Number(await assets.totalMinted());
  console.log(B(`  ASSETS  (${total} minted)`));
  for (let i = 1; i <= total; i++) {
    let a;
    try {
      a = await assets.assetOf(i);
    } catch {
      console.log(`    #${i} ${DIM("burned")}`);
      continue;
    }
    const holder = dir.people.find((p) => p.hash === a.currentDid);
    const issuer = dir.people.find((p) => p.hash === a.issuerDid);
    const flags = [a.soulbound && "soulbound", a.frozen && "frozen", a.revoked && RED("revoked")].filter(Boolean);
    console.log(
      `    #${i} ${a.category.padEnd(22)} ${DIM("hash " + a.assetHash.slice(0, 18) + "…")}` +
        `  issued by ${(issuer?.name ?? "?").padEnd(14)} held by ${(holder?.name ?? "?").padEnd(14)} ${flags.join(" ")}`
    );
  }
  console.log();
}

async function showAudit(limit = 12, dir) {
  const count = Number(await audit.entryCount());
  const from = Math.max(0, count - limit);
  const entries = await audit.getEntries(from, count - from);
  console.log(B(`  AUDIT TRAIL  (${count} entries, showing the last ${entries.length})`));
  console.log(DIM(`    writers permanently locked: ${await audit.writersLocked()} - the set of contracts allowed to append can never change\n`));
  entries.forEach((e, i) => {
    const who = dir.names.get(e.actor.toLowerCase()) ?? e.actor.slice(0, 10) + "…";
    const subject = dir.people.find((p) => p.hash === e.subject);
    console.log(
      `    ${String(from + i).padStart(4)}  ${(ACTIONS[e.action] ?? e.action.slice(0, 12)).padEnd(20)}` +
        ` by ${who.padEnd(16)} ${subject ? "on " + subject.name.padEnd(15) : "".padEnd(18)}` +
        ` ${DIM("block " + e.blockNumber + "  " + new Date(Number(e.timestamp) * 1000).toLocaleString("en-US"))}`
    );
  });
  console.log();
}

/**
 * The point of this section: block N carries the hash of block N-1. Print both and the
 * match is there to be read, not taken on trust.
 */
async function showBlocks(limit = 6) {
  const count = Number(await audit.entryCount());
  const entries = await audit.getEntries(0, count);
  const byBlock = new Map();
  for (const e of entries) {
    const n = Number(e.blockNumber);
    if (!byBlock.has(n)) byBlock.set(n, []);
    byBlock.get(n).push(ACTIONS[e.action] ?? "?");
  }
  const numbers = [...byBlock.keys()].sort((a, b) => b - a).slice(0, limit);

  console.log(B(`  THE CHAIN ITSELF  (the ${numbers.length} most recent blocks holding platform activity)\n`));
  for (let i = 0; i < numbers.length; i++) {
    const n = numbers[i];
    const b = await provider.getBlock(n);
    console.log(`    ${B("block " + n.toLocaleString("en-US"))}   ${DIM(new Date(b.timestamp * 1000).toLocaleString("en-US"))}`);
    console.log(`      this block   ${b.hash}`);
    console.log(`      block before ${DIM(b.parentHash)}`);
    console.log(`      contains     ${byBlock.get(n).join(", ")}`);
    const older = numbers[i + 1];
    if (older === undefined) continue;
    const gap = n - older - 1;
    if (gap === 0) {
      const prev = await provider.getBlock(older);
      const linked = prev.hash === b.parentHash;
      console.log(
        "      " +
          (linked
            ? GREEN("↑ the hash above is exactly the block hash below - the chain is intact here")
            : RED("↑ MISMATCH"))
      );
    } else {
      console.log(DIM(`      ↑ ${gap.toLocaleString("en-US")} blocks of other people's transactions in between`));
    }
    console.log();
  }
  console.log(DIM(`    Change one byte of an old block and its hash changes, so the block after it points\n    at something that no longer exists - and so does every block after that.\n`));
}

/** Hash a real file here, in this terminal, and ask the contract about it. */
async function verifyFile(tokenId, file) {
  const bytes = fs.readFileSync(file);
  const hash = ethers.keccak256(bytes);
  console.log(B("\n  VERIFY A FILE"));
  console.log(`    file    ${file}`);
  console.log(`    size    ${bytes.length} bytes`);
  console.log(`    keccak  ${hash}`);
  console.log(DIM(`    (computed here - the file itself is never sent anywhere)\n`));

  const [status, matches, issuerDid] = await assets.verify(tokenId, hash);
  const dir = await directory();
  const issuer = dir.people.find((p) => p.hash === issuerDid);

  if (Number(status) === 0) console.log(RED(`    asset #${tokenId} does not exist\n`));
  else if (!matches) console.log(RED(`    ALTERED - this file is not what was issued as #${tokenId}\n`));
  else if (Number(status) === 2) console.log(YELLOW(`    REVOKED - genuine, issued by ${issuer?.name}, since rescinded\n`));
  else console.log(GREEN(`    AUTHENTIC - issued by ${issuer?.name ?? issuerDid.slice(0, 10)}\n`));
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === "verify") {
    const [id, file] = rest;
    if (!id || !file) return console.error("usage: node scripts/chain.js verify <tokenId> <file>");
    return verifyFile(id, file);
  }

  await header();
  const dir = await directory();

  if (cmd === "audit") return showAudit(Number(rest[0]) || 12, dir);
  if (cmd === "blocks") return showBlocks(Number(rest[0]) || 6);

  await showIdentities(dir);
  await showAssets(dir);
  await showAudit(8, dir);
  await showBlocks(6);
}

main().catch((e) => {
  console.error("\n  " + RED("Could not read the chain:"), e.shortMessage ?? e.message, "\n");
  process.exitCode = 1;
});

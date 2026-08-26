/**
 * Populate a public deployment with a realistic scenario, paid for entirely by the
 * root admin.
 *
 *   npx hardhat run scripts/seed-public.js --network sepolia
 *
 * On a public chain you have exactly one funded account, so every other participant is
 * onboarded through the platform's own sponsored-registration path: a throwaway wallet
 * signs an EIP-712 consent message off-chain (free, no gas, no ETH), and the admin
 * submits it. That is the real feature doing real work - an organisation onboarding
 * staff who have no crypto and no intention of getting any.
 *
 * The participants' keys are printed at the end. They exist only to prove consent; the
 * admin drives every subsequent action through the custodial path, which is audited as
 * custodial. Keep them if you want those people to sign for themselves later.
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const ROLES = {
  MANAGER: ethers.id("ROLE_MANAGER"),
  AUDITOR: ethers.id("ROLE_AUDITOR"),
  USER: ethers.id("ROLE_USER"),
};

/**
 * SEED_SIZE=small trims the cast to what fits a nearly empty wallet. A judge cannot tell
 * four staff from two; they notice whether the platform looks alive.
 */
const SMALL = (process.env.SEED_SIZE || "full").toLowerCase() === "small";

const PEOPLE = [
  { name: "records-office", role: ROLES.MANAGER },
  { name: "compliance", role: ROLES.AUDITOR },
  { name: "r-kumar", role: ROLES.USER },
  { name: "s-nair", role: ROLES.USER },
].filter((p) => !SMALL || p.name === "records-office" || p.name === "r-kumar");

const ASSETS = [
  { to: "r-kumar", uri: "ipfs://asset/title-deed-4471", source: "title-deed-4471.pdf", category: "property-title", soulbound: false },
  { to: "r-kumar", uri: "ipfs://asset/clearance-l3", source: "clearance-L3-r-kumar", category: "security-clearance", soulbound: true },
  { to: "s-nair", uri: "ipfs://asset/vehicle-rc-8891", source: "rc-book-8891.pdf", category: "vehicle-registration", soulbound: false },
  { to: "s-nair", uri: "ipfs://asset/laptop-tag-2210", source: "asset-tag-2210", category: "hardware", soulbound: false },
].filter((a) => PEOPLE.some((p) => p.name === a.to));

const step = (m) => console.log("\n  " + m);
const ok = (m) => console.log("     " + m);

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployments/${network.name}.json - deploy first.`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));

  const [admin] = await ethers.getSigners();
  if (!admin) throw new Error("No account configured - set PRIVATE_KEY in .env");

  const didRegistry = await ethers.getContractAt("DIDRegistry", d.didRegistry, admin);
  const roleManager = await ethers.getContractAt("RoleManager", d.roleManager, admin);
  const assetNFT = await ethers.getContractAt("AssetNFT", d.assetNFT, admin);
  const auditTrail = await ethers.getContractAt("AuditTrail", d.auditTrail, admin);

  const local = Number((await ethers.provider.getNetwork()).chainId) === 31337;
  const settle = (tx) => tx.wait(1);
  const before = await ethers.provider.getBalance(admin.address);

  console.log(`Seeding ${network.name} as ${admin.address}${SMALL ? "  (small)" : ""}`);
  console.log(`Balance ${ethers.formatEther(before)} ETH`);

  // Averaged from real runs: about 160k gas per transaction across registration,
  // role grants, mints and the two state changes.
  const txCount = PEOPLE.length * 2 + ASSETS.length + (SMALL ? 1 : 2);
  const fee = await ethers.provider.getFeeData();
  const gasPrice = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  const estimate = gasPrice * 160000n * BigInt(txCount);
  console.log(`Plan     ${txCount} transactions, ~${ethers.formatEther(estimate)} ETH`);

  if (!local && before < estimate) {
    console.error(
      `\n  Not enough to finish. Stopping before anything is written, because a\n` +
        `  half-seeded public chain cannot be undone - people registered with no\n` +
        `  roles, assets never issued.\n\n` +
        `  Short by ${ethers.formatEther(estimate - before)} ETH.\n` +
        `  Either top up, or run with SEED_SIZE=small for a trimmed scenario.\n`
    );
    process.exitCode = 1;
    return;
  }

  const domain = {
    name: "TrustChainDIDRegistry",
    version: "1",
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    verifyingContract: d.didRegistry,
  };
  const types = {
    RegisterIdentity: [
      { name: "subject", type: "address" },
      { name: "docURI", type: "string" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  step("Onboarding people who hold no ETH (EIP-712 sponsored registration)");
  const wallets = {};
  for (const p of PEOPLE) {
    const w = ethers.Wallet.createRandom();
    wallets[p.name] = w;

    if (await didRegistry.isActive(w.address)) {
      ok(`${p.name} already registered`);
      continue;
    }

    const docURI = `ipfs://did-document/${p.name}`;
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    // The subject signs off-chain. No gas, no balance, no wallet funding required.
    const signature = await w.signTypedData(domain, types, {
      subject: w.address,
      docURI,
      nonce: await didRegistry.nonces(w.address),
      deadline,
    });

    await settle(await didRegistry.registerFor(w.address, docURI, deadline, signature));
    ok(`${p.name.padEnd(15)} ${w.address}  registered on their own signature`);
  }

  step("Assigning roles");
  for (const p of PEOPLE) {
    const didHash = await didRegistry.didOf(wallets[p.name].address);
    await settle(await roleManager.grantRole(didHash, p.role, 0));
    const label = (await roleManager.roleDef(p.role)).label;
    ok(`${p.name.padEnd(15)} ${label}`);
  }

  step("Issuing assets");
  const minted = {};
  for (const a of ASSETS) {
    const didHash = await didRegistry.didOf(wallets[a.to].address);
    await settle(
      await assetNFT.mintToDid(didHash, a.uri, ethers.id(a.source), a.category, a.soulbound)
    );
    const id = await assetNFT.totalMinted();
    minted[a.uri] = id;
    ok(`#${id} ${a.category.padEnd(20)} to ${a.to}${a.soulbound ? "  (soulbound)" : ""}`);
  }

  step("A state change or two, so the platform looks lived-in");
  if (SMALL) {
    await settle(await assetNFT.setFrozen(minted["ipfs://asset/title-deed-4471"], true));
    ok(`title deed frozen pending a dispute`);
  } else {
    const kumar = wallets["r-kumar"].address;
    const nair = wallets["s-nair"].address;
    await settle(await assetNFT.custodialTransfer(kumar, nair, minted["ipfs://asset/title-deed-4471"]));
    ok(`title deed moved from r-kumar to s-nair, logged as custodial`);

    await settle(await assetNFT.setFrozen(minted["ipfs://asset/vehicle-rc-8891"], true));
    ok(`vehicle registration frozen`);
  }

  step("Result");
  console.log(`     identities   ${await didRegistry.identityCount()}`);
  console.log(`     assets       ${await assetNFT.totalMinted()}`);
  console.log(`     audit trail  ${await auditTrail.entryCount()} entries`);
  const spent = before - (await ethers.provider.getBalance(admin.address));
  console.log(`     spent        ${ethers.formatEther(spent)} ETH`);

  // Label the participants so the console shows names instead of raw addresses.
  d.accounts = [
    { name: "admin", address: admin.address, role: "Admin" },
    ...PEOPLE.map((p) => ({
      name: p.name,
      address: wallets[p.name].address,
      role: p.role === ROLES.MANAGER ? "Manager" : p.role === ROLES.AUDITOR ? "Auditor" : "User",
    })),
  ];
  fs.writeFileSync(file, JSON.stringify(d, null, 2));
  console.log(`\n  Wrote participant labels into deployments/${network.name}.json`);
  console.log("  Re-run `npm run bundle` so the shared console shows their names.\n");

  console.log("  Participant keys (only needed if you want them to sign for themselves):");
  for (const p of PEOPLE) {
    console.log(`     ${p.name.padEnd(15)} ${wallets[p.name].privateKey}`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

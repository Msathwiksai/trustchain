const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Deployment order matters, because the contracts check each other:
 *
 *   AuditTrail        (no dependencies)
 *   DIDRegistry       needs AuditTrail, becomes a writer
 *   -> root admin registers its own DID (nothing can grant roles to a non-identity)
 *   RoleManager       needs DIDRegistry + AuditTrail, becomes a writer, then bootstrap()
 *   DIDRegistry.setRoleManager   closes the loop for delegated registration / revocation
 *   AssetNFT          needs all three, becomes a writer
 */
async function deployPlatform(deployer, opts = {}) {
  const {
    adminDocURI = "ipfs://did-document/root-admin",
    nftName = "TrustChain Asset",
    nftSymbol = "TCA",
    confirmations = 1,
    log = () => {},
  } = opts;

  const settle = (tx) => tx.wait(confirmations);

  const AuditTrail = await ethers.getContractFactory("AuditTrail", deployer);
  const auditTrail = await AuditTrail.deploy(deployer.address);
  await auditTrail.waitForDeployment();
  log(`AuditTrail    ${await auditTrail.getAddress()}`);

  const DIDRegistry = await ethers.getContractFactory("DIDRegistry", deployer);
  const didRegistry = await DIDRegistry.deploy(deployer.address, await auditTrail.getAddress());
  await didRegistry.waitForDeployment();
  await settle(await auditTrail.setWriter(await didRegistry.getAddress(), true));
  log(`DIDRegistry   ${await didRegistry.getAddress()}`);

  await settle(await didRegistry.connect(deployer).register(adminDocURI));

  const RoleManager = await ethers.getContractFactory("RoleManager", deployer);
  const roleManager = await RoleManager.deploy(
    await didRegistry.getAddress(),
    await auditTrail.getAddress(),
    deployer.address
  );
  await roleManager.waitForDeployment();
  await settle(await auditTrail.setWriter(await roleManager.getAddress(), true));
  await settle(await roleManager.connect(deployer).bootstrap());
  await settle(await didRegistry.setRoleManager(await roleManager.getAddress()));
  log(`RoleManager   ${await roleManager.getAddress()}`);

  const AssetNFT = await ethers.getContractFactory("AssetNFT", deployer);
  const assetNFT = await AssetNFT.deploy(
    nftName,
    nftSymbol,
    await didRegistry.getAddress(),
    await roleManager.getAddress(),
    await auditTrail.getAddress()
  );
  await assetNFT.waitForDeployment();
  await settle(await auditTrail.setWriter(await assetNFT.getAddress(), true));
  log(`AssetNFT      ${await assetNFT.getAddress()}`);

  // Wiring is complete, so freeze the writer set permanently. From here nobody - not even
  // the governor - can authorise anything else to append to the audit trail.
  await settle(await auditTrail.lockWriters());
  log(`writers locked - the audit trail can never accept a new writer`);

  return { auditTrail, didRegistry, roleManager, assetNFT };
}

const CHAINS = {
  11155111: { explorer: "https://sepolia.etherscan.io", publicRpc: "https://ethereum-sepolia-rpc.publicnode.com" },
  31337: { explorer: null, publicRpc: "http://127.0.0.1:8545" },
};

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    console.error("No account configured - set PRIVATE_KEY in .env (see .env.example).");
    process.exitCode = 1;
    return;
  }

  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const chain = CHAINS[chainId] ?? {};
  const startBlock = await ethers.provider.getBlockNumber();
  const balanceBefore = await ethers.provider.getBalance(deployer.address);

  console.log(`Deploying to ${network.name} (chain ${chainId}) as ${deployer.address}`);
  console.log(`Balance ${ethers.formatEther(balanceBefore)} ETH\n`);

  const platform = await deployPlatform(deployer, {
    // On a public chain, wait for a second confirmation before the next transaction so a
    // reorged deployment cannot leave the wiring half-applied.
    confirmations: chainId === 31337 ? 1 : 2,
    log: (m) => console.log("  " + m),
  });

  const addresses = {
    network: network.name,
    chainId,
    // The public endpoint, deliberately: this file is committed, and SEPOLIA_RPC_URL may
    // carry an API key.
    rpcUrl: chain.publicRpc ?? null,
    explorer: chain.explorer ?? null,
    deployedAtBlock: startBlock + 1,
    rootAdmin: deployer.address,
    auditTrail: await platform.auditTrail.getAddress(),
    didRegistry: await platform.didRegistry.getAddress(),
    roleManager: await platform.roleManager.getAddress(),
    assetNFT: await platform.assetNFT.getAddress(),
  };

  const out = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${network.name}.json`), JSON.stringify(addresses, null, 2));

  const spent = balanceBefore - (await ethers.provider.getBalance(deployer.address));
  console.log(`\nSpent ${ethers.formatEther(spent)} ETH`);
  console.log(`Wrote deployments/${network.name}.json`);

  if (chain.explorer) {
    console.log("\nOn the explorer:");
    for (const k of ["auditTrail", "didRegistry", "roleManager", "assetNFT"]) {
      console.log(`  ${k.padEnd(12)} ${chain.explorer}/address/${addresses[k]}`);
    }
    console.log(`\nPublish the source with:  npm run verify:${network.name}`);
  }
}

module.exports = { deployPlatform };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}

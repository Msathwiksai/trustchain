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
    log = () => {},
  } = opts;

  const AuditTrail = await ethers.getContractFactory("AuditTrail", deployer);
  const auditTrail = await AuditTrail.deploy(deployer.address);
  await auditTrail.waitForDeployment();
  log(`AuditTrail    ${await auditTrail.getAddress()}`);

  const DIDRegistry = await ethers.getContractFactory("DIDRegistry", deployer);
  const didRegistry = await DIDRegistry.deploy(deployer.address, await auditTrail.getAddress());
  await didRegistry.waitForDeployment();
  await (await auditTrail.setWriter(await didRegistry.getAddress(), true)).wait();
  log(`DIDRegistry   ${await didRegistry.getAddress()}`);

  await (await didRegistry.connect(deployer).register(adminDocURI)).wait();

  const RoleManager = await ethers.getContractFactory("RoleManager", deployer);
  const roleManager = await RoleManager.deploy(
    await didRegistry.getAddress(),
    await auditTrail.getAddress(),
    deployer.address
  );
  await roleManager.waitForDeployment();
  await (await auditTrail.setWriter(await roleManager.getAddress(), true)).wait();
  await (await roleManager.connect(deployer).bootstrap()).wait();
  await (await didRegistry.setRoleManager(await roleManager.getAddress())).wait();
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
  await (await auditTrail.setWriter(await assetNFT.getAddress(), true)).wait();
  log(`AssetNFT      ${await assetNFT.getAddress()}`);

  return { auditTrail, didRegistry, roleManager, assetNFT };
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying to ${network.name} as ${deployer.address}\n`);

  const platform = await deployPlatform(deployer, { log: (m) => console.log("  " + m) });

  const addresses = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    rootAdmin: deployer.address,
    auditTrail: await platform.auditTrail.getAddress(),
    didRegistry: await platform.didRegistry.getAddress(),
    roleManager: await platform.roleManager.getAddress(),
    assetNFT: await platform.assetNFT.getAddress(),
  };

  const out = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${network.name}.json`), JSON.stringify(addresses, null, 2));
  console.log(`\nWrote deployments/${network.name}.json`);
}

module.exports = { deployPlatform };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}

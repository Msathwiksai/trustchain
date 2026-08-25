/**
 * Deploy to a running local node and fill it with demo data for the web UI:
 *   npx hardhat node                       (terminal 1)
 *   npm run seed:local                     (terminal 2)
 *   npm run web                            (terminal 3)
 */
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { deployPlatform } = require("./deploy");

const ROLES = {
  MANAGER: ethers.id("ROLE_MANAGER"),
  AUDITOR: ethers.id("ROLE_AUDITOR"),
  USER: ethers.id("ROLE_USER"),
};

async function main() {
  const [admin, manager, auditor, alice, bob] = await ethers.getSigners();

  const p = await deployPlatform(admin, { log: (m) => console.log("  " + m) });
  const { didRegistry, roleManager, assetNFT } = p;

  const labels = [
    [manager, "manager", "Manager"],
    [auditor, "auditor", "Auditor"],
    [alice, "alice", "User"],
    [bob, "bob", "User"],
  ];
  for (const [signer, label] of labels) {
    await (await didRegistry.connect(signer).register(`ipfs://did-document/${label}`)).wait();
  }

  const did = (s) => didRegistry.didOf(s.address);
  await (await roleManager.connect(admin).grantRole(await did(manager), ROLES.MANAGER, 0)).wait();
  await (await roleManager.connect(admin).grantRole(await did(auditor), ROLES.AUDITOR, 0)).wait();
  await (await roleManager.connect(manager).grantRole(await did(alice), ROLES.USER, 0)).wait();
  await (await roleManager.connect(manager).grantRole(await did(bob), ROLES.USER, 0)).wait();

  const assets = [
    [alice, "ipfs://asset/deed-41", "title-deed-2026-0041.pdf", "property-title", false],
    [alice, "ipfs://asset/clearance-l3", "clearance-L3-alice", "security-clearance", true],
    [bob, "ipfs://asset/laptop-8891", "asset-tag-8891", "hardware", false],
  ];
  for (const [to, uri, source, category, soulbound] of assets) {
    await (
      await assetNFT.connect(manager).mintToDid(await did(to), uri, ethers.id(source), category, soulbound)
    ).wait();
  }

  const addresses = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    rootAdmin: admin.address,
    auditTrail: await p.auditTrail.getAddress(),
    didRegistry: await didRegistry.getAddress(),
    roleManager: await roleManager.getAddress(),
    assetNFT: await assetNFT.getAddress(),
    accounts: [
      { name: "admin", address: admin.address, role: "Admin" },
      { name: "manager", address: manager.address, role: "Manager" },
      { name: "auditor", address: auditor.address, role: "Auditor" },
      { name: "alice", address: alice.address, role: "User" },
      { name: "bob", address: bob.address, role: "User" },
    ],
  };

  const out = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${network.name}.json`), JSON.stringify(addresses, null, 2));

  console.log(`\n  5 identities, 4 role grants, 3 assets, ${await p.auditTrail.entryCount()} audit entries`);
  console.log(`  Wrote deployments/${network.name}.json`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

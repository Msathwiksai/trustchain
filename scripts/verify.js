/**
 * Publish the source of a deployment to the block explorer.
 *   npm run verify:sepolia          (needs ETHERSCAN_API_KEY in .env)
 */
const fs = require("fs");
const path = require("path");
const { run, network } = require("hardhat");

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) {
    console.error(`No deployments/${network.name}.json - deploy first.`);
    process.exitCode = 1;
    return;
  }
  const d = JSON.parse(fs.readFileSync(file, "utf8"));

  const targets = [
    { name: "AuditTrail", address: d.auditTrail, args: [d.rootAdmin] },
    { name: "DIDRegistry", address: d.didRegistry, args: [d.rootAdmin, d.auditTrail] },
    { name: "RoleManager", address: d.roleManager, args: [d.didRegistry, d.auditTrail, d.rootAdmin] },
    {
      name: "AssetNFT",
      address: d.assetNFT,
      args: ["TrustChain Asset", "TCA", d.didRegistry, d.roleManager, d.auditTrail],
    },
  ];

  for (const t of targets) {
    process.stdout.write(`  ${t.name.padEnd(12)} ${t.address}  `);
    try {
      await run("verify:verify", { address: t.address, constructorArguments: t.args });
      console.log("verified");
    } catch (e) {
      const msg = e.message ?? String(e);
      console.log(/already verified/i.test(msg) ? "already verified" : `failed - ${msg.split("\n")[0]}`);
    }
  }

  if (d.explorer) console.log(`\n${d.explorer}/address/${d.assetNFT}#code`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

/**
 * Bundle the web console into one self-contained HTML file.
 *   npm run bundle
 *
 * Everything the page needs is inlined - ethers, the stylesheet, the app, the ABIs and
 * the deployment addresses - so it runs from any static host with no build step and no
 * server of its own. Reads go to the network's public RPC endpoint; writes are signed by
 * the viewer's own MetaMask. Nothing secret is ever in this file: contract addresses and
 * ABIs are public the moment a contract is deployed.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const NAMES = ["AuditTrail", "DIDRegistry", "RoleManager", "AssetNFT"];
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

// Only the networks a stranger can actually reach - localhost is meaningless to them.
const PUBLIC_NETWORKS = ["sepolia"];

function main() {
  const deployments = [];
  for (const name of PUBLIC_NETWORKS) {
    const file = path.join(ROOT, "deployments", `${name}.json`);
    if (fs.existsSync(file)) deployments.push(JSON.parse(fs.readFileSync(file, "utf8")));
  }
  if (!deployments.length) {
    console.error("No public deployment found - run `npm run deploy:sepolia` first.");
    process.exitCode = 1;
    return;
  }

  const abis = {};
  for (const n of NAMES) {
    abis[n] = JSON.parse(read("artifacts", "contracts", `${n}.sol`, `${n}.json`)).abi;
  }

  const ethers = read("web", "vendor", "ethers.umd.min.js");
  const css = read("web", "styles.css");
  const app = read("web", "app.js");

  // Start from the real page so the bundle can never drift from the served version.
  let html = read("web", "index.html");
  html = html
    .replace('<link rel="stylesheet" href="./styles.css" />', `<style>\n${css}\n</style>`)
    .replace(
      '<script src="./vendor/ethers.umd.min.js"></script>',
      `<script>${ethers}</script>`
    )
    .replace(
      '<script src="./app.js"></script>',
      `<script>window.__TRUSTCHAIN__ = ${JSON.stringify({ deployments, abis })};</script>\n<script>\n${app}\n</script>`
    );

  const out = path.join(ROOT, "public");
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, "index.html");
  fs.writeFileSync(file, html);

  const kb = (fs.statSync(file).size / 1024).toFixed(0);
  console.log(`\n  public/index.html  ${kb} KB, self-contained`);
  for (const d of deployments) {
    console.log(`  ${d.network.padEnd(10)} chain ${d.chainId}  AssetNFT ${d.assetNFT}`);
  }
  console.log("\n  Upload that one file to any static host, or open it directly in a browser.\n");
}

main();

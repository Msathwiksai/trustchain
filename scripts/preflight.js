/**
 * Check everything a public deployment needs before spending gas.
 *   npm run preflight
 */
const { ethers, network, config } = require("hardhat");

const EXPLORERS = { 11155111: "https://sepolia.etherscan.io" };

// Measured on a local run of scripts/deploy.js: 4 deployments plus 6 wiring transactions.
const GAS_ESTIMATE = 7_200_000n;

async function main() {
  const cfg = config.networks[network.name];
  console.log("");
  console.log(`  network      ${network.name}`);
  console.log(`  rpc          ${redact(cfg.url ?? "in-process")}`);

  const shapeProblem = looksWrong(cfg.url);
  if (shapeProblem) return fail(shapeProblem);

  let chainId;
  try {
    chainId = Number((await ethers.provider.getNetwork()).chainId);
  } catch (e) {
    return fail(
      `cannot reach the RPC endpoint - ${e.shortMessage ?? e.message}\n` +
        "           an Alchemy endpoint looks like https://eth-sepolia.g.alchemy.com/v2/<key>\n" +
        "           leave SEPOLIA_RPC_URL blank to use the free public endpoint instead"
    );
  }
  console.log(`  chain id     ${chainId}`);
  if (cfg.chainId && chainId !== cfg.chainId) {
    return fail(`the endpoint reports chain ${chainId}, but the config expects ${cfg.chainId}`);
  }

  const signers = await ethers.getSigners();
  if (!signers.length) {
    return fail("no account configured - set PRIVATE_KEY in .env (see .env.example)");
  }

  const deployer = signers[0];
  const balance = await ethers.provider.getBalance(deployer.address);
  const fee = await ethers.provider.getFeeData();
  const gasPrice = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  const cost = gasPrice * GAS_ESTIMATE;

  console.log(`  deployer     ${deployer.address}`);
  console.log(`  balance      ${ethers.formatEther(balance)} ETH`);
  console.log(`  gas price    ${ethers.formatUnits(gasPrice, "gwei")} gwei`);
  console.log(`  deploy cost  ~${ethers.formatEther(cost)} ETH (${GAS_ESTIMATE} gas)`);
  if (EXPLORERS[chainId]) {
    console.log(`  explorer     ${EXPLORERS[chainId]}/address/${deployer.address}`);
  }

  if (balance === 0n) {
    return fail("the deployer has no funds - top it up from a Sepolia faucet");
  }
  if (balance < cost) {
    return fail(
      `balance is below the estimated cost - fund ${ethers.formatEther(cost - balance)} ETH more`
    );
  }

  console.log("");
  console.log(`  ready. deploy with:  npm run deploy:${network.name}`);
  console.log("");
}

/**
 * Catch the usual copy-paste mistakes before spending a network round trip on them:
 * a provider's marketing page, or a dashboard URL, pasted in place of the endpoint.
 */
function looksWrong(url) {
  if (!url) return null;
  let host;
  try {
    ({ host } = new URL(url));
  } catch {
    return `SEPOLIA_RPC_URL is not a URL: ${url}`;
  }
  const marketing = ["www.alchemy.com", "alchemy.com", "www.infura.io", "infura.io", "dashboard.alchemy.com"];
  if (marketing.includes(host)) {
    return (
      `${url} is a website, not an RPC endpoint.\n` +
      "           Alchemy: dashboard -> your app -> Ethereum Sepolia -> copy the HTTPS URL\n" +
      "                    it looks like https://eth-sepolia.g.alchemy.com/v2/<key>\n" +
      "           Or leave SEPOLIA_RPC_URL blank to use the free public endpoint."
    );
  }
  if (/alchemy\.com/.test(host) && !/\/v2\/.+/.test(url)) {
    return `${redact(url)} is missing the /v2/<key> path that Alchemy endpoints carry.`;
  }
  return null;
}

/** Never print an RPC URL with an embedded API key. */
function redact(url) {
  return String(url).replace(/\/(v2|v3)\/[\w-]+/, "/$1/***");
}

function fail(msg) {
  console.error("");
  console.error(`  blocked: ${msg}`);
  console.error("");
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

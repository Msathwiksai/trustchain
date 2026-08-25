/**
 * End-to-end walkthrough of the platform, printed as a narrative.
 *   npx hardhat run scripts/demo.js
 */
const { ethers } = require("hardhat");
const { deployPlatform } = require("./deploy");

const ROLES = {
  ADMIN: ethers.id("ROLE_ADMIN"),
  MANAGER: ethers.id("ROLE_MANAGER"),
  AUDITOR: ethers.id("ROLE_AUDITOR"),
  USER: ethers.id("ROLE_USER"),
};

const ACTION_NAMES = [
  "IDENTITY_REGISTERED",
  "IDENTITY_UPDATED",
  "IDENTITY_ROTATED",
  "IDENTITY_REVOKED",
  "ROLE_GRANTED",
  "ROLE_REVOKED",
  "ROLE_PERMS_UPDATED",
  "ASSET_MINTED",
  "ASSET_TRANSFERRED",
  "ASSET_FROZEN",
  "ASSET_UNFROZEN",
  "ASSET_BURNED",
].reduce((m, n) => ((m[ethers.id(n)] = n), m), {});

const step = (n, t) => console.log(`\n${"=".repeat(72)}\n${n}. ${t}\n${"=".repeat(72)}`);
const ok = (m) => console.log(`   [ok]      ${m}`);
const blocked = (m) => console.log(`   [blocked] ${m}`);

async function expectRevert(label, promise) {
  try {
    await promise;
    console.log(`   [BUG]     ${label} was expected to fail but succeeded`);
    process.exitCode = 1;
  } catch (e) {
    const msg = e.shortMessage ?? e.message ?? "";
    const name = msg.match(/reverted with custom error '(\w+)/)?.[1] ?? "reverted";
    blocked(`${label}  ->  ${name}`);
  }
}

async function main() {
  const [admin, manager, auditor, alice, bob, outsider] = await ethers.getSigners();

  step(1, "Deploy the platform");
  const { auditTrail, didRegistry, roleManager, assetNFT } = await deployPlatform(admin, {
    log: (m) => console.log("   " + m),
  });
  ok(`root admin identity: ${await didRegistry.didStringFor(admin.address)}`);

  step(2, "Onboard identities");
  await (await didRegistry.connect(manager).register("ipfs://did/manager")).wait();
  await (await didRegistry.connect(auditor).register("ipfs://did/auditor")).wait();
  await (await didRegistry.connect(bob).register("ipfs://did/bob")).wait();
  ok("manager, auditor and bob registered their own identities (self-sovereign)");

  // Alice never pays gas: she signs an EIP-712 authorisation, the manager submits it.
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const domain = {
    name: "TrustChainDIDRegistry",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await didRegistry.getAddress(),
  };
  const types = {
    RegisterIdentity: [
      { name: "subject", type: "address" },
      { name: "docURI", type: "string" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  const did = (s) => didRegistry.didOf(s.address);
  await (await roleManager.connect(admin).grantRole(await did(manager), ROLES.MANAGER, 0)).wait();
  await (await roleManager.connect(admin).grantRole(await did(auditor), ROLES.AUDITOR, 0)).wait();
  ok("admin granted MANAGER and AUDITOR");

  const sig = await alice.signTypedData(domain, types, {
    subject: alice.address,
    docURI: "ipfs://did/alice",
    nonce: await didRegistry.nonces(alice.address),
    deadline,
  });
  await (await didRegistry.connect(manager).registerFor(alice.address, "ipfs://did/alice", deadline, sig)).wait();
  ok("alice's identity registered by the manager, proved by alice's EIP-712 signature");

  await (await roleManager.connect(manager).grantRole(await did(alice), ROLES.USER, 0)).wait();
  await (await roleManager.connect(manager).grantRole(await did(bob), ROLES.USER, 0)).wait();
  ok("manager granted USER to alice and bob (a manager cannot create managers)");

  await expectRevert(
    "manager tries to promote alice to MANAGER",
    roleManager.connect(manager).grantRole(await did(alice), ROLES.MANAGER, 0)
  );

  step(3, "Issue assets as NFTs bound to identities");
  const deedHash = ethers.id("title-deed-2026-0041.pdf");
  await (
    await assetNFT
      .connect(manager)
      .mintToDid(await did(alice), "ipfs://asset/deed-41", deedHash, "property-title", false)
  ).wait();
  ok(`token #1 "property-title" allocated to ${await didRegistry.didStringFor(alice.address)}`);

  await (
    await assetNFT
      .connect(manager)
      .mintToDid(await did(alice), "ipfs://asset/clearance", ethers.id("clearance-L3"), "clearance", true)
  ).wait();
  ok('token #2 "clearance" minted soulbound - it can never leave alice\'s identity');

  await expectRevert(
    "alice (USER) tries to mint her own asset",
    assetNFT.connect(alice).mintToDid(await did(alice), "ipfs://forged", deedHash, "property-title", false)
  );
  await expectRevert(
    "manager tries to mint to a wallet with no identity",
    assetNFT.connect(manager).mintTo(outsider.address, "ipfs://x", deedHash, "doc", false)
  );

  step(4, "Ownership, authenticity and transfer rules");
  console.log(
    `   authenticity of token #1 against the original file: ${await assetNFT.verifyAuthenticity(1, deedHash)}`
  );
  console.log(
    `   authenticity of token #1 against a tampered file:    ${await assetNFT.verifyAuthenticity(
      1,
      ethers.id("title-deed-2026-0041-TAMPERED.pdf")
    )}`
  );

  await (await assetNFT.connect(alice).transferFrom(alice.address, bob.address, 1)).wait();
  ok("alice transferred token #1 to bob; the asset now points at bob's DID");

  await expectRevert(
    "bob tries to transfer token #1 to a wallet with no identity",
    assetNFT.connect(bob).transferFrom(bob.address, outsider.address, 1)
  );
  await expectRevert(
    "alice tries to transfer her soulbound clearance",
    assetNFT.connect(alice).transferFrom(alice.address, bob.address, 2)
  );

  await (await assetNFT.connect(manager).setFrozen(1, true)).wait();
  ok("manager froze token #1 pending a dispute");
  await expectRevert(
    "bob tries to move the frozen token",
    assetNFT.connect(bob).transferFrom(bob.address, alice.address, 1)
  );
  await (await assetNFT.connect(manager).setFrozen(1, false)).wait();
  ok("manager unfroze token #1");

  step(5, "Key rotation: the identity outlives the key");
  await (await didRegistry.connect(alice).rotateController(outsider.address)).wait();
  ok("alice rotated control of her DID to a fresh key");
  console.log(`   token #2 is still owned by DID:      ${await assetNFT.isOwnedByDid(2, await didRegistry.didOf(outsider.address))}`);
  await (await assetNFT.connect(outsider).claimByIdentity(2)).wait();
  ok("the new key claimed the soulbound clearance - same identity, new key");

  step(6, "Revoke an identity and watch the permissions die with it");
  await (await didRegistry.connect(admin).revoke(await did(manager))).wait();
  ok("admin revoked the manager's identity");
  console.log(`   manager permission mask is now: ${await roleManager.permissionsOf(manager.address)}`);
  await expectRevert(
    "the revoked manager tries to mint",
    assetNFT.connect(manager).mintToDid(await did(bob), "ipfs://x", deedHash, "doc", false)
  );

  step(7, "The audit trail");
  const entries = await auditTrail.getEntries(0, 200);
  const who = new Map(
    [
      [admin.address, "admin"],
      [manager.address, "manager"],
      [auditor.address, "auditor"],
      [alice.address, "alice"],
      [bob.address, "bob"],
      [outsider.address, "alice-newkey"],
    ].map(([a, n]) => [a.toLowerCase(), n])
  );
  console.log("   #   block  actor         action");
  console.log("   " + "-".repeat(60));
  entries.forEach((e, i) => {
    const actor = (who.get(e.actor.toLowerCase()) ?? e.actor.slice(0, 8)).padEnd(12);
    console.log(
      `   ${String(i).padStart(3)} ${String(e.blockNumber).padStart(6)}  ${actor}  ${ACTION_NAMES[e.action]}`
    );
  });
  console.log(`\n   ${entries.length} entries, append-only, none of them editable by anyone.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

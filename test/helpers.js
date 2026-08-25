const { ethers } = require("hardhat");
const { deployPlatform } = require("../scripts/deploy");

const ROLES = {
  ADMIN: ethers.id("ROLE_ADMIN"),
  MANAGER: ethers.id("ROLE_MANAGER"),
  AUDITOR: ethers.id("ROLE_AUDITOR"),
  USER: ethers.id("ROLE_USER"),
};

const PERM = {
  MANAGE_ROLES: 1n << 0n,
  REGISTER_IDENTITY: 1n << 1n,
  REVOKE_IDENTITY: 1n << 2n,
  MINT_ASSET: 1n << 3n,
  TRANSFER_ASSET: 1n << 4n,
  FREEZE_ASSET: 1n << 5n,
  BURN_ASSET: 1n << 6n,
  READ_AUDIT: 1n << 7n,
};

const ACTION = {
  IDENTITY_REGISTERED: ethers.id("IDENTITY_REGISTERED"),
  IDENTITY_UPDATED: ethers.id("IDENTITY_UPDATED"),
  IDENTITY_ROTATED: ethers.id("IDENTITY_ROTATED"),
  IDENTITY_REVOKED: ethers.id("IDENTITY_REVOKED"),
  ROLE_GRANTED: ethers.id("ROLE_GRANTED"),
  ROLE_REVOKED: ethers.id("ROLE_REVOKED"),
  ASSET_MINTED: ethers.id("ASSET_MINTED"),
  ASSET_TRANSFERRED: ethers.id("ASSET_TRANSFERRED"),
  ASSET_FROZEN: ethers.id("ASSET_FROZEN"),
  ASSET_BURNED: ethers.id("ASSET_BURNED"),
};

/** Deploy the platform and onboard admin / manager / auditor / alice / bob. */
async function platformFixture() {
  const [admin, manager, auditor, alice, bob, outsider] = await ethers.getSigners();
  const p = await deployPlatform(admin);

  for (const [signer, label] of [
    [manager, "manager"],
    [auditor, "auditor"],
    [alice, "alice"],
    [bob, "bob"],
  ]) {
    await p.didRegistry.connect(signer).register(`ipfs://did-document/${label}`);
  }

  const did = async (s) => p.didRegistry.didOf(s.address);

  await p.roleManager.connect(admin).grantRole(await did(manager), ROLES.MANAGER, 0);
  await p.roleManager.connect(admin).grantRole(await did(auditor), ROLES.AUDITOR, 0);
  await p.roleManager.connect(manager).grantRole(await did(alice), ROLES.USER, 0);
  await p.roleManager.connect(manager).grantRole(await did(bob), ROLES.USER, 0);

  return {
    ...p,
    signers: { admin, manager, auditor, alice, bob, outsider },
    admin,
    manager,
    auditor,
    alice,
    bob,
    outsider,
    did,
  };
}

/** EIP-712 signature authorising someone else to register your identity. */
async function signRegistration(didRegistry, subject, docURI, deadline) {
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
  const value = {
    subject: subject.address,
    docURI,
    nonce: await didRegistry.nonces(subject.address),
    deadline,
  };
  return subject.signTypedData(domain, types, value);
}

module.exports = { platformFixture, signRegistration, ROLES, PERM, ACTION };

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { platformFixture, ROLES } = require("./helpers");

/**
 * The governor is a second authority, set at deployment and invisible in the UI. Every
 * permission check in the platform routes through DIDRegistry.roleManager, so a governor
 * able to repoint that is a governor able to grant themselves everything.
 */
describe("The governor cannot own the platform", function () {
  it("the RoleManager pointer is frozen by deployment", async function () {
    const { didRegistry } = await loadFixture(platformFixture);
    expect(await didRegistry.roleManagerLocked()).to.equal(true);
  });

  it("a governor cannot swap in a RoleManager that approves everyone", async function () {
    const f = await loadFixture(platformFixture);
    const Evil = await ethers.getContractFactory("EvilRoleManager");
    const evil = await Evil.deploy();
    await evil.waitForDeployment();

    // The governor is the deployer, so this is the strongest attacker the design admits.
    expect(await f.didRegistry.governor()).to.equal(f.admin.address);
    await expect(
      f.didRegistry.connect(f.admin).setRoleManager(await evil.getAddress())
    ).to.be.revertedWithCustomError(f.didRegistry, "RoleManagerIsLocked");

    // and an ordinary user still cannot mint, which is what the swap would have bought
    await expect(
      f.assetNFT.connect(f.alice).mintToDid(await f.did(f.alice), "ipfs://x", ethers.id("x"), "doc", false)
    ).to.be.revertedWithCustomError(f.assetNFT, "NotAuthorized");
  });

  it("stays frozen even after the governor is handed to somebody else", async function () {
    const f = await loadFixture(platformFixture);
    const Evil = await ethers.getContractFactory("EvilRoleManager");
    const evil = await Evil.deploy();
    await evil.waitForDeployment();

    await f.didRegistry.connect(f.admin).transferGovernor(f.outsider.address);
    expect(await f.didRegistry.governor()).to.equal(f.outsider.address);

    await expect(
      f.didRegistry.connect(f.outsider).setRoleManager(await evil.getAddress())
    ).to.be.revertedWithCustomError(f.didRegistry, "RoleManagerIsLocked");
  });

  it("a non-governor could never repoint it in the first place", async function () {
    const f = await loadFixture(platformFixture);
    await expect(
      f.didRegistry.connect(f.manager).setRoleManager(f.manager.address)
    ).to.be.revertedWithCustomError(f.didRegistry, "NotGovernor");
  });

  it("with both locks in place the governor has no powers left at all", async function () {
    const f = await loadFixture(platformFixture);

    // the two things a governor could ever do, both now refused
    await expect(
      f.didRegistry.connect(f.admin).setRoleManager(f.admin.address)
    ).to.be.revertedWithCustomError(f.didRegistry, "RoleManagerIsLocked");
    await expect(
      f.auditTrail.connect(f.admin).setWriter(f.admin.address, true)
    ).to.be.revertedWithCustomError(f.auditTrail, "WritersAreLocked");

    // authority now lives entirely in roles, which are on-chain and visible
    expect(await f.roleManager.hasRole(f.admin.address, ROLES.ADMIN)).to.equal(true);
  });
});

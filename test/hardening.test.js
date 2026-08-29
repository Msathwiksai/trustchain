const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { platformFixture, ROLES, PERM } = require("./helpers");

/**
 * Each test here pins a finding from the security review, so a future change that
 * reintroduces one fails loudly rather than quietly.
 */
describe("Hardening", function () {
  describe("the audit trail's writer set can be frozen forever", function () {
    it("a governor can authorise an arbitrary writer until the set is locked", async function () {
      const { auditTrail, admin, outsider } = await loadFixture(platformFixture);

      // The deployment locks it, so even the governor is refused.
      expect(await auditTrail.writersLocked()).to.equal(true);
      await expect(
        auditTrail.connect(admin).setWriter(outsider.address, true)
      ).to.be.revertedWithCustomError(auditTrail, "WritersAreLocked");
    });

    it("stays locked for a new governor too", async function () {
      const { auditTrail, admin, outsider } = await loadFixture(platformFixture);
      await auditTrail.connect(admin).transferGovernor(outsider.address);

      await expect(
        auditTrail.connect(outsider).setWriter(outsider.address, true)
      ).to.be.revertedWithCustomError(auditTrail, "WritersAreLocked");
      await expect(
        auditTrail.connect(outsider).record(outsider.address, ethers.id("FAKE"), ethers.ZeroHash, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(auditTrail, "NotWriter");
    });
  });

  describe("key rotation needs the new key to accept", function () {
    it("proposing alone changes nothing", async function () {
      const { didRegistry, alice, outsider } = await loadFixture(platformFixture);
      const did = await didRegistry.didOf(alice.address);

      await didRegistry.connect(alice).proposeController(outsider.address);

      expect(await didRegistry.controllerOf(did)).to.equal(alice.address);
      expect(await didRegistry.pendingController(did)).to.equal(outsider.address);
      expect(await didRegistry.isActive(alice.address)).to.equal(true);
    });

    it("only the proposed key can accept", async function () {
      const { didRegistry, alice, bob, outsider } = await loadFixture(platformFixture);
      const did = await didRegistry.didOf(alice.address);
      await didRegistry.connect(alice).proposeController(outsider.address);

      await expect(didRegistry.connect(bob).acceptController(did)).to.be.revertedWithCustomError(
        didRegistry,
        "NoProposal"
      );
    });

    it("an address nobody controls can never take the identity", async function () {
      const { didRegistry, alice } = await loadFixture(platformFixture);
      const did = await didRegistry.didOf(alice.address);
      const typo = "0x000000000000000000000000000000000000dEaD";

      await didRegistry.connect(alice).proposeController(typo);

      // Nothing moved, and alice keeps control - the old one-step rotation lost it here.
      expect(await didRegistry.controllerOf(did)).to.equal(alice.address);
      await didRegistry.connect(alice).cancelControllerProposal();
      expect(await didRegistry.pendingController(did)).to.equal(ethers.ZeroAddress);
    });

    it("a cancelled proposal cannot be accepted afterwards", async function () {
      const { didRegistry, alice, outsider } = await loadFixture(platformFixture);
      const did = await didRegistry.didOf(alice.address);

      await didRegistry.connect(alice).proposeController(outsider.address);
      await didRegistry.connect(alice).cancelControllerProposal();

      await expect(didRegistry.connect(outsider).acceptController(did)).to.be.revertedWithCustomError(
        didRegistry,
        "NoProposal"
      );
    });
  });

  describe("an expired role can simply be granted again", function () {
    it("does not require somebody to revoke the dead grant first", async function () {
      const { roleManager, admin, alice, did } = await loadFixture(platformFixture);
      const aliceDid = await did(alice);
      const expiry = (await time.latest()) + 100;

      await roleManager.connect(admin).grantRole(aliceDid, ROLES.AUDITOR, expiry);
      await time.increase(200);
      expect(await roleManager.hasPermission(alice.address, PERM.READ_AUDIT)).to.equal(false);

      // Previously this reverted with AlreadyGranted until someone revoked it.
      await roleManager.connect(admin).grantRole(aliceDid, ROLES.AUDITOR, 0);
      expect(await roleManager.hasPermission(alice.address, PERM.READ_AUDIT)).to.equal(true);
    });

    it("still refuses to duplicate a live grant", async function () {
      const { roleManager, admin, manager, did } = await loadFixture(platformFixture);
      await expect(
        roleManager.connect(admin).grantRole(await did(manager), ROLES.MANAGER, 0)
      ).to.be.revertedWithCustomError(roleManager, "AlreadyGranted");
    });
  });

  describe("a burned asset has no authenticity to verify", function () {
    it("reports the asset as gone rather than authentic", async function () {
      const f = await loadFixture(platformFixture);
      const hash = ethers.id("deed.pdf");
      await f.assetNFT.connect(f.manager).mintToDid(await f.did(f.alice), "ipfs://a", hash, "doc", false);

      expect(await f.assetNFT.verifyAuthenticity(1, hash)).to.equal(true);
      await f.assetNFT.connect(f.admin).burn(1);

      await expect(f.assetNFT.verifyAuthenticity(1, hash)).to.be.revertedWithCustomError(
        f.assetNFT,
        "UnknownAsset"
      );
    });
  });

  describe("reentrancy", function () {
    it("a recipient contract cannot re-enter while being handed an asset", async function () {
      const f = await loadFixture(platformFixture);
      const Attacker = await ethers.getContractFactory("ReentrantRecipient");
      const attacker = await Attacker.deploy(await f.assetNFT.getAddress());
      await attacker.waitForDeployment();

      // Give the attacking contract an identity so it is a legitimate recipient. It
      // validates its own signature (ERC-1271), so the sponsored path accepts it.
      const deadline = (await time.latest()) + 3600;
      await f.didRegistry
        .connect(f.admin)
        .registerFor(await attacker.getAddress(), "ipfs://did-document/attacker", deadline, "0x");
      const attackerDid = await f.didRegistry.didOf(await attacker.getAddress());

      // It already holds token 1 legitimately.
      await f.assetNFT.connect(f.manager).mintToDid(attackerDid, "ipfs://a", ethers.id("a"), "doc", false);
      expect(await f.assetNFT.ownerOf(1)).to.equal(await attacker.getAddress());

      // Minting token 2 hands it control via onERC721Received; it tries to move token 1
      // out in that window. The guard on transferFrom stops it, taking the mint with it.
      await attacker.arm(1, f.alice.address);
      await expect(
        f.assetNFT.connect(f.manager).mintToDid(attackerDid, "ipfs://b", ethers.id("b"), "doc", false)
      ).to.be.revertedWithCustomError(f.assetNFT, "ReentrancyGuardReentrantCall");

      // Nothing moved and nothing half-minted.
      expect(await f.assetNFT.ownerOf(1)).to.equal(await attacker.getAddress());
      expect(await f.assetNFT.totalMinted()).to.equal(1n);
    });

    it("custodial transfer hands control to nobody at all", async function () {
      const f = await loadFixture(platformFixture);
      const Attacker = await ethers.getContractFactory("ReentrantRecipient");
      const attacker = await Attacker.deploy(await f.assetNFT.getAddress());
      await attacker.waitForDeployment();

      const deadline = (await time.latest()) + 3600;
      await f.didRegistry
        .connect(f.admin)
        .registerFor(await attacker.getAddress(), "ipfs://did-document/attacker2", deadline, "0x");
      const attackerDid = await f.didRegistry.didOf(await attacker.getAddress());
      await f.assetNFT.connect(f.manager).mintToDid(attackerDid, "ipfs://a", ethers.id("a"), "doc", false);
      await f.assetNFT.connect(f.manager).mintToDid(attackerDid, "ipfs://b", ethers.id("b"), "doc", false);

      // custodialTransfer moves the token without an ERC-721 receiver callback, so the
      // recipient never executes and the custodial flag cannot be observed mid-flight.
      await attacker.arm(1, f.alice.address);
      await f.assetNFT
        .connect(f.manager)
        .custodialTransfer(await attacker.getAddress(), f.bob.address, 2);

      expect(await f.assetNFT.ownerOf(2)).to.equal(f.bob.address);
      expect(await f.assetNFT.ownerOf(1)).to.equal(await attacker.getAddress());
    });

    it("mints leave a finished asset for the receiver callback to inspect", async function () {
      const f = await loadFixture(platformFixture);
      const Observer = await ethers.getContractFactory("MintObserver");
      const observer = await Observer.deploy(await f.assetNFT.getAddress());
      await observer.waitForDeployment();

      const deadline = (await time.latest()) + 3600;
      await f.didRegistry.connect(f.admin).registerFor(
        await observer.getAddress(),
        "ipfs://did-document/observer",
        deadline,
        "0x"
      );
      const observerDid = await f.didRegistry.didOf(await observer.getAddress());

      await f.assetNFT
        .connect(f.manager)
        .mintToDid(observerDid, "ipfs://finished", ethers.id("src"), "doc", false);

      // What the callback saw, recorded at the moment control was handed over.
      expect(await observer.sawURI()).to.equal("ipfs://finished");
      expect(await observer.sawCategory()).to.equal("doc");
    });
  });
});

describe("one administrator cannot remove another", function () {
  /** Three administrators, exactly as "appoint more admins" would have it. */
  async function threeAdmins() {
    const f = await loadFixture(platformFixture);
    // bob already holds an identity from the fixture; the outsider does not.
    await f.didRegistry.connect(f.outsider).register("ipfs://did-document/peer");
    f.bobDid = await f.did(f.bob);
    f.outsiderDid = await f.did(f.outsider);
    await f.roleManager.connect(f.admin).grantRole(f.bobDid, ROLES.ADMIN, 0);
    await f.roleManager.connect(f.admin).grantRole(f.outsiderDid, ROLES.ADMIN, 0);
    expect(await f.roleManager.adminCount()).to.equal(3n);
    return f;
  }

  it("cannot strip a peer's Admin role", async function () {
    const f = await threeAdmins();
    await expect(
      f.roleManager.connect(f.bob).revokeRole(await f.did(f.admin), ROLES.ADMIN)
    ).to.be.revertedWithCustomError(f.roleManager, "AdminCannotRemoveAdmin");
    expect(await f.roleManager.hasRole(f.admin.address, ROLES.ADMIN)).to.equal(true);
  });

  it("cannot reach the same end by revoking a peer's identity", async function () {
    const f = await threeAdmins();
    await expect(
      f.didRegistry.connect(f.bob).revoke(f.outsiderDid)
    ).to.be.revertedWithCustomError(f.didRegistry, "AdminCannotRemoveAdmin");
    expect(await f.roleManager.hasPermission(f.outsider.address, PERM.MINT_ASSET)).to.equal(true);
  });

  it("so appointing more administrators is now worth something", async function () {
    const f = await threeAdmins();
    // Whatever the rogue tries, the other two keep every permission they had.
    await expect(f.roleManager.connect(f.bob).revokeRole(await f.did(f.admin), ROLES.ADMIN)).to.be.reverted;
    await expect(f.didRegistry.connect(f.bob).revoke(await f.did(f.admin))).to.be.reverted;
    expect(await f.roleManager.adminCount()).to.equal(3n);
  });

  it("an administrator may still stand down of their own accord", async function () {
    const f = await threeAdmins();
    await f.roleManager.connect(f.bob).renounceRole(ROLES.ADMIN);
    expect(await f.roleManager.hasRole(f.bob.address, ROLES.ADMIN)).to.equal(false);
    expect(await f.roleManager.adminCount()).to.equal(2n);
  });

  it("and can still revoke their own identity", async function () {
    const f = await threeAdmins();
    await expect(f.didRegistry.connect(f.bob).revoke(f.bobDid)).to.not.be.reverted;
  });

  it("non-admin roles are still removable by an administrator", async function () {
    const f = await threeAdmins();
    await f.roleManager.connect(f.admin).revokeRole(await f.did(f.manager), ROLES.MANAGER);
    expect(await f.roleManager.hasRole(f.manager.address, ROLES.MANAGER)).to.equal(false);
  });
});

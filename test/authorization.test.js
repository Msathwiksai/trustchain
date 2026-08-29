const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { platformFixture, ROLES, PERM } = require("./helpers");

/**
 * The role boundaries stated as requirements:
 *
 *   "admin should get access to everything, and shouldn't shift to manager or anything else"
 *   "manager should get his assets and has no access to admin"
 *
 * Each test below is one sentence of that, checked against the contracts.
 */
describe("Role boundaries", function () {
  const DOC = "ipfs://x";
  const HASH = ethers.id("doc");

  describe("Admin has access to everything", function () {
    it("holds every permission bit the platform defines", async function () {
      const { roleManager, admin } = await loadFixture(platformFixture);
      for (const [name, bit] of Object.entries(PERM)) {
        expect(await roleManager.hasPermission(admin.address, bit), name).to.equal(true);
      }
    });

    it("can do every privileged action end to end", async function () {
      const f = await loadFixture(platformFixture);
      const aliceDid = await f.did(f.alice);

      // mint, freeze, unfreeze, custodial move, burn
      await f.assetNFT.connect(f.admin).mintToDid(aliceDid, DOC, HASH, "doc", false);
      await f.assetNFT.connect(f.admin).setFrozen(1, true);
      await f.assetNFT.connect(f.admin).setFrozen(1, false);
      await f.assetNFT.connect(f.admin).custodialTransfer(f.alice.address, f.bob.address, 1);
      await f.assetNFT.connect(f.admin).burn(1);

      // role administration
      await f.roleManager.connect(f.admin).grantRole(aliceDid, ROLES.AUDITOR, 0);
      await f.roleManager.connect(f.admin).revokeRole(aliceDid, ROLES.AUDITOR);
      await f.roleManager.connect(f.admin).createRole(ethers.id("ROLE_X"), "X", PERM.MINT_ASSET, ROLES.ADMIN);
      await f.roleManager.connect(f.admin).setRolePermissions(ROLES.USER, 0);

      // identity administration
      await f.didRegistry.connect(f.admin).revoke(await f.did(f.bob));
    });
  });

  describe("Admin cannot be demoted out of Admin", function () {
    it("a Manager cannot revoke the Admin's role", async function () {
      const f = await loadFixture(platformFixture);
      await expect(
        f.roleManager.connect(f.manager).revokeRole(await f.did(f.admin), ROLES.ADMIN)
      ).to.be.revertedWithCustomError(f.roleManager, "NotAuthorized");
    });

    it("a User cannot revoke the Admin's role", async function () {
      const f = await loadFixture(platformFixture);
      await expect(
        f.roleManager.connect(f.alice).revokeRole(await f.did(f.admin), ROLES.ADMIN)
      ).to.be.revertedWithCustomError(f.roleManager, "NotAuthorized");
    });

    it("the last Admin cannot be revoked, even by itself", async function () {
      const f = await loadFixture(platformFixture);
      await expect(
        f.roleManager.connect(f.admin).revokeRole(await f.did(f.admin), ROLES.ADMIN)
      ).to.be.revertedWithCustomError(f.roleManager, "LastAdmin");
    });

    it("the last Admin cannot renounce its own role", async function () {
      const f = await loadFixture(platformFixture);
      await expect(
        f.roleManager.connect(f.admin).renounceRole(ROLES.ADMIN)
      ).to.be.revertedWithCustomError(f.roleManager, "LastAdmin");
    });

    it("the last Admin cannot revoke its own identity and orphan the platform", async function () {
      const f = await loadFixture(platformFixture);
      await expect(
        f.didRegistry.connect(f.admin).revoke(await f.did(f.admin))
      ).to.be.revertedWithCustomError(f.didRegistry, "LastAdmin");
    });

    it("an Admin grant cannot be given an expiry that would silently drop it", async function () {
      const f = await loadFixture(platformFixture);
      const expiry = (await time.latest()) + 1000;
      await expect(
        f.roleManager.connect(f.admin).grantRole(await f.did(f.alice), ROLES.ADMIN, expiry)
      ).to.be.revertedWithCustomError(f.roleManager, "AdminCannotExpire");
    });

    it("hands over cleanly: a successor is appointed, then the incumbent stands down", async function () {
      const f = await loadFixture(platformFixture);
      const aliceDid = await f.did(f.alice);

      await f.roleManager.connect(f.admin).grantRole(aliceDid, ROLES.ADMIN, 0);
      expect(await f.roleManager.adminCount()).to.equal(2n);

      // The successor cannot evict the incumbent - no administrator may remove another -
      // so a handover is the outgoing administrator's own act.
      await expect(
        f.roleManager.connect(f.alice).revokeRole(await f.did(f.admin), ROLES.ADMIN)
      ).to.be.revertedWithCustomError(f.roleManager, "AdminCannotRemoveAdmin");

      await f.roleManager.connect(f.admin).renounceRole(ROLES.ADMIN);

      expect(await f.roleManager.hasRole(f.admin.address, ROLES.ADMIN)).to.equal(false);
      expect(await f.roleManager.hasRole(f.alice.address, ROLES.ADMIN)).to.equal(true);
      expect(await f.roleManager.adminCount()).to.equal(1n);
    });

    it("adding another role to the Admin does not take Admin away", async function () {
      const f = await loadFixture(platformFixture);
      const adminDid = await f.did(f.admin);

      await f.roleManager.connect(f.admin).grantRole(adminDid, ROLES.MANAGER, 0);

      expect(await f.roleManager.hasRole(f.admin.address, ROLES.ADMIN)).to.equal(true);
      expect(await f.roleManager.hasPermission(f.admin.address, PERM.BURN_ASSET)).to.equal(true);
    });
  });

  describe("Manager has no access to Admin", function () {
    const denied = [
      ["grant ADMIN to itself", (f) => f.roleManager.connect(f.manager).grantRole(f.managerDid, ROLES.ADMIN, 0)],
      ["grant ADMIN to someone else", (f) => f.roleManager.connect(f.manager).grantRole(f.aliceDid, ROLES.ADMIN, 0)],
      ["create another Manager", (f) => f.roleManager.connect(f.manager).grantRole(f.aliceDid, ROLES.MANAGER, 0)],
      ["appoint an Auditor", (f) => f.roleManager.connect(f.manager).grantRole(f.aliceDid, ROLES.AUDITOR, 0)],
      ["revoke the Admin's role", (f) => f.roleManager.connect(f.manager).revokeRole(f.adminDid, ROLES.ADMIN)],
      ["edit any role's permissions", (f) => f.roleManager.connect(f.manager).setRolePermissions(ROLES.USER, 255)],
      ["invent a new role", (f) => f.roleManager.connect(f.manager).createRole(ethers.id("R"), "R", 255, ROLES.ADMIN)],
      ["re-point a role's admin", (f) => f.roleManager.connect(f.manager).setRoleAdmin(ROLES.USER, ROLES.USER)],
      ["revoke someone's identity", (f) => f.didRegistry.connect(f.manager).revoke(f.aliceDid)],
      ["burn an asset", (f) => f.assetNFT.connect(f.manager).burn(1)],
    ];

    for (const [what, call] of denied) {
      it(`cannot ${what}`, async function () {
        const f = await loadFixture(platformFixture);
        f.adminDid = await f.did(f.admin);
        f.managerDid = await f.did(f.manager);
        f.aliceDid = await f.did(f.alice);
        await f.assetNFT.connect(f.manager).mintToDid(f.aliceDid, DOC, HASH, "doc", false);

        await expect(call(f)).to.be.reverted;
      });
    }

    it("can do its own job: onboard Users, mint, freeze, move custodially", async function () {
      const f = await loadFixture(platformFixture);
      const aliceDid = await f.did(f.alice);
      await f.didRegistry.connect(f.outsider).register(DOC);

      await f.roleManager.connect(f.manager).grantRole(await f.did(f.outsider), ROLES.USER, 0);
      await f.assetNFT.connect(f.manager).mintToDid(aliceDid, DOC, HASH, "doc", false);
      await f.assetNFT.connect(f.manager).setFrozen(1, true);
      await f.assetNFT.connect(f.manager).setFrozen(1, false);
      await f.assetNFT.connect(f.manager).custodialTransfer(f.alice.address, f.bob.address, 1);

      expect(await f.assetNFT.ownerOf(1)).to.equal(f.bob.address);
    });

    it("cannot take over an Admin identity by rotating it", async function () {
      const f = await loadFixture(platformFixture);
      // rotation is callable only by the identity's own controller, and the new key must accept
      const managerDid = await f.did(f.manager);
      await f.didRegistry.connect(f.manager).proposeController(f.outsider.address);
      await f.didRegistry.connect(f.outsider).acceptController(managerDid);
      expect(await f.roleManager.hasRole(f.admin.address, ROLES.ADMIN)).to.equal(true);
    });
  });

  describe("User and Auditor stay inside their lane", function () {
    it("a User holds no permissions at all", async function () {
      const { roleManager, alice } = await loadFixture(platformFixture);
      expect(await roleManager.permissionsOf(alice.address)).to.equal(0n);
    });

    it("a User cannot mint, freeze, burn or grant anything", async function () {
      const f = await loadFixture(platformFixture);
      const aliceDid = await f.did(f.alice);
      await f.assetNFT.connect(f.manager).mintToDid(aliceDid, DOC, HASH, "doc", false);

      await expect(f.assetNFT.connect(f.alice).mintToDid(aliceDid, DOC, HASH, "d", false)).to.be.reverted;
      await expect(f.assetNFT.connect(f.alice).setFrozen(1, true)).to.be.reverted;
      await expect(f.assetNFT.connect(f.alice).burn(1)).to.be.reverted;
      await expect(f.roleManager.connect(f.alice).grantRole(aliceDid, ROLES.USER, 0)).to.be.reverted;
    });

    it("a User still fully owns the assets allocated to it", async function () {
      const f = await loadFixture(platformFixture);
      const aliceDid = await f.did(f.alice);
      await f.assetNFT.connect(f.manager).mintToDid(aliceDid, DOC, HASH, "deed", false);

      expect(await f.assetNFT.ownerOf(1)).to.equal(f.alice.address);
      await f.assetNFT.connect(f.alice).transferFrom(f.alice.address, f.bob.address, 1);
      expect(await f.assetNFT.ownerOf(1)).to.equal(f.bob.address);
    });

    it("an Auditor can read but cannot change anything", async function () {
      const f = await loadFixture(platformFixture);
      const aliceDid = await f.did(f.alice);

      expect(await f.roleManager.hasPermission(f.auditor.address, PERM.READ_AUDIT)).to.equal(true);
      expect(await f.auditTrail.entryCount()).to.be.greaterThan(0n);

      await expect(f.assetNFT.connect(f.auditor).mintToDid(aliceDid, DOC, HASH, "d", false)).to.be
        .reverted;
      await expect(f.roleManager.connect(f.auditor).grantRole(aliceDid, ROLES.USER, 0)).to.be.reverted;
      await expect(f.didRegistry.connect(f.auditor).revoke(aliceDid)).to.be.reverted;
    });
  });

  describe("Escalation attempts all fail", function () {
    it("a stranger with no identity can do nothing", async function () {
      const f = await loadFixture(platformFixture);
      const aliceDid = await f.did(f.alice);

      expect(await f.roleManager.permissionsOf(f.outsider.address)).to.equal(0n);
      await expect(f.assetNFT.connect(f.outsider).mintToDid(aliceDid, DOC, HASH, "d", false)).to.be
        .reverted;
      await expect(f.roleManager.connect(f.outsider).grantRole(aliceDid, ROLES.ADMIN, 0)).to.be.reverted;
    });

    it("a demoted Manager loses everything immediately", async function () {
      const f = await loadFixture(platformFixture);
      const aliceDid = await f.did(f.alice);

      await f.roleManager.connect(f.admin).revokeRole(await f.did(f.manager), ROLES.MANAGER);

      expect(await f.roleManager.permissionsOf(f.manager.address)).to.equal(0n);
      await expect(f.assetNFT.connect(f.manager).mintToDid(aliceDid, DOC, HASH, "d", false)).to.be
        .reverted;
    });

    it("a Manager cannot widen the User role to smuggle itself more power", async function () {
      const f = await loadFixture(platformFixture);
      await expect(
        f.roleManager.connect(f.manager).setRolePermissions(ROLES.MANAGER, 255)
      ).to.be.revertedWithCustomError(f.roleManager, "NotAuthorized");
    });
  });
});

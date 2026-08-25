const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { platformFixture, ROLES, PERM } = require("./helpers");

describe("RoleManager", function () {
  describe("default roles", function () {
    it("gives Admin every permission and User none", async function () {
      const { roleManager, admin, alice } = await loadFixture(platformFixture);

      expect(await roleManager.hasRole(admin.address, ROLES.ADMIN)).to.equal(true);
      expect(await roleManager.hasPermission(admin.address, PERM.MINT_ASSET | PERM.BURN_ASSET)).to.equal(
        true
      );
      expect(await roleManager.permissionsOf(alice.address)).to.equal(0n);
    });

    it("gives Manager operational permissions but not BURN or MANAGE of senior roles", async function () {
      const { roleManager, manager } = await loadFixture(platformFixture);

      expect(await roleManager.hasPermission(manager.address, PERM.MINT_ASSET)).to.equal(true);
      expect(await roleManager.hasPermission(manager.address, PERM.FREEZE_ASSET)).to.equal(true);
      expect(await roleManager.hasPermission(manager.address, PERM.BURN_ASSET)).to.equal(false);
    });

    it("gives Auditor read access only", async function () {
      const { roleManager, auditor } = await loadFixture(platformFixture);
      expect(await roleManager.hasPermission(auditor.address, PERM.READ_AUDIT)).to.equal(true);
      expect(await roleManager.hasPermission(auditor.address, PERM.MINT_ASSET)).to.equal(false);
    });
  });

  describe("granting", function () {
    it("lets a Manager onboard Users but not create more Managers", async function () {
      const { roleManager, manager, outsider, didRegistry, did } = await loadFixture(platformFixture);
      await didRegistry.connect(outsider).register("ipfs://doc");
      const outsiderDid = await did(outsider);

      await roleManager.connect(manager).grantRole(outsiderDid, ROLES.USER, 0);
      expect(await roleManager.hasRoleDid(outsiderDid, ROLES.USER)).to.equal(true);

      await expect(
        roleManager.connect(manager).grantRole(outsiderDid, ROLES.MANAGER, 0)
      ).to.be.revertedWithCustomError(roleManager, "NotAuthorized");
    });

    it("refuses to grant a role to an unregistered identity", async function () {
      const { roleManager, admin } = await loadFixture(platformFixture);
      await expect(
        roleManager.connect(admin).grantRole(ethers.id("did:tcid:31337:0xnope"), ROLES.USER, 0)
      ).to.be.revertedWithCustomError(roleManager, "InactiveIdentity");
    });

    it("refuses a caller with no MANAGE_ROLES permission", async function () {
      const { roleManager, alice, bob, did } = await loadFixture(platformFixture);
      await expect(
        roleManager.connect(alice).grantRole(await did(bob), ROLES.USER, 0)
      ).to.be.revertedWithCustomError(roleManager, "NotAuthorized");
    });

    it("rejects a duplicate grant", async function () {
      const { roleManager, admin, manager, did } = await loadFixture(platformFixture);
      await expect(
        roleManager.connect(admin).grantRole(await did(manager), ROLES.MANAGER, 0)
      ).to.be.revertedWithCustomError(roleManager, "AlreadyGranted");
    });
  });

  describe("expiry", function () {
    it("stops honouring a time-boxed role once it lapses", async function () {
      const { roleManager, admin, alice, did } = await loadFixture(platformFixture);
      const expiresAt = (await time.latest()) + 1000;

      await roleManager.connect(admin).grantRole(await did(alice), ROLES.AUDITOR, expiresAt);
      expect(await roleManager.hasPermission(alice.address, PERM.READ_AUDIT)).to.equal(true);

      await time.increase(1001);
      expect(await roleManager.hasPermission(alice.address, PERM.READ_AUDIT)).to.equal(false);
      expect(await roleManager.hasRole(alice.address, ROLES.AUDITOR)).to.equal(false);
    });

    it("rejects an expiry in the past", async function () {
      const { roleManager, admin, alice, did } = await loadFixture(platformFixture);
      await expect(
        roleManager.connect(admin).grantRole(await did(alice), ROLES.AUDITOR, (await time.latest()) - 1)
      ).to.be.revertedWithCustomError(roleManager, "ExpiryInPast");
    });
  });

  describe("revocation and renouncing", function () {
    it("revokes a role", async function () {
      const { roleManager, admin, manager, did } = await loadFixture(platformFixture);
      await roleManager.connect(admin).revokeRole(await did(manager), ROLES.MANAGER);
      expect(await roleManager.hasPermission(manager.address, PERM.MINT_ASSET)).to.equal(false);
    });

    it("lets a holder renounce its own role without any permission", async function () {
      const { roleManager, auditor } = await loadFixture(platformFixture);
      await roleManager.connect(auditor).renounceRole(ROLES.AUDITOR);
      expect(await roleManager.hasRole(auditor.address, ROLES.AUDITOR)).to.equal(false);
    });

    it("drops every permission the moment the identity is revoked", async function () {
      const { roleManager, didRegistry, admin, manager, did } = await loadFixture(platformFixture);
      expect(await roleManager.hasPermission(manager.address, PERM.MINT_ASSET)).to.equal(true);

      await didRegistry.connect(admin).revoke(await did(manager));

      expect(await roleManager.permissionsOf(manager.address)).to.equal(0n);
      expect(await roleManager.hasRole(manager.address, ROLES.MANAGER)).to.equal(false);
    });
  });

  describe("role definitions", function () {
    it("lets an Admin create a custom role", async function () {
      const { roleManager, admin, alice, did } = await loadFixture(platformFixture);
      const CUSTODIAN = ethers.id("ROLE_CUSTODIAN");

      await roleManager
        .connect(admin)
        .createRole(CUSTODIAN, "Custodian", PERM.TRANSFER_ASSET | PERM.FREEZE_ASSET, ROLES.ADMIN);
      await roleManager.connect(admin).grantRole(await did(alice), CUSTODIAN, 0);

      expect(await roleManager.hasPermission(alice.address, PERM.TRANSFER_ASSET)).to.equal(true);
      expect((await roleManager.roleDef(CUSTODIAN)).label).to.equal("Custodian");
    });

    it("blocks a Manager from editing role permissions", async function () {
      const { roleManager, manager } = await loadFixture(platformFixture);
      await expect(
        roleManager.connect(manager).setRolePermissions(ROLES.USER, PERM.MINT_ASSET)
      ).to.be.revertedWithCustomError(roleManager, "NotAuthorized");
    });

    it("applies an Admin's permission change to every holder at once", async function () {
      const { roleManager, admin, alice } = await loadFixture(platformFixture);
      expect(await roleManager.hasPermission(alice.address, PERM.MINT_ASSET)).to.equal(false);

      await roleManager.connect(admin).setRolePermissions(ROLES.USER, PERM.MINT_ASSET);

      expect(await roleManager.hasPermission(alice.address, PERM.MINT_ASSET)).to.equal(true);
    });
  });

  describe("bootstrap", function () {
    it("cannot be replayed", async function () {
      const { roleManager, admin } = await loadFixture(platformFixture);
      await expect(roleManager.connect(admin).bootstrap()).to.be.revertedWithCustomError(
        roleManager,
        "NotAuthorized"
      );
    });
  });
});

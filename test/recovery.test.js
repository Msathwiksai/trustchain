const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { platformFixture, ROLES, PERM } = require("./helpers");

const DAY = 24 * 3600;

/** alice nominates manager, auditor and bob as guardians, 2 of 3, with a one-day veto window. */
async function withGuardians(delay = DAY) {
  const f = await loadFixture(platformFixture);
  f.aliceDid = await f.did(f.alice);
  f.guardians = [await f.did(f.manager), await f.did(f.auditor), await f.did(f.bob)];
  await f.didRegistry.connect(f.alice).setGuardians(f.guardians, 2, delay);
  return f;
}

describe("Social recovery", function () {
  describe("nominating guardians", function () {
    it("records the set, the threshold and the veto window", async function () {
      const f = await withGuardians();
      const [guardians, threshold, delay] = await f.didRegistry.guardiansOf(f.aliceDid);

      expect([...guardians]).to.deep.equal(f.guardians);
      expect(threshold).to.equal(2);
      expect(delay).to.equal(DAY);
      expect(await f.didRegistry.isGuardian(f.aliceDid, f.guardians[0])).to.equal(true);
    });

    it("refuses a threshold nobody could ever meet", async function () {
      const f = await loadFixture(platformFixture);
      await expect(
        f.didRegistry.connect(f.alice).setGuardians([await f.did(f.bob)], 2, DAY)
      ).to.be.revertedWithCustomError(f.didRegistry, "BadGuardianSet");
    });

    it("refuses a threshold of zero", async function () {
      const f = await loadFixture(platformFixture);
      await expect(
        f.didRegistry.connect(f.alice).setGuardians([await f.did(f.bob)], 0, DAY)
      ).to.be.revertedWithCustomError(f.didRegistry, "BadGuardianSet");
    });

    it("refuses the same guardian twice - one person must not meet a threshold of two", async function () {
      const f = await loadFixture(platformFixture);
      const bobDid = await f.did(f.bob);
      await expect(
        f.didRegistry.connect(f.alice).setGuardians([bobDid, bobDid], 2, DAY)
      ).to.be.revertedWithCustomError(f.didRegistry, "BadGuardianSet");
    });

    it("refuses to let an identity guard itself", async function () {
      const f = await loadFixture(platformFixture);
      const aliceDid = await f.did(f.alice);
      await expect(
        f.didRegistry.connect(f.alice).setGuardians([aliceDid], 1, DAY)
      ).to.be.revertedWithCustomError(f.didRegistry, "BadGuardianSet");
    });

    it("refuses a guardian that is not a live identity", async function () {
      const f = await loadFixture(platformFixture);
      await expect(
        f.didRegistry.connect(f.alice).setGuardians([ethers.id("nobody")], 1, DAY)
      ).to.be.revertedWithCustomError(f.didRegistry, "BadGuardianSet");
    });

    it("only the controller may nominate", async function () {
      const f = await loadFixture(platformFixture);
      await expect(
        f.didRegistry.connect(f.bob).setGuardians([await f.did(f.manager)], 1, DAY)
      ).to.not.be.reverted; // bob sets his own, not alice's

      const [, threshold] = await f.didRegistry.guardiansOf(await f.did(f.alice));
      expect(threshold).to.equal(0);
    });
  });

  describe("recovering a lost key", function () {
    it("moves the identity, its roles and its assets to the new key", async function () {
      const f = await withGuardians();
      // alice already holds USER from the fixture
      await f.assetNFT.connect(f.manager).mintToDid(f.aliceDid, "ipfs://a", ethers.id("a"), "doc", false);

      // alice's key is gone. Two guardians act.
      await f.didRegistry.connect(f.manager).initiateRecovery(f.aliceDid, f.outsider.address);
      await f.didRegistry.connect(f.auditor).approveRecovery(f.aliceDid);
      await time.increase(DAY + 1);
      await f.didRegistry.connect(f.bob).executeRecovery(f.aliceDid);

      expect(await f.didRegistry.controllerOf(f.aliceDid)).to.equal(f.outsider.address);
      expect(await f.didRegistry.didOf(f.alice.address)).to.equal(ethers.ZeroHash);
      // the role followed the identity, not the key
      expect(await f.roleManager.hasRole(f.outsider.address, ROLES.USER)).to.equal(true);
      // and the asset is still owned by the same DID
      expect(await f.assetNFT.isOwnedByDid(1, f.aliceDid)).to.equal(true);
      await f.assetNFT.connect(f.outsider).claimByIdentity(1);
      expect(await f.assetNFT.ownerOf(1)).to.equal(f.outsider.address);
    });

    it("recovers an Admin without ever dropping below one administrator", async function () {
      const f = await loadFixture(platformFixture);
      const adminDid = await f.did(f.admin);
      await f.didRegistry
        .connect(f.admin)
        .setGuardians([await f.did(f.manager), await f.did(f.auditor)], 2, 0);

      await f.didRegistry.connect(f.manager).initiateRecovery(adminDid, f.outsider.address);
      await f.didRegistry.connect(f.auditor).approveRecovery(adminDid);
      await f.didRegistry.connect(f.bob).executeRecovery(adminDid);

      expect(await f.roleManager.hasRole(f.outsider.address, ROLES.ADMIN)).to.equal(true);
      expect(await f.roleManager.adminCount()).to.equal(1n);
      expect(await f.roleManager.hasPermission(f.outsider.address, PERM.BURN_ASSET)).to.equal(true);
    });

    it("anyone may push the final button - the approvals are the authorisation", async function () {
      const f = await withGuardians(0);
      await f.didRegistry.connect(f.manager).initiateRecovery(f.aliceDid, f.outsider.address);
      await f.didRegistry.connect(f.auditor).approveRecovery(f.aliceDid);

      await f.didRegistry.connect(f.outsider).executeRecovery(f.aliceDid);
      expect(await f.didRegistry.controllerOf(f.aliceDid)).to.equal(f.outsider.address);
    });
  });

  describe("guardians cannot steal an identity", function () {
    it("one guardian below the threshold achieves nothing", async function () {
      const f = await withGuardians();
      await f.didRegistry.connect(f.manager).initiateRecovery(f.aliceDid, f.outsider.address);
      await time.increase(DAY + 1);

      await expect(
        f.didRegistry.connect(f.manager).executeRecovery(f.aliceDid)
      ).to.be.revertedWithCustomError(f.didRegistry, "ThresholdNotMet");
      expect(await f.didRegistry.controllerOf(f.aliceDid)).to.equal(f.alice.address);
    });

    it("the same guardian cannot approve twice to fake a quorum", async function () {
      const f = await withGuardians();
      await f.didRegistry.connect(f.manager).initiateRecovery(f.aliceDid, f.outsider.address);

      await expect(
        f.didRegistry.connect(f.manager).approveRecovery(f.aliceDid)
      ).to.be.revertedWithCustomError(f.didRegistry, "AlreadyApproved");
    });

    it("a non-guardian cannot start or approve one", async function () {
      const f = await withGuardians();
      await expect(
        f.didRegistry.connect(f.outsider).initiateRecovery(f.aliceDid, f.outsider.address)
      ).to.be.revertedWithCustomError(f.didRegistry, "NotGuardian");
    });

    it("the controller can veto during the window, and the quorum is discarded", async function () {
      const f = await withGuardians();
      await f.didRegistry.connect(f.manager).initiateRecovery(f.aliceDid, f.outsider.address);
      await f.didRegistry.connect(f.auditor).approveRecovery(f.aliceDid);

      // Threshold is met - but alice still holds her key and says no.
      await f.didRegistry.connect(f.alice).cancelRecovery();
      await time.increase(DAY + 1);

      await expect(
        f.didRegistry.connect(f.bob).executeRecovery(f.aliceDid)
      ).to.be.revertedWithCustomError(f.didRegistry, "NoRecovery");
      expect(await f.didRegistry.controllerOf(f.aliceDid)).to.equal(f.alice.address);
    });

    it("cannot execute before the veto window closes", async function () {
      const f = await withGuardians();
      await f.didRegistry.connect(f.manager).initiateRecovery(f.aliceDid, f.outsider.address);
      await f.didRegistry.connect(f.auditor).approveRecovery(f.aliceDid);

      await expect(
        f.didRegistry.connect(f.bob).executeRecovery(f.aliceDid)
      ).to.be.revertedWithCustomError(f.didRegistry, "DelayNotElapsed");
    });

    it("approvals from a cancelled attempt cannot be replayed into the next one", async function () {
      const f = await withGuardians(0);
      await f.didRegistry.connect(f.manager).initiateRecovery(f.aliceDid, f.outsider.address);
      await f.didRegistry.connect(f.auditor).approveRecovery(f.aliceDid);
      await f.didRegistry.connect(f.alice).cancelRecovery();

      // A fresh attempt starts from one approval, not from the two already banked.
      await f.didRegistry.connect(f.manager).initiateRecovery(f.aliceDid, f.outsider.address);
      const [, , approvals] = await f.didRegistry.recoveryOf(f.aliceDid);
      expect(approvals).to.equal(1);
      await expect(
        f.didRegistry.connect(f.bob).executeRecovery(f.aliceDid)
      ).to.be.revertedWithCustomError(f.didRegistry, "ThresholdNotMet");
    });

    it("re-nominating guardians cancels anything in flight", async function () {
      const f = await withGuardians(0);
      await f.didRegistry.connect(f.manager).initiateRecovery(f.aliceDid, f.outsider.address);
      await f.didRegistry.connect(f.auditor).approveRecovery(f.aliceDid);

      await f.didRegistry.connect(f.alice).setGuardians([await f.did(f.bob)], 1, 0);

      await expect(
        f.didRegistry.connect(f.bob).executeRecovery(f.aliceDid)
      ).to.be.revertedWithCustomError(f.didRegistry, "NoRecovery");
      expect(await f.didRegistry.isGuardian(f.aliceDid, await f.did(f.manager))).to.equal(false);
    });

    it("cannot recover onto a key that already has an identity", async function () {
      const f = await withGuardians(0);
      await expect(
        f.didRegistry.connect(f.manager).initiateRecovery(f.aliceDid, f.bob.address)
      ).to.be.revertedWithCustomError(f.didRegistry, "AlreadyRegistered");
    });

    it("cannot recover a revoked identity", async function () {
      const f = await withGuardians(0);
      await f.didRegistry.connect(f.admin).revoke(f.aliceDid);

      await expect(
        f.didRegistry.connect(f.manager).initiateRecovery(f.aliceDid, f.outsider.address)
      ).to.be.revertedWithCustomError(f.didRegistry, "IdentityIsRevoked");
    });

    it("a guardian whose own identity was revoked stops counting", async function () {
      const f = await withGuardians(0);
      await f.didRegistry.connect(f.admin).revoke(await f.did(f.manager));

      await expect(
        f.didRegistry.connect(f.manager).initiateRecovery(f.aliceDid, f.outsider.address)
      ).to.be.revertedWithCustomError(f.didRegistry, "NotGuardian");
    });
  });

  describe("the audit trail records the whole attempt", function () {
    it("logs nomination, start, approval and the rotation", async function () {
      const f = await withGuardians(0);
      const before = Number(await f.auditTrail.entryCount());

      await f.didRegistry.connect(f.manager).initiateRecovery(f.aliceDid, f.outsider.address);
      await f.didRegistry.connect(f.auditor).approveRecovery(f.aliceDid);
      await f.didRegistry.connect(f.bob).executeRecovery(f.aliceDid);

      const entries = await f.auditTrail.getEntries(before - 1, 10);
      expect(entries.map((e) => e.action)).to.deep.equal([
        ethers.id("GUARDIANS_SET"),
        ethers.id("RECOVERY_STARTED"),
        ethers.id("RECOVERY_APPROVED"),
        ethers.id("IDENTITY_ROTATED"),
      ]);
      expect(entries[1].actor).to.equal(f.manager.address);
      expect(entries[2].actor).to.equal(f.auditor.address);
    });
  });
});

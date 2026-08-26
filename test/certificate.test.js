const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { platformFixture, PERM } = require("./helpers");

const CERTIFICATE =
  "UNIVERSITY OF EXAMPLE\n\nThis certifies that SATHWIK KUMAR\nhas been awarded the degree of\n" +
  "Bachelor of Technology in Computer Science\nwith CGPA 8.7\non 12 June 2026\n";

const hashOf = (text) => ethers.keccak256(ethers.toUtf8Bytes(text));

const STATUS = { Unknown: 0n, Valid: 1n, Revoked: 2n };

/** The college (manager) issues a degree to the student (alice), soulbound. */
async function issued() {
  const f = await loadFixture(platformFixture);
  f.collegeDid = await f.did(f.manager);
  f.studentDid = await f.did(f.alice);
  await f.assetNFT
    .connect(f.manager)
    .mintToDid(f.studentDid, "ipfs://cert/btech-2026-0417", hashOf(CERTIFICATE), "degree-certificate", true);
  f.tokenId = 1;
  return f;
}

/**
 * The three things an interviewer must be able to check:
 *   1. the trusted college issued it
 *   2. this student owns it
 *   3. the file was not altered, and it was not revoked
 */
describe("Certificate verification", function () {
  describe("1. issued by the trusted organisation", function () {
    it("records the issuer, not just the recipient", async function () {
      const f = await issued();
      const asset = await f.assetNFT.assetOf(f.tokenId);

      expect(asset.issuerDid).to.equal(f.collegeDid);
      expect(asset.originDid).to.equal(f.studentDid);
      expect(await f.assetNFT.wasIssuedBy(f.tokenId, f.collegeDid)).to.equal(true);
    });

    it("a certificate from anyone else fails the issuer check", async function () {
      const f = await issued();
      // The admin can also mint - so an interviewer must check *which* identity issued it.
      await f.assetNFT
        .connect(f.admin)
        .mintToDid(f.studentDid, "ipfs://cert/fake", hashOf(CERTIFICATE), "degree-certificate", true);

      expect(await f.assetNFT.wasIssuedBy(2, f.collegeDid)).to.equal(false);
      expect(await f.assetNFT.wasIssuedBy(2, await f.did(f.admin))).to.equal(true);
    });
  });

  describe("2. owned by this student", function () {
    it("reports the holding identity", async function () {
      const f = await issued();
      const [, , , ownerDid] = await f.assetNFT.verify(f.tokenId, hashOf(CERTIFICATE));
      expect(ownerDid).to.equal(f.studentDid);
      expect(await f.assetNFT.isOwnedByDid(f.tokenId, f.studentDid)).to.equal(true);
    });

    it("a degree is soulbound - it cannot be sold or lent", async function () {
      const f = await issued();
      await expect(
        f.assetNFT.connect(f.alice).transferFrom(f.alice.address, f.bob.address, f.tokenId)
      ).to.be.revertedWithCustomError(f.assetNFT, "AssetIsSoulbound");
    });
  });

  describe("3. not altered", function () {
    const forgeries = [
      ["the marks changed", CERTIFICATE.replace("CGPA 8.7", "CGPA 9.7")],
      ["one letter of the name changed", CERTIFICATE.replace("SATHWIK", "SATHWIF")],
      ["the date changed", CERTIFICATE.replace("12 June 2026", "12 June 2025")],
      ["a single trailing space added", CERTIFICATE + " "],
      ["a line break removed", CERTIFICATE.replace("\n\n", "\n")],
    ];

    it("accepts the original", async function () {
      const f = await issued();
      expect(await f.assetNFT.verifyAuthenticity(f.tokenId, hashOf(CERTIFICATE))).to.equal(true);
    });

    for (const [what, forged] of forgeries) {
      it(`rejects it when ${what}`, async function () {
        const f = await issued();
        expect(await f.assetNFT.verifyAuthenticity(f.tokenId, hashOf(forged))).to.equal(false);
      });
    }
  });

  describe("3. not revoked", function () {
    it("the issuing college can rescind a degree, and the record survives", async function () {
      const f = await issued();

      await expect(f.assetNFT.connect(f.manager).revokeAsset(f.tokenId, "awarded in error"))
        .to.emit(f.assetNFT, "AssetRevoked")
        .withArgs(f.tokenId, f.collegeDid, f.manager.address, "awarded in error");

      const asset = await f.assetNFT.assetOf(f.tokenId);
      expect(asset.revoked).to.equal(true);
      // the record is still there - the history stays honest
      expect(asset.issuerDid).to.equal(f.collegeDid);
      expect(await f.assetNFT.ownerOf(f.tokenId)).to.equal(f.alice.address);
    });

    it("a revoked certificate never verifies as authentic, even with the right file", async function () {
      const f = await issued();
      await f.assetNFT.connect(f.manager).revokeAsset(f.tokenId, "rescinded");

      const [status, hashMatches] = await f.assetNFT.verify(f.tokenId, hashOf(CERTIFICATE));
      expect(status).to.equal(STATUS.Revoked);
      expect(hashMatches).to.equal(true); // the file is the original...
      await expect(
        f.assetNFT.verifyAuthenticity(f.tokenId, hashOf(CERTIFICATE))
      ).to.be.revertedWithCustomError(f.assetNFT, "AssetIsRevoked"); // ...but it is not valid
    });

    it("the student cannot un-revoke their own degree", async function () {
      const f = await issued();
      await f.assetNFT.connect(f.manager).revokeAsset(f.tokenId, "rescinded");

      await expect(
        f.assetNFT.connect(f.alice).reinstateAsset(f.tokenId)
      ).to.be.revertedWithCustomError(f.assetNFT, "NotAuthorized");
    });

    it("the student cannot revoke somebody else's certificate either", async function () {
      const f = await issued();
      await expect(
        f.assetNFT.connect(f.alice).revokeAsset(f.tokenId, "i do not like it")
      ).to.be.revertedWithCustomError(f.assetNFT, "NotAuthorized");
    });

    it("the issuer can reinstate one revoked by mistake", async function () {
      const f = await issued();
      await f.assetNFT.connect(f.manager).revokeAsset(f.tokenId, "mistake");
      await f.assetNFT.connect(f.manager).reinstateAsset(f.tokenId);

      const [status] = await f.assetNFT.verify(f.tokenId, hashOf(CERTIFICATE));
      expect(status).to.equal(STATUS.Valid);
      expect(await f.assetNFT.verifyAuthenticity(f.tokenId, hashOf(CERTIFICATE))).to.equal(true);
    });

    it("a revoked asset cannot be transferred to anyone", async function () {
      const f = await loadFixture(platformFixture);
      const studentDid = await f.did(f.alice);
      await f.assetNFT
        .connect(f.manager)
        .mintToDid(studentDid, "ipfs://cert/x", hashOf(CERTIFICATE), "transcript", false);
      await f.assetNFT.connect(f.manager).revokeAsset(1, "rescinded");

      await expect(
        f.assetNFT.connect(f.alice).transferFrom(f.alice.address, f.bob.address, 1)
      ).to.be.revertedWithCustomError(f.assetNFT, "AssetIsRevoked");
    });

    it("revocation is written to the audit trail with a reason", async function () {
      const f = await issued();
      const before = Number(await f.auditTrail.entryCount());
      await f.assetNFT.connect(f.manager).revokeAsset(f.tokenId, "found to be fraudulent");

      const [entry] = await f.auditTrail.getEntries(before, 1);
      expect(entry.action).to.equal(ethers.id("ASSET_REVOKED"));
      expect(entry.actor).to.equal(f.manager.address);
      expect(entry.dataHash).to.equal(ethers.id("found to be fraudulent"));
    });
  });

  describe("one call answers all three questions", function () {
    it("valid, authentic, issued by the college, held by the student", async function () {
      const f = await issued();
      const [status, hashMatches, issuerDid, ownerDid] = await f.assetNFT.verify(
        f.tokenId,
        hashOf(CERTIFICATE)
      );

      expect(status).to.equal(STATUS.Valid);
      expect(hashMatches).to.equal(true);
      expect(issuerDid).to.equal(f.collegeDid);
      expect(ownerDid).to.equal(f.studentDid);
    });

    it("distinguishes an altered file from a revoked credential", async function () {
      const f = await issued();
      const [, altered] = await f.assetNFT.verify(f.tokenId, hashOf(CERTIFICATE + " "));
      expect(altered).to.equal(false);

      await f.assetNFT.connect(f.manager).revokeAsset(f.tokenId, "rescinded");
      const [status, stillMatches] = await f.assetNFT.verify(f.tokenId, hashOf(CERTIFICATE));
      expect(status).to.equal(STATUS.Revoked);
      expect(stillMatches).to.equal(true);
    });

    it("reports an unknown token rather than reverting", async function () {
      const f = await issued();
      const [status] = await f.assetNFT.verify(999, hashOf(CERTIFICATE));
      expect(status).to.equal(STATUS.Unknown);
    });
  });

  describe("permissions", function () {
    it("Manager can revoke assets, an ordinary User cannot", async function () {
      const f = await issued();
      expect(await f.roleManager.hasPermission(f.manager.address, PERM.REVOKE_ASSET)).to.equal(true);
      expect(await f.roleManager.hasPermission(f.alice.address, PERM.REVOKE_ASSET)).to.equal(false);
    });
  });
});

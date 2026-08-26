const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { platformFixture, ROLES } = require("./helpers");

const DEED_HASH = ethers.id("title-deed-2026-0041.pdf");

async function mintToAlice(f, overrides = {}) {
  const { uri = "ipfs://asset/deed-41", hash = DEED_HASH, category = "property-title", soulbound = false } =
    overrides;
  const aliceDid = await f.did(f.alice);
  const tx = await f.assetNFT.connect(f.manager).mintToDid(aliceDid, uri, hash, category, soulbound);
  await tx.wait();
  return { tokenId: await f.assetNFT.totalMinted(), aliceDid };
}

describe("AssetNFT", function () {
  describe("minting", function () {
    it("allocates the NFT to an identity and to its controlling key", async function () {
      const f = await loadFixture(platformFixture);
      const { tokenId, aliceDid } = await mintToAlice(f);

      expect(await f.assetNFT.ownerOf(tokenId)).to.equal(f.alice.address);
      expect(await f.assetNFT.isOwnedByDid(tokenId, aliceDid)).to.equal(true);

      const asset = await f.assetNFT.assetOf(tokenId);
      expect(asset.originDid).to.equal(aliceDid);
      expect(asset.currentDid).to.equal(aliceDid);
      expect(asset.assetHash).to.equal(DEED_HASH);
      expect(asset.category).to.equal("property-title");
      expect(await f.assetNFT.tokenURI(tokenId)).to.equal("ipfs://asset/deed-41");
    });

    it("refuses a minter without MINT_ASSET", async function () {
      const f = await loadFixture(platformFixture);
      const aliceDid = await f.did(f.alice);
      await expect(
        f.assetNFT.connect(f.alice).mintToDid(aliceDid, "ipfs://x", DEED_HASH, "doc", false)
      ).to.be.revertedWithCustomError(f.assetNFT, "NotAuthorized");
    });

    it("refuses to mint to an address with no identity", async function () {
      const f = await loadFixture(platformFixture);
      await expect(
        f.assetNFT.connect(f.manager).mintTo(f.outsider.address, "ipfs://x", DEED_HASH, "doc", false)
      ).to.be.revertedWithCustomError(f.assetNFT, "RecipientHasNoIdentity");
    });

    it("refuses to mint to a revoked identity", async function () {
      const f = await loadFixture(platformFixture);
      const aliceDid = await f.did(f.alice);
      await f.didRegistry.connect(f.admin).revoke(aliceDid);

      await expect(
        f.assetNFT.connect(f.manager).mintToDid(aliceDid, "ipfs://x", DEED_HASH, "doc", false)
      ).to.be.revertedWithCustomError(f.assetNFT, "InactiveIdentity");
    });

    it("verifies authenticity against the hash recorded at issuance", async function () {
      const f = await loadFixture(platformFixture);
      const { tokenId } = await mintToAlice(f);

      expect(await f.assetNFT.verifyAuthenticity(tokenId, DEED_HASH)).to.equal(true);
      expect(await f.assetNFT.verifyAuthenticity(tokenId, ethers.id("tampered.pdf"))).to.equal(false);
    });
  });

  describe("transfers", function () {
    it("moves ownership between identities and re-points the asset", async function () {
      const f = await loadFixture(platformFixture);
      const { tokenId } = await mintToAlice(f);
      const bobDid = await f.did(f.bob);

      await expect(f.assetNFT.connect(f.alice).transferFrom(f.alice.address, f.bob.address, tokenId))
        .to.emit(f.assetNFT, "AssetTransferred")
        .withArgs(tokenId, await f.did(f.alice), bobDid, f.alice.address, false);

      expect(await f.assetNFT.ownerOf(tokenId)).to.equal(f.bob.address);
      expect((await f.assetNFT.assetOf(tokenId)).currentDid).to.equal(bobDid);
      expect((await f.assetNFT.assetOf(tokenId)).originDid).to.equal(await f.did(f.alice));
    });

    it("blocks a transfer to an address with no identity", async function () {
      const f = await loadFixture(platformFixture);
      const { tokenId } = await mintToAlice(f);

      await expect(
        f.assetNFT.connect(f.alice).transferFrom(f.alice.address, f.outsider.address, tokenId)
      ).to.be.revertedWithCustomError(f.assetNFT, "RecipientHasNoIdentity");
    });

    it("blocks a transfer to a revoked identity", async function () {
      const f = await loadFixture(platformFixture);
      const { tokenId } = await mintToAlice(f);
      await f.didRegistry.connect(f.admin).revoke(await f.did(f.bob));

      await expect(
        f.assetNFT.connect(f.alice).transferFrom(f.alice.address, f.bob.address, tokenId)
      ).to.be.revertedWithCustomError(f.assetNFT, "RecipientHasNoIdentity");
    });

    it("never moves a soulbound asset", async function () {
      const f = await loadFixture(platformFixture);
      const { tokenId } = await mintToAlice(f, { soulbound: true, category: "license" });

      await expect(
        f.assetNFT.connect(f.alice).transferFrom(f.alice.address, f.bob.address, tokenId)
      ).to.be.revertedWithCustomError(f.assetNFT, "AssetIsSoulbound");

      await expect(
        f.assetNFT.connect(f.manager).custodialTransfer(f.alice.address, f.bob.address, tokenId)
      ).to.be.revertedWithCustomError(f.assetNFT, "AssetIsSoulbound");
    });

    it("holds a frozen asset in place until it is unfrozen", async function () {
      const f = await loadFixture(platformFixture);
      const { tokenId } = await mintToAlice(f);

      await f.assetNFT.connect(f.manager).setFrozen(tokenId, true);
      await expect(
        f.assetNFT.connect(f.alice).transferFrom(f.alice.address, f.bob.address, tokenId)
      ).to.be.revertedWithCustomError(f.assetNFT, "AssetIsFrozen");

      await f.assetNFT.connect(f.manager).setFrozen(tokenId, false);
      await f.assetNFT.connect(f.alice).transferFrom(f.alice.address, f.bob.address, tokenId);
      expect(await f.assetNFT.ownerOf(tokenId)).to.equal(f.bob.address);
    });

    it("refuses a freeze from someone without FREEZE_ASSET", async function () {
      const f = await loadFixture(platformFixture);
      const { tokenId } = await mintToAlice(f);
      await expect(
        f.assetNFT.connect(f.alice).setFrozen(tokenId, true)
      ).to.be.revertedWithCustomError(f.assetNFT, "NotAuthorized");
    });
  });

  describe("custodial transfer", function () {
    it("lets TRANSFER_ASSET move an asset the caller does not own, flagged as custodial", async function () {
      const f = await loadFixture(platformFixture);
      const { tokenId } = await mintToAlice(f);

      await expect(f.assetNFT.connect(f.manager).custodialTransfer(f.alice.address, f.bob.address, tokenId))
        .to.emit(f.assetNFT, "AssetTransferred")
        .withArgs(tokenId, await f.did(f.alice), await f.did(f.bob), f.manager.address, true);

      expect(await f.assetNFT.ownerOf(tokenId)).to.equal(f.bob.address);
    });

    it("refuses a caller without TRANSFER_ASSET", async function () {
      const f = await loadFixture(platformFixture);
      const { tokenId } = await mintToAlice(f);
      await expect(
        f.assetNFT.connect(f.bob).custodialTransfer(f.alice.address, f.bob.address, tokenId)
      ).to.be.revertedWithCustomError(f.assetNFT, "NotAuthorized");
    });
  });

  describe("key rotation", function () {
    it("lets the new key claim assets the identity still owns", async function () {
      const f = await loadFixture(platformFixture);
      const { tokenId, aliceDid } = await mintToAlice(f, { soulbound: true });

      await f.didRegistry.connect(f.alice).proposeController(f.outsider.address);
      await f.didRegistry.connect(f.outsider).acceptController(aliceDid);

      // the DID still owns it; only the key that holds it is stale
      expect(await f.assetNFT.isOwnedByDid(tokenId, aliceDid)).to.equal(true);
      expect(await f.assetNFT.ownerOf(tokenId)).to.equal(f.alice.address);

      await f.assetNFT.connect(f.outsider).claimByIdentity(tokenId);

      expect(await f.assetNFT.ownerOf(tokenId)).to.equal(f.outsider.address);
      expect((await f.assetNFT.assetOf(tokenId)).currentDid).to.equal(aliceDid);
    });

    it("refuses a claim from a key that does not control the identity", async function () {
      const f = await loadFixture(platformFixture);
      const { tokenId } = await mintToAlice(f);
      await expect(f.assetNFT.connect(f.bob).claimByIdentity(tokenId)).to.be.revertedWithCustomError(
        f.assetNFT,
        "NotAuthorized"
      );
    });
  });

  describe("burning", function () {
    it("needs BURN_ASSET - an Admin can, a Manager cannot", async function () {
      const f = await loadFixture(platformFixture);
      const { tokenId } = await mintToAlice(f);

      await expect(f.assetNFT.connect(f.manager).burn(tokenId)).to.be.revertedWithCustomError(
        f.assetNFT,
        "NotAuthorized"
      );

      await f.assetNFT.connect(f.admin).burn(tokenId);
      await expect(f.assetNFT.ownerOf(tokenId)).to.be.revertedWithCustomError(
        f.assetNFT,
        "ERC721NonexistentToken"
      );
    });
  });

  describe("enumeration", function () {
    it("lists the assets held by a key", async function () {
      const f = await loadFixture(platformFixture);
      await mintToAlice(f, { uri: "ipfs://a" });
      await mintToAlice(f, { uri: "ipfs://b" });

      const ids = await f.assetNFT.tokensOfOwner(f.alice.address);
      expect(ids.map(Number)).to.deep.equal([1, 2]);
      expect(await f.assetNFT.totalMinted()).to.equal(2n);
    });
  });

  describe("role changes take effect immediately", function () {
    it("stops a demoted Manager from minting", async function () {
      const f = await loadFixture(platformFixture);
      await mintToAlice(f);

      await f.roleManager.connect(f.admin).revokeRole(await f.did(f.manager), ROLES.MANAGER);

      await expect(
        f.assetNFT.connect(f.manager).mintToDid(await f.did(f.alice), "ipfs://x", DEED_HASH, "doc", false)
      ).to.be.revertedWithCustomError(f.assetNFT, "NotAuthorized");
    });
  });
});

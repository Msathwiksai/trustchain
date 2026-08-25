const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { platformFixture, signRegistration, ROLES } = require("./helpers");

describe("DIDRegistry", function () {
  describe("self-sovereign registration", function () {
    it("derives a did:tcid identifier from the subject address", async function () {
      const { didRegistry, outsider } = await loadFixture(platformFixture);

      const expected = `did:tcid:31337:${outsider.address.toLowerCase()}`;
      expect(await didRegistry.didStringFor(outsider.address)).to.equal(expected);

      await didRegistry.connect(outsider).register("ipfs://doc");
      expect(await didRegistry.didOf(outsider.address)).to.equal(ethers.id(expected));
    });

    it("stores the document pointer and marks the identity active", async function () {
      const { didRegistry, alice } = await loadFixture(platformFixture);

      const id = await didRegistry.resolveAddress(alice.address);
      expect(id.controller).to.equal(alice.address);
      expect(id.docURI).to.equal("ipfs://did-document/alice");
      expect(id.revoked).to.equal(false);
      expect(await didRegistry.isActive(alice.address)).to.equal(true);
    });

    it("refuses a second identity for the same address", async function () {
      const { didRegistry, alice } = await loadFixture(platformFixture);
      await expect(didRegistry.connect(alice).register("ipfs://again")).to.be.revertedWithCustomError(
        didRegistry,
        "AlreadyRegistered"
      );
    });

    it("reports unknown addresses as inactive", async function () {
      const { didRegistry, outsider } = await loadFixture(platformFixture);
      expect(await didRegistry.isActive(outsider.address)).to.equal(false);
      await expect(didRegistry.resolveAddress(outsider.address)).to.be.revertedWithCustomError(
        didRegistry,
        "UnknownIdentity"
      );
    });
  });

  describe("delegated registration (EIP-712)", function () {
    it("lets a manager pay the gas when the subject signs the request", async function () {
      const { didRegistry, manager, outsider } = await loadFixture(platformFixture);

      const deadline = (await time.latest()) + 3600;
      const sig = await signRegistration(didRegistry, outsider, "ipfs://sponsored", deadline);

      await expect(
        didRegistry.connect(manager).registerFor(outsider.address, "ipfs://sponsored", deadline, sig)
      ).to.emit(didRegistry, "IdentityRegistered");

      const id = await didRegistry.resolveAddress(outsider.address);
      expect(id.controller).to.equal(outsider.address);
      expect(await didRegistry.nonces(outsider.address)).to.equal(1n);
    });

    it("rejects a signature from anyone but the subject", async function () {
      const { didRegistry, manager, alice, outsider } = await loadFixture(platformFixture);

      const deadline = (await time.latest()) + 3600;
      // alice signs a payload whose subject is outsider
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
      const forged = await alice.signTypedData(domain, types, {
        subject: outsider.address,
        docURI: "ipfs://forged",
        nonce: 0,
        deadline,
      });

      await expect(
        didRegistry.connect(manager).registerFor(outsider.address, "ipfs://forged", deadline, forged)
      ).to.be.revertedWithCustomError(didRegistry, "InvalidSignature");
    });

    it("rejects an expired authorisation", async function () {
      const { didRegistry, manager, outsider } = await loadFixture(platformFixture);

      const deadline = (await time.latest()) + 60;
      const sig = await signRegistration(didRegistry, outsider, "ipfs://late", deadline);
      await time.increase(120);

      await expect(
        didRegistry.connect(manager).registerFor(outsider.address, "ipfs://late", deadline, sig)
      ).to.be.revertedWithCustomError(didRegistry, "SignatureExpired");
    });

    it("rejects a caller without REGISTER_IDENTITY", async function () {
      const { didRegistry, alice, outsider } = await loadFixture(platformFixture);

      const deadline = (await time.latest()) + 3600;
      const sig = await signRegistration(didRegistry, outsider, "ipfs://doc", deadline);

      await expect(
        didRegistry.connect(alice).registerFor(outsider.address, "ipfs://doc", deadline, sig)
      ).to.be.revertedWithCustomError(didRegistry, "NotAuthorized");
    });
  });

  describe("key rotation", function () {
    it("keeps the DID and moves control to the new key", async function () {
      const { didRegistry, alice, outsider } = await loadFixture(platformFixture);
      const didBefore = await didRegistry.didOf(alice.address);

      await didRegistry.connect(alice).rotateController(outsider.address);

      expect(await didRegistry.didOf(outsider.address)).to.equal(didBefore);
      expect(await didRegistry.didOf(alice.address)).to.equal(ethers.ZeroHash);
      expect(await didRegistry.isActive(alice.address)).to.equal(false);
      expect(await didRegistry.controllerOf(didBefore)).to.equal(outsider.address);
    });

    it("carries the identity's roles across to the new key", async function () {
      const { didRegistry, roleManager, manager, outsider } = await loadFixture(platformFixture);

      await didRegistry.connect(manager).rotateController(outsider.address);

      expect(await roleManager.hasRole(outsider.address, ROLES.MANAGER)).to.equal(true);
      expect(await roleManager.hasRole(manager.address, ROLES.MANAGER)).to.equal(false);
    });

    it("will not rotate onto a key that already has an identity", async function () {
      const { didRegistry, alice, bob } = await loadFixture(platformFixture);
      await expect(
        didRegistry.connect(alice).rotateController(bob.address)
      ).to.be.revertedWithCustomError(didRegistry, "AlreadyRegistered");
    });
  });

  describe("revocation", function () {
    it("lets the controller revoke itself", async function () {
      const { didRegistry, alice } = await loadFixture(platformFixture);
      const did = await didRegistry.didOf(alice.address);

      await expect(didRegistry.connect(alice).revoke(did)).to.emit(didRegistry, "IdentityRevoked");
      expect(await didRegistry.isActive(alice.address)).to.equal(false);
      expect(await didRegistry.controllerOf(did)).to.equal(ethers.ZeroAddress);
    });

    it("lets an admin revoke someone else, but not an ordinary user", async function () {
      const { didRegistry, admin, alice, bob } = await loadFixture(platformFixture);
      const bobDid = await didRegistry.didOf(bob.address);

      await expect(didRegistry.connect(alice).revoke(bobDid)).to.be.revertedWithCustomError(
        didRegistry,
        "NotAuthorized"
      );
      await didRegistry.connect(admin).revoke(bobDid);
      expect(await didRegistry.isActive(bob.address)).to.equal(false);
    });

    it("makes revocation permanent - the address cannot re-register", async function () {
      const { didRegistry, alice } = await loadFixture(platformFixture);
      const did = await didRegistry.didOf(alice.address);
      await didRegistry.connect(alice).revoke(did);

      await expect(didRegistry.connect(alice).register("ipfs://new")).to.be.revertedWithCustomError(
        didRegistry,
        "AlreadyRegistered"
      );
    });
  });
});

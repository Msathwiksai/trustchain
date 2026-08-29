const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { platformFixture } = require("./helpers");

/**
 * Selective disclosure. The point of these tests is not that a Merkle proof verifies -
 * that is OpenZeppelin's job - but that the credential behaves the way a person needs it
 * to: one field can be shown, the rest cannot be recovered, and the issuer cannot quietly
 * change what the certificate says afterwards.
 */

/** Sorted-pair hashing, matching OpenZeppelin's MerkleProof.verify. */
const pair = (a, b) => (a < b ? ethers.keccak256(ethers.concat([a, b])) : ethers.keccak256(ethers.concat([b, a])));

const leafOf = (label, value, salt) =>
  ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "string", "bytes32"], [label, value, salt]));

function buildTree(fields) {
  const leaves = fields.map((f) => leafOf(f.label, f.value, f.salt));
  const layers = [leaves];
  while (layers[layers.length - 1].length > 1) {
    const below = layers[layers.length - 1];
    const up = [];
    for (let i = 0; i < below.length; i += 2) {
      up.push(i + 1 < below.length ? pair(below[i], below[i + 1]) : below[i]);
    }
    layers.push(up);
  }
  return { root: layers[layers.length - 1][0], layers };
}

function proofFor(tree, index) {
  const proof = [];
  let i = index;
  for (let l = 0; l < tree.layers.length - 1; l++) {
    const layer = tree.layers[l];
    const sibling = i % 2 === 0 ? i + 1 : i - 1;
    if (sibling < layer.length) proof.push(layer[sibling]);
    i = Math.floor(i / 2);
  }
  return proof;
}

const CERTIFICATE = [
  { label: "name", value: "R. Kumar" },
  { label: "degree", value: "Bachelor of Technology" },
  { label: "branch", value: "Computer Science and Engineering" },
  { label: "cgpa", value: "8.7" },
  { label: "year", value: "2026" },
  { label: "certificate-no", value: "BTECH-2026-0417" },
].map((f) => ({ ...f, salt: ethers.hexlify(ethers.randomBytes(32)) }));

async function issued() {
  const f = await loadFixture(platformFixture);
  const Fields = await ethers.getContractFactory("FieldCommitments");
  f.fields = await Fields.deploy(await f.assetNFT.getAddress(), await f.didRegistry.getAddress());
  await f.fields.waitForDeployment();

  // The admin issues a degree to alice, then commits the field tree for it.
  await f.assetNFT
    .connect(f.admin)
    .mintToDid(await f.did(f.alice), "ipfs://cert/x", ethers.id("the whole file"), "degree-certificate", true);
  f.tree = buildTree(CERTIFICATE);
  await f.fields.connect(f.admin).commitFields(1, f.tree.root, CERTIFICATE.length);
  return f;
}

describe("Selective disclosure", function () {
  describe("showing one field", function () {
    it("proves a single field belongs to the credential", async function () {
      const f = await issued();
      const i = CERTIFICATE.findIndex((x) => x.label === "degree");
      const { label, value, salt } = CERTIFICATE[i];

      expect(await f.fields.verifyField(1, label, value, salt, proofFor(f.tree, i))).to.equal(true);
    });

    it("needs no wallet, no gas and no permission - it is a view", async function () {
      const f = await issued();
      const i = CERTIFICATE.findIndex((x) => x.label === "year");
      const { label, value, salt } = CERTIFICATE[i];

      // A stranger with no identity and no role gets the same answer.
      const asStranger = f.fields.connect(f.outsider);
      expect(await asStranger.verifyField(1, label, value, salt, proofFor(f.tree, i))).to.equal(true);
    });

    it("every field in the certificate verifies on its own", async function () {
      const f = await issued();
      for (let i = 0; i < CERTIFICATE.length; i++) {
        const { label, value, salt } = CERTIFICATE[i];
        expect(await f.fields.verifyField(1, label, value, salt, proofFor(f.tree, i)), label).to.equal(true);
      }
    });
  });

  describe("what a verifier cannot learn", function () {
    it("a guessed value does not verify, even with the right proof", async function () {
      const f = await issued();
      const i = CERTIFICATE.findIndex((x) => x.label === "cgpa");
      const { label, salt } = CERTIFICATE[i];
      const proof = proofFor(f.tree, i);

      // Somebody holding the disclosure of another field tries every plausible mark.
      for (const guess of ["8.7", "9.1", "7.4", "10"]) {
        const wrongSalt = ethers.hexlify(ethers.randomBytes(32));
        expect(await f.fields.verifyField(1, label, guess, wrongSalt, proof)).to.equal(false);
      }
    });

    it("the salt is what makes guessing useless - without it even the true value fails", async function () {
      const f = await issued();
      const i = CERTIFICATE.findIndex((x) => x.label === "cgpa");
      const { label, value } = CERTIFICATE[i];

      expect(await f.fields.verifyField(1, label, value, ethers.ZeroHash, proofFor(f.tree, i))).to.equal(false);
    });

    it("a field lifted from one credential does not verify against another", async function () {
      const f = await issued();
      await f.assetNFT
        .connect(f.admin)
        .mintToDid(await f.did(f.bob), "ipfs://cert/y", ethers.id("another file"), "degree-certificate", true);
      const other = buildTree(CERTIFICATE.map((x) => ({ ...x, salt: ethers.hexlify(ethers.randomBytes(32)) })));
      await f.fields.connect(f.admin).commitFields(2, other.root, CERTIFICATE.length);

      const i = CERTIFICATE.findIndex((x) => x.label === "degree");
      const { label, value, salt } = CERTIFICATE[i];
      expect(await f.fields.verifyField(2, label, value, salt, proofFor(f.tree, i))).to.equal(false);
    });

    it("an uncommitted credential verifies nothing at all", async function () {
      const f = await issued();
      await f.assetNFT
        .connect(f.admin)
        .mintToDid(await f.did(f.bob), "ipfs://cert/z", ethers.id("no fields"), "degree-certificate", false);
      const i = 0;
      const { label, value, salt } = CERTIFICATE[i];
      expect(await f.fields.verifyField(2, label, value, salt, proofFor(f.tree, i))).to.equal(false);
    });
  });

  describe("the issuer cannot change the story afterwards", function () {
    it("only the identity that issued the credential may commit its fields", async function () {
      const f = await issued();
      await f.assetNFT
        .connect(f.manager)
        .mintToDid(await f.did(f.alice), "ipfs://cert/m", ethers.id("m"), "degree-certificate", true);
      const tree = buildTree(CERTIFICATE);

      await expect(f.fields.connect(f.admin).commitFields(2, tree.root, 6)).to.be.revertedWithCustomError(
        f.fields,
        "NotTheIssuer"
      );
      await expect(f.fields.connect(f.manager).commitFields(2, tree.root, 6)).to.not.be.reverted;
    });

    it("the fields can never be committed twice", async function () {
      const f = await issued();
      const rewritten = buildTree(
        CERTIFICATE.map((x) => (x.label === "cgpa" ? { ...x, value: "9.9" } : x))
      );
      await expect(f.fields.connect(f.admin).commitFields(1, rewritten.root, 6)).to.be.revertedWithCustomError(
        f.fields,
        "AlreadyCommitted"
      );
    });

    it("the holder cannot commit fields to their own credential", async function () {
      const f = await issued();
      await f.assetNFT
        .connect(f.admin)
        .mintToDid(await f.did(f.alice), "ipfs://cert/a", ethers.id("a"), "degree-certificate", true);
      await expect(
        f.fields.connect(f.alice).commitFields(2, buildTree(CERTIFICATE).root, 6)
      ).to.be.revertedWithCustomError(f.fields, "NotTheIssuer");
    });

    it("the commitment names the issuer permanently, in storage and in the log", async function () {
      const f = await issued();
      const [root, count, , byDid] = await f.fields.commitmentOf(1);

      expect(root).to.equal(f.tree.root);
      expect(count).to.equal(CERTIFICATE.length);
      expect(byDid).to.equal(await f.did(f.admin));

      const logs = await f.fields.queryFilter(f.fields.filters.FieldsCommitted(1), 0);
      expect(logs).to.have.length(1);
      expect(logs[0].args.byDid).to.equal(await f.did(f.admin));
    });

    it("cannot append to the platform audit trail, because nothing new ever can", async function () {
      const f = await issued();
      // The writer set was frozen at deployment. That applies to contracts we write later
      // just as it applies to a stranger's - which is the point of freezing it.
      await expect(
        f.auditTrail.connect(f.admin).setWriter(await f.fields.getAddress(), true)
      ).to.be.revertedWithCustomError(f.auditTrail, "WritersAreLocked");
    });
  });
});

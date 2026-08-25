const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { platformFixture, ACTION } = require("./helpers");

describe("AuditTrail", function () {
  it("records every privileged action in order", async function () {
    const f = await loadFixture(platformFixture);
    const before = await f.auditTrail.entryCount();

    const aliceDid = await f.did(f.alice);
    await f.assetNFT.connect(f.manager).mintToDid(aliceDid, "ipfs://a", ethers.id("a"), "doc", false);
    await f.assetNFT.connect(f.alice).transferFrom(f.alice.address, f.bob.address, 1);
    await f.assetNFT.connect(f.manager).setFrozen(1, true);

    const entries = await f.auditTrail.getEntries(before, 10);
    expect(entries.map((e) => e.action)).to.deep.equal([
      ACTION.ASSET_MINTED,
      ACTION.ASSET_TRANSFERRED,
      ACTION.ASSET_FROZEN,
    ]);
    expect(entries[0].actor).to.equal(f.manager.address);
    expect(entries[1].actor).to.equal(f.alice.address);
    expect(entries[0].subject).to.equal(ethers.zeroPadValue("0x01", 32));
  });

  it("captures identity and role events from onboarding", async function () {
    const f = await loadFixture(platformFixture);
    const entries = await f.auditTrail.getEntries(0, 100);
    const actions = entries.map((e) => e.action);

    // root admin + 4 onboarded identities
    expect(actions.filter((a) => a === ACTION.IDENTITY_REGISTERED).length).to.equal(5);
    // admin bootstrap + manager + auditor + alice + bob
    expect(actions.filter((a) => a === ACTION.ROLE_GRANTED).length).to.equal(5);
  });

  it("refuses writes from anyone that is not a registered platform contract", async function () {
    const f = await loadFixture(platformFixture);
    await expect(
      f.auditTrail.connect(f.admin).record(f.admin.address, ACTION.ASSET_MINTED, ethers.ZeroHash, ethers.ZeroHash)
    ).to.be.revertedWithCustomError(f.auditTrail, "NotWriter");
  });

  it("has no code path that edits or deletes an entry", async function () {
    const f = await loadFixture(platformFixture);
    const names = f.auditTrail.interface.fragments
      .filter((x) => x.type === "function")
      .map((x) => x.name);
    expect(names).to.not.include.members(["update", "edit", "delete", "remove", "clear"]);
  });

  it("pages cleanly past the end of the trail", async function () {
    const f = await loadFixture(platformFixture);
    const total = await f.auditTrail.entryCount();

    expect(await f.auditTrail.getEntries(total, 5)).to.have.lengthOf(0);
    expect(await f.auditTrail.getEntries(total - 2n, 5)).to.have.lengthOf(2);
  });

  it("only lets the governor appoint writers", async function () {
    const f = await loadFixture(platformFixture);
    await expect(
      f.auditTrail.connect(f.alice).setWriter(f.alice.address, true)
    ).to.be.revertedWithCustomError(f.auditTrail, "NotGovernor");
  });
});

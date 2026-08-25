/* TrustChain console - talks to a local Hardhat node over JSON-RPC. */

const RPC = "http://127.0.0.1:8545";
const NAMES = ["AuditTrail", "DIDRegistry", "RoleManager", "AssetNFT"];
const KEY = { AuditTrail: "auditTrail", DIDRegistry: "didRegistry", RoleManager: "roleManager", AssetNFT: "assetNFT" };

const PERMS = [
  ["MANAGE_ROLES", 1n << 0n],
  ["REGISTER_IDENTITY", 1n << 1n],
  ["REVOKE_IDENTITY", 1n << 2n],
  ["MINT_ASSET", 1n << 3n],
  ["TRANSFER_ASSET", 1n << 4n],
  ["FREEZE_ASSET", 1n << 5n],
  ["BURN_ASSET", 1n << 6n],
  ["READ_AUDIT", 1n << 7n],
];
const PERM = Object.fromEntries(PERMS);

const ROLE_LIST = ["ADMIN", "MANAGER", "AUDITOR", "USER"];
const ROLE_ID = Object.fromEntries(ROLE_LIST.map((r) => [r, ethers.id(`ROLE_${r}`)]));
const ROLE_NAME = Object.fromEntries(ROLE_LIST.map((r) => [ROLE_ID[r], r[0] + r.slice(1).toLowerCase()]));

const ACTION_NAME = Object.fromEntries(
  [
    "IDENTITY_REGISTERED", "IDENTITY_UPDATED", "IDENTITY_ROTATED", "IDENTITY_REVOKED",
    "ROLE_GRANTED", "ROLE_REVOKED", "ROLE_PERMS_UPDATED",
    "ASSET_MINTED", "ASSET_TRANSFERRED", "ASSET_FROZEN", "ASSET_UNFROZEN", "ASSET_BURNED",
  ].map((n) => [ethers.id(n), n])
);

const $ = (sel) => document.querySelector(sel);
const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "–");
const shortDid = (d) => (d && d !== ethers.ZeroHash ? d.slice(0, 10) + "…" : "–");

const state = {
  provider: null,
  cfg: null,
  read: {},
  actor: null,
  perms: 0n,
  labels: new Map(), // lowercase address -> friendly name
  identities: [],
  assets: [],
};

// ------------------------------------------------------------------- plumbing

async function boot() {
  try {
    state.cfg = await (await fetch("/deployments/localhost.json", { cache: "no-store" })).json();
  } catch {
    return fatal("No deployments/localhost.json - run `npm run seed:local` against a running `npx hardhat node`.");
  }

  const abis = {};
  for (const n of NAMES) {
    abis[n] = (await (await fetch(`/artifacts/contracts/${n}.sol/${n}.json`)).json()).abi;
  }
  // One interface holding every custom error on the platform, so a revert from any
  // contract can be named rather than shown as an opaque "execution reverted".
  state.errors = new ethers.Interface(NAMES.flatMap((n) => abis[n].filter((f) => f.type === "error")));

  state.provider = new ethers.JsonRpcProvider(RPC);
  try {
    await state.provider.getBlockNumber();
  } catch {
    return fatal("Cannot reach the node at " + RPC + " - is `npx hardhat node` running?");
  }
  for (const n of NAMES) state.read[n] = new ethers.Contract(state.cfg[KEY[n]], abis[n], state.provider);

  const accounts = state.cfg.accounts ?? [{ name: "admin", address: state.cfg.rootAdmin }];
  for (const a of accounts) state.labels.set(a.address.toLowerCase(), a.name);

  const sel = $("#actor");
  sel.innerHTML = accounts
    .map((a) => `<option value="${a.address}">${a.name} - ${short(a.address)}</option>`)
    .join("");
  sel.onchange = () => {
    state.actor = sel.value;
    refresh();
  };
  state.actor = accounts[0].address;

  $("#status").textContent = `chain ${state.cfg.chainId}`;
  $("#status").className = "pill pill-good";
  $("#register-self").onclick = registerSelf;
  $("#mint-form").onsubmit = mint;

  await refresh();
  setInterval(refresh, 5000);
}

function fatal(msg) {
  $("#status").textContent = "offline";
  $("#status").className = "pill pill-bad";
  toast("Not connected", msg, "err");
}

async function writer(name) {
  const signer = await state.provider.getSigner(state.actor);
  return state.read[name].connect(signer);
}

function errName(e) {
  const data = e?.data ?? e?.info?.error?.data?.data ?? e?.info?.error?.data;
  if (typeof data === "string" && data.length >= 10) {
    try {
      const parsed = state.errors.parseError(data);
      if (parsed) return parsed.name;
    } catch {
      /* not one of ours */
    }
  }
  const text = e?.info?.error?.message || e?.shortMessage || e?.message || "transaction failed";
  return text.match(/custom error '(\w+)/)?.[1] ?? text.replace(/^Error: /, "").split(" (")[0];
}

async function send(label, fn) {
  try {
    const tx = await fn();
    await tx.wait();
    toast(label, "confirmed", "ok");
  } catch (e) {
    toast(label + " rejected by contract", errName(e), "err");
  }
  await refresh();
}

function toast(title, detail, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.innerHTML = `<div class="t"></div><div class="d"></div>`;
  el.firstChild.textContent = title;
  el.lastChild.textContent = detail;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), 6000);
}

// --------------------------------------------------------------------- reads

async function refresh() {
  const { DIDRegistry, RoleManager, AssetNFT, AuditTrail } = state.read;

  const dids = await DIDRegistry.allDids(0, 200);
  state.identities = await Promise.all(
    dids.map(async (didHash) => {
      const id = await DIDRegistry.resolve(didHash);
      const roles = await RoleManager.rolesOfDid(didHash);
      return {
        didHash,
        controller: id.controller,
        docURI: id.docURI,
        revoked: id.revoked,
        roles: [...roles],
        perms: await RoleManager.permissionsOfDid(didHash),
      };
    })
  );

  const total = Number(await AssetNFT.totalMinted());
  state.assets = [];
  for (let id = 1; id <= total; id++) {
    const a = await AssetNFT.assetOf(id);
    let owner = null;
    try {
      owner = await AssetNFT.ownerOf(id);
    } catch {
      /* burned */
    }
    state.assets.push({
      id,
      owner,
      currentDid: a.currentDid,
      originDid: a.originDid,
      assetHash: a.assetHash,
      category: a.category,
      soulbound: a.soulbound,
      frozen: a.frozen,
      uri: owner ? await AssetNFT.tokenURI(id) : "",
    });
  }

  state.perms = await RoleManager.permissionsOf(state.actor);
  const count = Number(await AuditTrail.entryCount());
  const entries = await AuditTrail.getEntries(count > 300 ? count - 300 : 0, 300);

  renderMe();
  renderIdentities();
  renderAssets();
  renderAudit(entries, count);
  gate();
}

const can = (name) => (state.perms & PERM[name]) === PERM[name];
const label = (addr) => state.labels.get((addr || "").toLowerCase()) ?? short(addr);

function gate() {
  document.querySelectorAll("[data-perm]").forEach((b) => {
    const need = b.dataset.perm;
    const owned = b.dataset.owner && b.dataset.owner.toLowerCase() === state.actor.toLowerCase();
    const allowed = owned || can(need);
    b.disabled = !allowed;
    b.title = allowed ? "" : `requires ${need}`;
  });
}

// -------------------------------------------------------------------- render

function renderMe() {
  const me = state.identities.find((i) => i.controller.toLowerCase() === state.actor.toLowerCase());
  $("#me-key").textContent = state.actor;
  $("#me-did").textContent = me ? `did:tcid:${state.cfg.chainId}:${me.controller.toLowerCase()}` : "not registered";
  $("#me-status").innerHTML = me
    ? me.revoked
      ? `<span class="pill pill-bad">revoked</span>`
      : `<span class="pill pill-good">active</span>`
    : `<span class="pill pill-muted">no identity</span>`;
  $("#me-roles").innerHTML = me && me.roles.length
    ? me.roles.map((r) => `<span class="chip role">${ROLE_NAME[r] ?? shortDid(r)}</span>`).join("")
    : `<span class="chip">none</span>`;
  $("#me-perms").innerHTML =
    PERMS.filter(([, bit]) => (state.perms & bit) === bit)
      .map(([n]) => `<span class="chip">${n}</span>`)
      .join("") || `<span class="chip">none</span>`;

  $("#register-self").disabled = !!me;
  $("#register-self").title = me ? "this key already controls an identity" : "";
}

function renderIdentities() {
  const box = $("#identities");
  const target = $("#mint-to");
  const active = state.identities.filter((i) => !i.revoked);
  target.innerHTML = active
    .map((i) => `<option value="${i.didHash}">${label(i.controller)} - ${shortDid(i.didHash)}</option>`)
    .join("");

  box.innerHTML = state.identities.length ? "" : `<div class="empty">No identities yet.</div>`;
  for (const i of state.identities) {
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div class="head">
        <span class="title">${label(i.controller)}</span>
        ${i.revoked ? `<span class="pill pill-bad">revoked</span>` : `<span class="pill pill-good">active</span>`}
      </div>
      <div class="sub mono">${i.didHash}</div>
      <div class="sub mono">key ${i.controller} &middot; ${i.docURI}</div>
      <div class="chips">
        ${i.roles.map((r) => `<span class="chip role">${ROLE_NAME[r] ?? shortDid(r)}</span>`).join("") || `<span class="chip">no roles</span>`}
      </div>
      <div class="actions">
        <select class="role-pick">${ROLE_LIST.map((r) => `<option value="${ROLE_ID[r]}">${r}</option>`).join("")}</select>
        <button class="small grant" data-perm="MANAGE_ROLES">Grant</button>
        <button class="small ghost revoke-role" data-perm="MANAGE_ROLES">Revoke role</button>
        <button class="small danger revoke-id" data-perm="REVOKE_IDENTITY" data-owner="${i.controller}">Revoke identity</button>
      </div>`;

    const role = () => el.querySelector(".role-pick").value;
    el.querySelector(".grant").onclick = () =>
      send("Grant role", async () => (await writer("RoleManager")).grantRole(i.didHash, role(), 0));
    el.querySelector(".revoke-role").onclick = () =>
      send("Revoke role", async () => (await writer("RoleManager")).revokeRole(i.didHash, role()));
    el.querySelector(".revoke-id").onclick = () =>
      send("Revoke identity", async () => (await writer("DIDRegistry")).revoke(i.didHash));
    box.append(el);
  }
}

function renderAssets() {
  const box = $("#assets");
  const live = state.assets.filter((a) => a.owner);
  box.innerHTML = live.length ? "" : `<div class="empty">No assets minted yet.</div>`;

  for (const a of live) {
    const el = document.createElement("div");
    el.className = "item";
    const mine = a.owner.toLowerCase() === state.actor.toLowerCase();
    el.innerHTML = `
      <div class="head">
        <span class="title">#${a.id} &middot; ${a.category}</span>
        <div class="chips">
          ${a.soulbound ? `<span class="chip sb">soulbound</span>` : ""}
          ${a.frozen ? `<span class="chip frozen">frozen</span>` : ""}
          ${mine ? `<span class="chip role">yours</span>` : ""}
        </div>
      </div>
      <div class="sub mono">${a.uri}</div>
      <div class="sub mono">held by ${label(a.owner)} &middot; DID ${shortDid(a.currentDid)}${
        a.currentDid !== a.originDid ? ` &middot; issued to ${shortDid(a.originDid)}` : ""
      }</div>
      <div class="actions">
        <select class="to">${state.identities
          .filter((i) => !i.revoked && i.didHash !== a.currentDid)
          .map((i) => `<option value="${i.controller}">to ${label(i.controller)}</option>`)
          .join("")}</select>
        <button class="small move" data-perm="TRANSFER_ASSET" data-owner="${a.owner}">Transfer</button>
        <button class="small ghost freeze" data-perm="FREEZE_ASSET">${a.frozen ? "Unfreeze" : "Freeze"}</button>
        <button class="small danger burn" data-perm="BURN_ASSET">Burn</button>
        <input class="verify" placeholder="source document" />
        <button class="small ghost check">Verify</button>
      </div>`;

    el.querySelector(".move").onclick = () => {
      const to = el.querySelector(".to").value;
      if (!to) return toast("Transfer", "no eligible recipient", "err");
      return send("Transfer", async () => {
        const nft = await writer("AssetNFT");
        return mine ? nft.transferFrom(a.owner, to, a.id) : nft.custodialTransfer(a.owner, to, a.id);
      });
    };
    el.querySelector(".freeze").onclick = () =>
      send(a.frozen ? "Unfreeze" : "Freeze", async () => (await writer("AssetNFT")).setFrozen(a.id, !a.frozen));
    el.querySelector(".burn").onclick = () =>
      send("Burn", async () => (await writer("AssetNFT")).burn(a.id));
    el.querySelector(".check").onclick = async () => {
      const src = el.querySelector(".verify").value;
      const match = await state.read.AssetNFT.verifyAuthenticity(a.id, ethers.id(src));
      toast(`Asset #${a.id}`, match ? `"${src}" matches the issued hash` : `"${src}" does not match`, match ? "ok" : "err");
    };
    box.append(el);
  }
}

function renderAudit(entries, count) {
  $("#audit-count").textContent = `${count} entries`;
  const body = $("#audit tbody");
  body.innerHTML = "";
  const offset = count - entries.length;
  [...entries].reverse().forEach((e, idx) => {
    const i = count - 1 - idx;
    const tr = document.createElement("tr");
    const subject = state.identities.find((x) => x.didHash === e.subject)
      ? label(state.identities.find((x) => x.didHash === e.subject).controller)
      : ACTION_NAME[e.action]?.startsWith("ASSET")
        ? "#" + BigInt(e.subject).toString()
        : shortDid(e.subject);
    tr.innerHTML = `<td>${i}</td><td class="action">${ACTION_NAME[e.action] ?? shortDid(e.action)}</td>
      <td>${label(e.actor)}</td><td>${subject}</td><td>${e.blockNumber}</td>
      <td>${new Date(Number(e.timestamp) * 1000).toLocaleTimeString()}</td>`;
    body.append(tr);
  });
  void offset;
}

// -------------------------------------------------------------------- writes

function registerSelf() {
  return send("Register identity", async () =>
    (await writer("DIDRegistry")).register(`ipfs://did-document/${label(state.actor)}`)
  );
}

function mint(ev) {
  ev.preventDefault();
  const didHash = $("#mint-to").value;
  const uri = $("#mint-uri").value.trim();
  const source = $("#mint-source").value.trim();
  const category = $("#mint-category").value.trim();
  const soulbound = $("#mint-soulbound").checked;
  return send("Mint asset", async () =>
    (await writer("AssetNFT")).mintToDid(didHash, uri, ethers.id(source), category, soulbound)
  );
}

boot();

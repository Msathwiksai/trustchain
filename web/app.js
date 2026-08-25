/* TrustChain console.
 *
 * Reads go straight to the node over JSON-RPC - they need no wallet and work before
 * anyone connects. Every write is signed by MetaMask: the page never holds a key, and
 * the acting identity is whichever account the wallet has selected.
 */

const DEPLOYMENTS = ["localhost", "sepolia"]; // deployments/<name>.json
const FALLBACK_RPC = "http://127.0.0.1:8545";
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
const sameAddr = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

const state = {
  provider: null, // read-only: direct RPC, or the wallet if that is unreachable
  rpcUrl: null,
  readViaWallet: false,
  wallet: null, // ethers.BrowserProvider over window.ethereum
  cfg: null,
  read: {},
  errors: null,
  actor: null, // connected wallet account, or null
  wrongChain: false,
  perms: 0n,
  balance: 0n,
  labels: new Map(), // lowercase address -> friendly name from the seed script
  identities: [],
  assets: [],
};

// ------------------------------------------------------------------- plumbing

async function boot() {
  // The standalone build (scripts/bundle-console.js) inlines the deployment and the ABIs,
  // so the page works from any host - or straight off disk - with nothing to fetch.
  const embedded = typeof window !== "undefined" ? window.__TRUSTCHAIN__ : null;

  const available = [];
  if (embedded) {
    available.push(...embedded.deployments);
  } else {
    for (const name of DEPLOYMENTS) {
      try {
        const res = await fetch(`/deployments/${name}.json`, { cache: "no-store" });
        if (res.ok) available.push(await res.json());
      } catch {
        /* not deployed to this network */
      }
    }
  }
  if (!available.length) {
    return fatal("No deployment found - run `npm run seed:local` (local) or `npm run deploy:sepolia`.");
  }

  const wanted = new URLSearchParams(location.search).get("network");
  state.cfg = available.find((d) => d.network === wanted) ?? available[0];
  state.rpcUrl = state.cfg.rpcUrl || FALLBACK_RPC;
  renderNetworkPicker(available);

  const abis = {};
  if (embedded) {
    Object.assign(abis, embedded.abis);
  } else {
    for (const n of NAMES) {
      abis[n] = (await (await fetch(`/artifacts/contracts/${n}.sol/${n}.json`)).json()).abi;
    }
  }
  // One interface holding every custom error on the platform, so a revert from any
  // contract can be named rather than shown as an opaque "execution reverted".
  state.errors = new ethers.Interface(NAMES.flatMap((n) => abis[n].filter((f) => f.type === "error")));

  // Reads prefer a direct RPC connection - no wallet, no popups, works before connecting.
  // If that endpoint is unreachable, fall back to reading through the injected wallet.
  try {
    state.provider = new ethers.JsonRpcProvider(state.rpcUrl, state.cfg.chainId);
    await state.provider.getBlockNumber();
  } catch {
    if (!injected()) {
      return fatal(`Cannot reach ${state.rpcUrl} and no wallet is installed to read through.`);
    }
    state.provider = new ethers.BrowserProvider(injected());
    state.readViaWallet = true;
    try {
      await state.provider.getBlockNumber();
    } catch {
      return fatal(`Cannot reach ${state.rpcUrl}. Is the network up?`);
    }
  }
  for (const n of NAMES) state.read[n] = new ethers.Contract(state.cfg[KEY[n]], abis[n], state.provider);

  for (const a of state.cfg.accounts ?? []) state.labels.set(a.address.toLowerCase(), a.name);

  const status = $("#status");
  status.textContent = `${state.cfg.network} · chain ${state.cfg.chainId}`;
  status.className = "pill pill-good";
  if (state.cfg.explorer) {
    status.innerHTML = `<a href="${state.cfg.explorer}/address/${state.cfg.assetNFT}" target="_blank" rel="noopener">${state.cfg.network} · chain ${state.cfg.chainId}</a>`;
  }
  $("#connect").onclick = connect;
  $("#register-self").onclick = registerSelf;
  $("#mint-form").onsubmit = mint;

  if (injected()) {
    injected().on?.("accountsChanged", (accts) => {
      state.actor = accts[0] ? ethers.getAddress(accts[0]) : null;
      if (!state.actor) state.wallet = null;
      refresh();
    });
    injected().on?.("chainChanged", () => location.reload());
    // Reconnect silently if this site is already authorised in the wallet.
    const existing = await injected().request({ method: "eth_accounts" });
    if (existing?.length) await connect({ silent: true });
  }

  renderWallet();
  await refresh();
  setInterval(refresh, 5000);
}

function injected() {
  return typeof window !== "undefined" ? window.ethereum : undefined;
}

function fatal(msg) {
  $("#status").textContent = "offline";
  $("#status").className = "pill pill-bad";
  toast("Not connected", msg, "err", true);
}

// -------------------------------------------------------------------- wallet

async function connect({ silent = false } = {}) {
  const eth = injected();
  if (!eth) {
    return toast(
      "No wallet found",
      `Install MetaMask, then add this network: RPC ${state.rpcUrl}, chain id ${state.cfg.chainId}`,
      "err"
    );
  }

  try {
    const accounts = await eth.request({ method: silent ? "eth_accounts" : "eth_requestAccounts" });
    if (!accounts?.length) return;
    state.wallet = new ethers.BrowserProvider(eth);
    state.actor = ethers.getAddress(accounts[0]);
    await ensureChain();
  } catch (e) {
    if (e?.code === 4001) return toast("Connection refused", "you rejected the request in MetaMask", "err");
    return toast("Wallet error", e?.message ?? String(e), "err");
  }

  renderWallet();
  await refresh();
}

/** Ask the wallet to move to the platform's chain, adding it if it is unknown. */
async function ensureChain() {
  const eth = injected();
  const want = "0x" + Number(state.cfg.chainId).toString(16);
  const have = await eth.request({ method: "eth_chainId" });
  if (have?.toLowerCase() === want) {
    state.wrongChain = false;
    return;
  }
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
    state.wrongChain = false;
  } catch (e) {
    if (e?.code === 4902) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: want,
            chainName: `TrustChain (${state.cfg.network})`,
            rpcUrls: [state.rpcUrl],
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          },
        ],
      });
      state.wrongChain = false;
    } else {
      state.wrongChain = true;
      toast("Wrong network", `switch MetaMask to chain ${state.cfg.chainId}`, "err");
    }
  }
}

/** MetaMask has no "switch account" API; re-requesting permissions opens its picker. */
async function switchAccount() {
  const eth = injected();
  try {
    await eth.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
  } catch (e) {
    if (e?.code !== 4001) toast("Wallet error", e?.message ?? String(e), "err");
  }
  await connect({ silent: true });
}

async function writer(name) {
  if (!state.wallet) throw new Error("connect a wallet first");
  if (state.wrongChain) await ensureChain();
  const signer = await state.wallet.getSigner(state.actor);
  return state.read[name].connect(signer);
}

function errName(e) {
  if (e?.code === 4001 || e?.info?.error?.code === 4001) return "you rejected the signature in MetaMask";
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
  if (!state.actor) return toast(label, "connect MetaMask first", "err");
  let toastEl;
  try {
    const tx = await fn();
    toastEl = toast(label, "waiting for confirmation… " + short(tx.hash));
    if (state.cfg.explorer) {
      const a = document.createElement("a");
      a.href = `${state.cfg.explorer}/tx/${tx.hash}`;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = " view";
      toastEl.lastChild.append(a);
    }
    await tx.wait();
    toastEl.remove();
    toast(label, "confirmed", "ok");
  } catch (e) {
    toastEl?.remove();
    toast(label + " rejected", errName(e), "err");
  }
  await refresh();
}

function toast(title, detail, kind = "", persist = false) {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.innerHTML = `<div class="t"></div><div class="d"></div>`;
  el.firstChild.textContent = title;
  el.lastChild.textContent = detail;
  $("#toasts").append(el);
  if (kind && !persist) setTimeout(() => el.remove(), 6000);
  return el;
}

// --------------------------------------------------------------------- reads

async function refresh() {
  try {
    await readChain();
    state.readFailed = false;
  } catch (e) {
    // A deployment file pointing at the wrong chain, or contracts that are not there,
    // shows up here. Say so once rather than every poll.
    if (!state.readFailed) {
      state.readFailed = true;
      fatal(`Cannot read the contracts on ${state.cfg.network} - check deployments/${state.cfg.network}.json. (${e.shortMessage ?? e.message})`);
    }
  }
}

async function readChain() {
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
      category: a.category,
      soulbound: a.soulbound,
      frozen: a.frozen,
      uri: owner ? await AssetNFT.tokenURI(id) : "",
    });
  }

  state.perms = state.actor ? await RoleManager.permissionsOf(state.actor) : 0n;
  state.balance = state.actor ? await state.provider.getBalance(state.actor) : 0n;
  const count = Number(await AuditTrail.entryCount());
  const entries = await AuditTrail.getEntries(count > 300 ? count - 300 : 0, 300);

  renderMe();
  renderOnboarding();
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
    if (!state.actor) {
      b.disabled = true;
      b.title = "connect MetaMask";
      return;
    }
    const owned = sameAddr(b.dataset.owner, state.actor);
    const allowed = owned || can(need);
    b.disabled = !allowed;
    b.title = allowed ? "" : `requires ${need}`;
  });
}

// -------------------------------------------------------------------- render

function renderNetworkPicker(available) {
  const sel = $("#network");
  if (available.length < 2) {
    sel.hidden = true;
    return;
  }
  sel.hidden = false;
  sel.innerHTML = available.map((d) => `<option value="${d.network}">${d.network}</option>`).join("");
  sel.value = state.cfg.network;
  sel.onchange = () => {
    location.search = `?network=${sel.value}`;
  };
}

function renderWallet() {
  const btn = $("#connect");
  const tag = $("#wallet-label");

  if (!state.actor) {
    tag.textContent = injected() ? "not connected" : "MetaMask not detected";
    tag.className = "pill pill-muted";
    btn.textContent = "Connect MetaMask";
    btn.onclick = connect;
    btn.disabled = false;
    return;
  }

  const name = state.labels.get(state.actor.toLowerCase());
  tag.textContent = (name ? name + " · " : "") + short(state.actor);
  tag.className = state.wrongChain ? "pill pill-bad" : "pill pill-good";
  btn.textContent = "Switch account";
  btn.onclick = switchAccount;
  btn.disabled = false;
}

function renderMe() {
  const me = state.identities.find((i) => sameAddr(i.controller, state.actor));
  $("#me-key").textContent = state.actor ?? "no wallet connected";
  $("#me-did").textContent = me
    ? `did:tcid:${state.cfg.chainId}:${me.controller.toLowerCase()}`
    : state.actor
      ? "not registered"
      : "–";
  $("#me-status").innerHTML = !state.actor
    ? `<span class="pill pill-muted">disconnected</span>`
    : me
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

  const reg = $("#register-self");
  reg.disabled = !state.actor || !!me;
  reg.title = !state.actor ? "connect MetaMask" : me ? "this key already controls an identity" : "";
}

/**
 * A first-time visitor arrives here with a link and nothing else - no wallet, no test
 * funds, no identity. This walks them from that state to a registered identity, and
 * disappears once they are through it.
 */
function renderOnboarding() {
  const panel = $("#onboarding");
  const me = state.identities.find((i) => sameAddr(i.controller, state.actor));
  const local = state.cfg.chainId === 31337;
  const funded = state.balance > 0n;

  const steps = [
    {
      done: !!injected(),
      what: "Install MetaMask",
      why: "A browser extension that holds your key and signs for you. There is no username or password on this platform - your wallet is your login.",
      action: !injected()
        ? `<a class="btn" href="https://metamask.io/download/" target="_blank" rel="noopener">Get MetaMask</a>
           <span class="why">then reload this page</span>`
        : "",
    },
    {
      done: !!state.actor,
      what: "Connect your wallet",
      why: "This page never sees your key. It asks MetaMask to sign, and you approve each transaction yourself.",
      action: !state.actor && injected() ? `<button class="small" id="onboard-connect">Connect MetaMask</button>` : "",
    },
  ];

  if (!local) {
    steps.push({
      done: funded,
      what: "Get free test ETH",
      why: funded
        ? `Balance ${(+ethers.formatEther(state.balance)).toFixed(4)} ETH - enough for hundreds of actions.`
        : `Sepolia is a test network, so its ETH is not real money and costs nothing. A faucet sends you some free.${
            state.actor ? ` Paste your address: <code>${state.actor}</code>` : " Connect first to see your address."
          }`,
      action:
        !funded && state.actor
          ? `<a class="btn" href="https://cloud.google.com/application/web3/faucet/ethereum/sepolia" target="_blank" rel="noopener">Open the faucet</a>
             <a class="btn ghost" href="${state.cfg.explorer}/address/${state.actor}" target="_blank" rel="noopener">Check it arrived</a>`
          : "",
    });
  }

  steps.push({
    done: !!me && !me.revoked,
    what: "Register your identity",
    why: me
      ? "Done - you now have a decentralised identifier on the blockchain. An admin can grant you a role from here."
      : "Creates your DID on-chain. It costs one small transaction and is yours alone; nobody can create it for you without your signature.",
    action: !me && state.actor && funded ? `<button class="small" id="onboard-register">Register my identity</button>` : "",
  });

  const doneCount = steps.filter((x) => x.done).length;
  if (doneCount === steps.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  $("#onboard-progress").textContent = `step ${Math.min(doneCount + 1, steps.length)} of ${steps.length}`;

  const firstOpen = steps.findIndex((x) => !x.done);
  $("#onboard-steps").innerHTML = steps
    .map((x, i) => {
      const cls = x.done ? "done" : i === firstOpen ? "active" : "";
      return `<li class="${cls}">
        <span class="marker">${x.done ? "&check;" : i + 1}</span>
        <div class="body">
          <span class="what">${x.what}</span>
          <span class="why">${x.why}</span>
          ${x.action ? `<div class="row">${x.action}</div>` : ""}
        </div>
      </li>`;
    })
    .join("");

  const c = $("#onboard-connect");
  if (c) c.onclick = connect;
  const r = $("#onboard-register");
  if (r) r.onclick = registerSelf;
}

function renderIdentities() {
  const box = $("#identities");
  const target = $("#mint-to");
  const active = state.identities.filter((i) => !i.revoked);
  const keep = target.value;
  target.innerHTML = active
    .map((i) => `<option value="${i.didHash}">${label(i.controller)} - ${shortDid(i.didHash)}</option>`)
    .join("");
  if (keep && active.some((i) => i.didHash === keep)) target.value = keep;

  box.innerHTML = state.identities.length ? "" : `<div class="empty">No identities yet.</div>`;
  for (const i of state.identities) {
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div class="head">
        <span class="title">${label(i.controller)}${sameAddr(i.controller, state.actor) ? " (you)" : ""}</span>
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
    const mine = sameAddr(a.owner, state.actor);
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
  [...entries].reverse().forEach((e, idx) => {
    const i = count - 1 - idx;
    const identity = state.identities.find((x) => x.didHash === e.subject);
    const subject = identity
      ? label(identity.controller)
      : ACTION_NAME[e.action]?.startsWith("ASSET")
        ? "#" + BigInt(e.subject).toString()
        : shortDid(e.subject);
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${i}</td><td class="action">${ACTION_NAME[e.action] ?? shortDid(e.action)}</td>
      <td>${label(e.actor)}</td><td>${subject}</td><td>${e.blockNumber}</td>
      <td>${new Date(Number(e.timestamp) * 1000).toLocaleTimeString()}</td>`;
    body.append(tr);
  });
}

// -------------------------------------------------------------------- writes

function registerSelf() {
  const name = state.labels.get(state.actor.toLowerCase()) ?? state.actor.toLowerCase();
  return send("Register identity", async () =>
    (await writer("DIDRegistry")).register(`ipfs://did-document/${name}`)
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

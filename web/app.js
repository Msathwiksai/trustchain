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
  ["REVOKE_ASSET", 1n << 8n],
];
const PERM = Object.fromEntries(PERMS);

const ROLE_LIST = ["ADMIN", "MANAGER", "AUDITOR", "USER"];

/**
 * Running out of test ETH mid-demonstration looks exactly like the platform being broken:
 * every button still works, and the failure arrives in MetaMask. Named per chain, because
 * a local chain has no faucet and pointing anyone at one there would be nonsense.
 */
const FAUCETS = {
  11155111: [
    ["Mine some yourself", "https://sepolia-faucet.pk910.de/"],
    ["Google faucet", "https://cloud.google.com/application/web3/faucet/ethereum/sepolia"],
    ["Alchemy faucet", "https://www.alchemy.com/faucets/ethereum-sepolia"],
  ],
};
const LOW_GAS = 1000000000000000n; // 0.001 ETH - a few transactions' worth, no more
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

/**
 * Anything that came off the chain was written by whoever paid for that transaction -
 * a document URI, an asset category, a token URI. Interpolating it into innerHTML hands
 * a stranger script execution in every console, next to buttons that sign transactions.
 * Every chain-derived value goes through here first.
 */
function esc(value) {
  return String(value ?? "").replace(/[&<>"'`]/g, (c) => ESCAPES[c]);
}
const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };

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
  walletLocked: false, // authorised, but MetaMask is locked and reports no accounts
  walletChain: null, // the chain the wallet sits on, known even while disconnected
  perms: 0n,
  balance: 0n,
  request: null, // signed identity request awaiting an administrator
  requestName: "",
  refreshing: false,
  spotlightUntil: 0,
  labels: new Map(), // lowercase address -> friendly name from the seed script
  identities: [],
  assets: [],
  chain: {
    head: 0, // latest block on the network, whether or not it concerns us
    blocks: new Map(), // block number -> action names recorded in it
    headers: new Map(), // block number -> { hash, parentHash, time }, cached forever
    failed: false,
  },
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
  let chosen = available.find((d) => d.network === wanted);
  if (!chosen && available.length > 1 && injected()) {
    // With more than one deployment around, follow whichever chain the wallet is already
    // on. Nobody has to think about networks, and nothing has to be switched.
    const walletChain = Number(await askWallet("eth_chainId")) || 0;
    chosen = available.find((d) => Number(d.chainId) === walletChain);
  }
  state.cfg = chosen ?? available[0];
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
    status.innerHTML = `<a href="${esc(state.cfg.explorer)}/address/${esc(state.cfg.assetNFT)}" target="_blank" rel="noopener">${esc(state.cfg.network)} · chain ${esc(state.cfg.chainId)}</a>`;
  }
  $("#connect").onclick = connect;
  $("#register-self").onclick = registerSelf;
  $("#mint-form").onsubmit = mint;
  $("#mint-file").onchange = previewMintFile;
  $("#approve-form").onsubmit = approveRequest;
  $("#approve-code").oninput = previewRequest;

  initHelp();
  initGuide();
  renderWallet();

  // The chain data needs no wallet, so it goes on screen before the wallet is touched.
  await refresh();
  setInterval(refresh, 8000);

  if (injected()) {
    injected().on?.("accountsChanged", (accts) => {
      state.actor = accts[0] ? ethers.getAddress(accts[0]) : null;
      // The signer has to be rebuilt alongside the account. Unlocking MetaMask arrives
      // here as an account with no provider behind it, and the page would then hold an
      // address it cannot sign for - failing much later, at the worst moment, with a
      // message about nothing in particular.
      state.wallet = state.actor ? new ethers.BrowserProvider(injected()) : null;
      state.walletLocked = false;
      state.request = null; // a request signed by the previous key is not this one's
      refresh();
    });
    injected().on?.("chainChanged", () => location.reload());

    // Reconnect silently if this site is already authorised. Time-boxed, and failure
    // here costs the reader nothing: the page is already usable, just read-only.
    await trySilentConnect();
  }
}

function injected() {
  return typeof window !== "undefined" ? window.ethereum : undefined;
}

/**
 * Every wallet call made while the page is starting is time-boxed. A wallet sitting
 * behind a stack of unanswered confirmations never replies, and an un-timed await on it
 * leaves the page blank forever - which is a far worse failure than not knowing the
 * answer, because the reader cannot even see the data that needs no wallet at all.
 */
function askWallet(method, params, ms = 2500) {
  const eth = injected();
  if (!eth) return Promise.resolve(null);
  return Promise.race([
    eth.request({ method, params }).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
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
    // Only ever prompt for a network switch on a deliberate action - never on a reload,
    // or a background tab quietly stacks up confirmations in the wallet.
    if (silent) {
      state.wrongChain = !(await onPlatformChain());
    } else {
      await ensureChain();
    }
  } catch (e) {
    if (e?.code === 4001) return toast("Connection refused", "you rejected the request in MetaMask", "err");
    return toast("Wallet error", e?.message ?? String(e), "err");
  }

  renderWallet();
  await refresh();
}

/**
 * A laptop that was switched off comes back with MetaMask locked, and a locked wallet
 * reports no accounts at all - even though this site is still authorised and nothing was
 * actually revoked. The old code asked once, at load, and then left the reader looking at
 * a page that said "not connected" with no hint that the fix was to type their MetaMask
 * password. This keeps asking quietly on every poll, so the page reconnects itself the
 * moment the wallet is open again, and says plainly which of the two states it is in.
 */
async function trySilentConnect() {
  if (state.actor || !injected()) return;
  const accounts = await askWallet("eth_accounts");
  state.walletChain = Number(await askWallet("eth_chainId")) || null;
  state.walletLocked = !accounts?.length && (await walletIsLocked());
  if (accounts?.length) {
    await connect({ silent: true }).catch(() => {});
  } else {
    renderWallet();
    renderMismatch();
  }
}

/** MetaMask exposes this; other wallets may not, and "unknown" must not read as locked. */
async function walletIsLocked() {
  try {
    const unlocked = injected()?._metamask?.isUnlocked?.();
    return unlocked === undefined ? false : !(await unlocked);
  } catch {
    return false;
  }
}

async function walletChainId() {
  try {
    return Number(await injected().request({ method: "eth_chainId" }));
  } catch {
    return null;
  }
}

async function onPlatformChain() {
  return (await walletChainId()) === Number(state.cfg.chainId);
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
  // ensureChain leaves the flag standing if the switch was refused or failed, and going
  // ahead from here would submit the transaction to whichever chain the wallet is really
  // on. On a wallet left on mainnet that is real money spent on a contract that is not
  // there, so this stops instead.
  if (state.wrongChain) {
    throw new Error(`MetaMask is not on ${state.cfg.network} - nothing was sent`);
  }
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

/** Clipboard where it is allowed, text selection where it is not. */
function copyText(text, btn, label) {
  const restore = btn.textContent;
  const done = (m) => {
    btn.textContent = m;
    setTimeout(() => (btn.textContent = restore), 1600);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => done(label), () => done("Select it manually"));
  } else {
    done("Select it manually");
  }
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

/**
 * Hash the actual bytes of a file, in the browser, exactly as the contract expects.
 *
 * This is the difference between demonstrating the idea and doing the thing: hashing a
 * typed filename proves nothing, because the name of an altered certificate is unchanged.
 * Hashing the bytes means a single edited character anywhere in the document produces a
 * different hash and verification fails.
 */
async function hashFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return ethers.keccak256(bytes);
}

const prettyBytes = (n) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

// ----------------------------------------------- identity without any funds

/**
 * A newcomer has no ETH, and telling them to visit a faucet before they can do anything
 * is the worst first impression this platform can make. It does not need to: the registry
 * accepts an EIP-712 consent signature from the subject, submitted and paid for by anyone
 * holding REGISTER_IDENTITY.
 *
 * So the newcomer signs - free, instant, no balance - and hands the resulting code to an
 * administrator, who approves it. The signature is what makes it safe: the administrator
 * is paying, not impersonating, and cannot alter a single field without the contract
 * rejecting it.
 */
function registrationTypes() {
  return {
    RegisterIdentity: [
      { name: "subject", type: "address" },
      { name: "docURI", type: "string" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
}

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

async function signIdentityRequest() {
  if (!state.actor) return toast("Request identity", "connect MetaMask first", "err");
  try {
    // Whatever they call themselves is inside the signed payload, so an administrator can
    // read it before approving and cannot change it afterwards.
    const typed = slugify($("#request-name")?.value ?? "");
    const docURI = `ipfs://did-document/${typed || state.actor.toLowerCase()}`;
    const deadline = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
    const nonce = await state.read.DIDRegistry.nonces(state.actor);

    const signer = await state.wallet.getSigner(state.actor);
    const signature = await signer.signTypedData(
      {
        name: "TrustChainDIDRegistry",
        version: "1",
        chainId: state.cfg.chainId,
        verifyingContract: state.cfg.didRegistry,
      },
      registrationTypes(),
      { subject: state.actor, docURI, nonce, deadline }
    );

    // The chain is inside the signature already; carrying it in the code as well lets the
    // administrator be told which network it belongs to, instead of watching it revert.
    state.request = btoa(
      JSON.stringify({ chainId: Number(state.cfg.chainId), subject: state.actor, docURI, deadline, signature })
    );
    toast("Signed", "no gas was spent - give the code to an administrator", "ok");
    renderOnboarding();
  } catch (e) {
    toast("Signing failed", errName(e), "err");
  }
}

function decodeRequest(code) {
  const r = JSON.parse(atob(code.trim()));
  if (!r.subject || !r.docURI || !r.deadline || !r.signature) throw new Error("incomplete request");
  ethers.getAddress(r.subject);
  return r;
}

/** Older codes carry no chain, and an unknown chain is not evidence of a wrong one. */
const wrongChainRequest = (r) => r.chainId != null && Number(r.chainId) !== Number(state.cfg.chainId);

function approveRequest(ev) {
  ev.preventDefault();
  let r;
  try {
    r = decodeRequest($("#approve-code").value);
  } catch {
    return toast("Approve", "that does not look like a request code", "err");
  }
  if (r.deadline * 1000 < Date.now()) return toast("Approve", "this request has expired", "err");
  if (wrongChainRequest(r)) {
    return toast("Approve", `this was signed for chain ${r.chainId}, not ${state.cfg.network}`, "err");
  }

  return send("Register identity", async () =>
    (await writer("DIDRegistry")).registerFor(r.subject, r.docURI, r.deadline, r.signature)
  ).then(() => {
    $("#approve-code").value = "";
    $("#approve-preview").textContent = "They sign; you submit and pay the gas.";
  });
}

/**
 * One line per control, in the words someone actually needs: what it does, and who is
 * allowed to use it. Deterministic, offline, and it cannot invent an answer.
 */
const HELP = {
  did: "This person's permanent identity. It never changes, even if they move to a new wallet - which is why their roles and assets survive a lost key.",
  key: "The wallet controlling this identity right now. This CAN change, through key rotation or guardian recovery. The DID above stays the same.",
  docuri: "A pointer to their identity document, stored off-chain. The pointer is public; the document is not.",
  rolechip: "The role this identity holds. Permissions come from the role, so taking the role away removes all of them at once.",
  rolepick: "Choose which role to give or take away. Nothing is preselected, so a row never implies a role this person does not hold. Admin grants every permission on the platform, so it asks you to confirm by name.",
  grant: "Gives the selected role to this person. Needs MANAGE_ROLES, and you can only grant roles you administer - a Manager can create Users but never another Manager.",
  revokerole: "Takes the selected role away. They keep their identity and any other roles; only this one's permissions stop working.",
  revokeid: "Kills the identity itself. Every role dies at once and it cannot be undone. Use it when someone leaves the organisation - not to remove one permission.",
  approve: "Paste the code someone signed on their own device. You submit it and pay the gas; their signature is what authorises it, so you cannot change a single field of what they agreed to.",
  mintto: "Which identity receives this asset. It must be a registered, active identity - assets cannot be issued into thin air.",
  category: "What kind of thing this is: a degree certificate, a property title, a laptop. Free text, shown to anyone inspecting the asset.",
  uri: "Where the full record lives off-chain, e.g. on IPFS. Public, so it should not name anything sensitive.",
  source: "Pick the actual file and its bytes are hashed here in your browser. That hash is what gets committed, so a later copy that differs by even one character will fail verification.",
  soulbound: "Tick this for anything that should never change hands: a degree, a licence, a clearance. Soulbound assets cannot be transferred by anyone, including you.",
  mint: "Issues the asset on-chain to the chosen identity, with you recorded as the issuer. Needs MINT_ASSET.",
  transfer: "Moves the asset to another identity. You can move your own; moving somebody else's needs TRANSFER_ASSET and is logged as a custodial action.",
  freeze: "Temporarily stops an asset moving, for a dispute or an investigation. It stays valid and verifiable - it just cannot change hands. Needs FREEZE_ASSET.",
  revokeasset: "Rescinds a credential without deleting it: a degree withdrawn, a licence lapsed. It stops verifying as valid, but the record stays so the history remains honest. Only the issuer, or REVOKE_ASSET.",
  burn: "Destroys the asset entirely. Prefer Revoke for a credential - burning erases the record, which is usually the wrong thing for an audit. Needs BURN_ASSET.",
  verifyfile: "Choose the file someone handed you. Your browser hashes it and compares against what was committed at issuance, then tells you authentic, altered, or revoked.",
  audit: "Every privileged action, written by the contract that performed it, in the same transaction. Nothing here can be edited or deleted by anyone, including an administrator.",
  chain: "The blocks underneath this platform. A node is a computer running Ethereum and holding the chain; this page reads from one over the internet. Each block carries the hash of the block before it, which is why an old entry cannot be quietly rewritten - its hash would change, and every block after it would stop matching.",
  network: "Which blockchain this page is reading. Your wallet must be on the same one to sign anything.",
};

const helpBtn = (key) => `<button type="button" class="help" data-help="${key}" aria-label="What is this?">?</button>`;

function initHelp() {
  // Markup-declared slots, so static controls get the same "?" as generated rows.
  document.querySelectorAll(".helpslot").forEach((slot) => {
    slot.innerHTML = helpBtn(slot.dataset.helpKey);
  });

  const pop = $("#help-pop");
  document.addEventListener("click", (ev) => {
    const btn = ev.target.closest?.("button.help");
    if (!btn) {
      pop.hidden = true;
      return;
    }
    ev.preventDefault();
    pop.textContent = HELP[btn.dataset.help] ?? "";
    pop.hidden = false;
    const r = btn.getBoundingClientRect();
    pop.style.top = `${window.scrollY + r.bottom + 8}px`;
    pop.style.left = `${Math.max(12, Math.min(window.scrollX + r.left - 8, window.innerWidth - 316))}px`;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") pop.hidden = true;
  });
}

/**
 * A dialog for the actions that cannot be undone. Cancel holds focus, so a stray Enter
 * or a double-click on the button underneath does nothing.
 */
function confirmAction({ title, body, consequence, confirmLabel }) {
  const dlg = $("#confirm");
  $("#confirm-title").textContent = title;
  $("#confirm-body").textContent = body;
  $("#confirm-consequence").textContent = consequence;
  $("#confirm-go").textContent = confirmLabel;

  return new Promise((resolve) => {
    const done = (ok) => {
      dlg.close();
      $("#confirm-go").onclick = null;
      $("#confirm-cancel").onclick = null;
      dlg.onclose = null;
      resolve(ok);
    };
    $("#confirm-go").onclick = () => done(true);
    $("#confirm-cancel").onclick = () => done(false);
    dlg.onclose = () => resolve(false); // Escape, or the backdrop
    dlg.showModal();
    $("#confirm-cancel").focus();
  });
}

// ------------------------------------------------------------- guided tour

const GUIDES = [
  {
    id: "role",
    title: "Give someone a role",
    why: "New people arrive with an identity and no permissions at all. This is how they get access.",
    steps: [
      { txt: "Find them in <b>Identities</b>. Someone new sits at the top with an amber <b>awaiting access</b> chip.", sel: "#identities" },
      { txt: "In their row, open the dropdown and choose the role. <b>It starts on ADMIN</b> - change it unless you really mean administrator.", sel: "#identities .role-pick" },
      { txt: "Click <b>Grant</b> and approve in MetaMask.", sel: "#identities .grant" },
      { txt: "They refresh their page and their new permissions are live." },
    ],
  },
  {
    id: "onboard",
    title: "Add someone with no crypto",
    why: "They need no ETH and no faucet. They sign; you submit and pay.",
    steps: [
      { txt: "Send them your console link. They install MetaMask, connect, type their name and click <b>Sign a request</b>." },
      { txt: "They click <b>Copy code</b> and send you that text - WhatsApp is fine, it is not secret." },
      { txt: "Paste it into <b>Identity request from someone with no ETH</b>.", sel: "#approve-code" },
      { txt: "Check the preview names the right person, then click <b>Approve &amp; register</b>.", sel: "#approve-btn" },
      { txt: "They appear in your list as <b>awaiting access</b>. Give them a role using the guide above." },
    ],
  },
  {
    id: "issue",
    title: "Issue a certificate",
    why: "The organisation commits a fingerprint of the real document, so any later copy that differs can be caught.",
    steps: [
      { txt: "In <b>Assets</b>, choose who receives it under <b>Allocate to</b>.", sel: "#mint-to" },
      { txt: "Set a <b>Category</b> such as degree-certificate.", sel: "#mint-category" },
      { txt: "Click <b>Hash a real file</b> and pick the actual document. Its bytes are hashed in your browser.", sel: "#mint-file" },
      { txt: "Tick <b>Soulbound</b> for anything that must never change hands, like a degree.", sel: "#mint-soulbound" },
      { txt: "Click <b>Mint asset NFT</b> and approve in MetaMask.", sel: "#mint-btn" },
    ],
  },
  {
    id: "verify",
    title: "Check a certificate is genuine",
    why: "This is the demo worth showing a judge. Let them edit the file first.",
    steps: [
      { txt: "Find the asset and click <b>Verify a file</b>.", sel: "#assets .filebtn" },
      { txt: "Choose the file you were handed. Nothing is uploaded - it is hashed in your browser." },
      { txt: "You get one of: <b>AUTHENTIC</b> with the issuer named, <b>ALTERED</b>, or <b>REVOKED</b>." },
      { txt: "Change one character of the file and try again. It fails, because the hash changes." },
    ],
  },
  {
    id: "remove",
    title: "Take access away",
    why: "Two different things, often confused. Pick the smaller one unless you mean the larger.",
    steps: [
      { txt: "<b>Revoke role</b> removes one role. They keep their identity and any other roles.", sel: "#identities .revoke-role" },
      { txt: "<b>Revoke identity</b> kills the identity itself - every role at once, permanently. For someone leaving.", sel: "#identities .revoke-id" },
      { txt: "For a certificate that should stop being valid, use <b>Revoke</b> on the asset instead. It keeps the record.", sel: "#assets .revoke-asset" },
      { txt: "Either way it lands in the audit trail with your name against it.", sel: "#audit" },
    ],
  },
  {
    id: "prove",
    title: "Prove it is a real blockchain",
    why: "Do not ask a judge to believe you. Hand them the check.",
    steps: [
      { txt: "Note the number in the <b>Audit trail</b> header.", sel: "#audit-count" },
      { txt: "Ask them to open the contract on Etherscan and read <b>entryCount</b> themselves - no wallet needed.", sel: "#status" },
      { txt: "It matches. Now do something here - mint an asset, grant a role." },
      { txt: "Ask them to refresh. The number went up on a server neither of you controls." },
    ],
  },
];

function initGuide() {
  const panel = $("#guide");
  const tasks = $("#guide-tasks");

  tasks.innerHTML = GUIDES.map(
    (g, i) => `<button type="button" data-guide="${g.id}" aria-selected="${i === 0}">${g.title}</button>`
  ).join("");

  const show = (id) => {
    const g = GUIDES.find((x) => x.id === id) ?? GUIDES[0];
    tasks.querySelectorAll("button").forEach((b) =>
      b.setAttribute("aria-selected", String(b.dataset.guide === g.id))
    );
    $("#guide-steps").innerHTML = `
      <p class="why">${g.why}</p>
      <ol>${g.steps
        .map(
          (st, i) => `<li><span class="n">${i + 1}</span><span class="txt">${st.txt}${
            st.sel ? `<button type="button" class="showme" data-sel="${st.sel}">show me</button>` : ""
          }</span></li>`
        )
        .join("")}</ol>`;

    $("#guide-steps")
      .querySelectorAll("button.showme")
      .forEach((b) => (b.onclick = () => spotlight(b.dataset.sel)));
  };

  tasks.onclick = (ev) => {
    const b = ev.target.closest("button[data-guide]");
    if (b) show(b.dataset.guide);
  };

  $("#guide-toggle").onclick = () => {
    panel.hidden = !panel.hidden;
    $("#guide-toggle").textContent = panel.hidden ? "Show me how" : "Hide guide";
    if (!panel.hidden) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  $("#guide-close").onclick = () => {
    panel.hidden = true;
    $("#guide-toggle").textContent = "Show me how";
  };

  show(GUIDES[0].id);
}

/** Scroll a control into view and flash a ring around it, so "click Grant" means something. */
function spotlight(selector) {
  const el = document.querySelector(selector);
  if (!el) return toast("Not on screen", "that control appears once there is something to act on", "err");
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("spotlight");
  void el.offsetWidth; // restart the animation
  el.classList.add("spotlight");
  state.spotlightUntil = Date.now() + 2400;
  setTimeout(() => el.classList.remove("spotlight"), 2200);
}

// --------------------------------------------------------------------- reads

/**
 * A burned token and an unreachable node both make `ownerOf` throw. Treating them the
 * same made assets blink out of the list whenever the public endpoint hiccupped, so this
 * only reports "burned" when the chain positively says the token does not exist, and
 * rethrows everything else for the caller to handle as a failed read.
 */
async function ownerOrBurned(nft, id) {
  try {
    return await nft.ownerOf(id);
  } catch (e) {
    const gone =
      e?.revert?.name === "ERC721NonexistentToken" ||
      /ERC721NonexistentToken/.test(e?.info?.error?.message ?? e?.shortMessage ?? e?.message ?? "");
    if (gone) return null;
    throw e;
  }
}

async function refresh() {
  // A poll that is still in flight must finish before the next one starts, or two
  // interleaved reads render out of order and the page appears to flicker.
  if (state.refreshing) return;
  // A poll that re-renders mid-highlight silently replaces the element the guide is
  // pointing at, so hold off for the couple of seconds the spotlight is up.
  if (state.spotlightUntil && Date.now() < state.spotlightUntil) return;
  state.refreshing = true;
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
    // Whatever is already on screen stays there: a failed read shows nothing new, it
    // does not erase what was last known to be true.
  } finally {
    state.refreshing = false;
  }
  // Outside the guard, so a wallet that has just been unlocked is picked up on the very
  // next poll without anybody having to reload the page or click anything.
  if (!state.actor && injected()) await trySilentConnect();
}

async function readChain() {
  const { DIDRegistry, RoleManager, AssetNFT, AuditTrail } = state.read;

  const dids = await DIDRegistry.allDids(0, 200);
  state.identities = await Promise.all(
    dids.map(async (didHash) => {
      const [id, roles] = await Promise.all([
        DIDRegistry.resolve(didHash),
        RoleManager.rolesOfDid(didHash),
      ]);
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
  const ids = Array.from({ length: total }, (_, i) => i + 1);
  state.assets = await Promise.all(
    ids.map(async (id) => {
      const [a, owner] = await Promise.all([AssetNFT.assetOf(id), ownerOrBurned(AssetNFT, id)]);
      return {
        id,
        owner,
        issuerDid: a.issuerDid,
        currentDid: a.currentDid,
        originDid: a.originDid,
        category: a.category,
        soulbound: a.soulbound,
        frozen: a.frozen,
        revoked: a.revoked,
        uri: owner ? await AssetNFT.tokenURI(id) : "",
      };
    })
  );

  if (state.actor && injected()) state.wrongChain = !(await onPlatformChain());
  state.perms = state.actor ? await RoleManager.permissionsOf(state.actor) : 0n;
  state.balance = state.actor ? await state.provider.getBalance(state.actor) : 0n;
  if (state.request && state.identities.some((i) => sameAddr(i.controller, state.actor))) {
    state.request = null; // an administrator approved it
  }
  const count = Number(await AuditTrail.entryCount());
  const entries = await AuditTrail.getEntries(count > 300 ? count - 300 : 0, 300);

  await readBlocks(entries);

  renderMe();
  renderMismatch();
  renderGas();
  renderBlocks();
  renderOnboarding();
  renderIdentities();
  renderAssets();
  renderAudit(entries, count);
  gate();
}

const can = (name) => {
  const bit = PERM[name];
  if (bit === undefined) {
    console.warn('unknown permission gate: ' + name);
    return false;
  }
  return (state.perms & bit) === bit;
};
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
    let allowed = owned || can(need);
    let why = allowed ? "" : `requires ${need}`;
    if (allowed && b.hasAttribute("data-needs-role")) {
      const pick = b.closest(".actions")?.querySelector(".role-pick");
      if (pick && !pick.value) {
        allowed = false;
        why = "choose a role first";
      }
    }
    b.disabled = !allowed;
    b.title = why;
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

function renderMismatch() {
  const bar = $("#mismatch");
  // The wallet's chain is worth saying even before anyone connects: a MetaMask left on a
  // dead practice network is exactly when the reader most needs to be told, because every
  // button is disabled and nothing on the page explains why.
  const elsewhere = state.actor
    ? state.wrongChain
    : state.walletChain != null && state.walletChain !== Number(state.cfg.chainId);
  if (!injected() || !elsewhere) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.innerHTML = `<span>MetaMask is on a different network, so nothing here can be signed.
    This page is showing <b>${esc(state.cfg.network)}</b>.</span>
    <button class="small" id="do-switch">Switch MetaMask to ${esc(state.cfg.network)}</button>`;
  $("#do-switch").onclick = async () => {
    await ensureChain();
    renderMismatch();
    await refresh();
  };
}

/** Says so before the wallet does, and offers the three ways out of it. */
function renderGas() {
  const bar = $("#lowgas");
  const faucets = FAUCETS[Number(state.cfg.chainId)];
  if (!state.actor || !faucets || state.balance >= LOW_GAS) {
    bar.hidden = true;
    return;
  }
  const empty = state.balance === 0n;
  bar.innerHTML =
    `<span>${
      empty
        ? "You have no test ETH"
        : `You are down to ${esc(Number(ethers.formatEther(state.balance)).toFixed(5))} ETH`
    }, so the next transaction you sign will fail. Topping up is free, and this is not real money.</span>
     <span class="links">${faucets
       .map(([name, url]) => `<a class="btn ghost small" href="${url}" target="_blank" rel="noopener">${name}</a>`)
       .join("")}
     <button class="small ghost" id="gas-copy">Copy my address</button></span>`;
  bar.hidden = false;
  $("#gas-copy").onclick = () => copyText(state.actor, $("#gas-copy"), "Copied");
}

function renderWallet() {
  const btn = $("#connect");
  const tag = $("#wallet-label");

  if (!state.actor) {
    // "Locked" and "not connected" need different things from the reader - a password in
    // one case, a click in the other - so they must not look the same.
    tag.textContent = !injected()
      ? "MetaMask not detected"
      : state.walletLocked
        ? "MetaMask is locked"
        : "not connected";
    tag.className = state.walletLocked ? "pill pill-wait" : "pill pill-muted";
    btn.textContent = state.walletLocked ? "Unlock MetaMask" : "Connect MetaMask";
    btn.title = state.walletLocked
      ? "your wallet is still authorised - it just needs your password"
      : "";
    btn.onclick = connect;
    btn.disabled = false;
    return;
  }
  btn.title = "";

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
  $("#me-gas").textContent = state.actor ? Number(ethers.formatEther(state.balance)).toFixed(5) : "–";
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

  // Getting an identity is the only step that matters, and it does not require funds:
  // the free route is the default, with self-funding offered as the alternative.
  const registered = !!me && !me.revoked;
  steps.push({
    done: registered,
    what: "Get your identity",
    why: registered
      ? "Done - you hold a decentralised identifier on the blockchain. An administrator can now grant you a role."
      : state.request
        ? "Signed. Send this code to an administrator - they submit it and pay. Nothing was spent, and nobody can alter it without invalidating your signature."
        : local
          ? "Creates your DID on-chain."
          : "You do not need any ETH for this. Sign a request and an administrator submits it for you.",
    action: registered
      ? ""
      : state.request
        ? `<div class="request-code" id="request-code">${state.request}</div>
           <div class="row"><button class="small" id="copy-request">Copy code</button>
           <span class="why">waiting for an administrator to approve it</span></div>`
        : state.actor
          ? `<label class="named"><span>Your name, as it should appear in your DID document</span>
               <input id="request-name" placeholder="e.g. r-kumar" value="${esc(state.requestName ?? "")}" /></label>
             <button class="small" id="onboard-sign">Sign a request &mdash; free, no ETH</button>
             ${
               funded
                 ? `<button class="small ghost" id="onboard-register">Or register it myself</button>`
                 : `<span class="why">or fund yourself to do it directly</span>`
             }
             ${
               local || funded
                 ? ""
                 : `<div class="alt">Acting for yourself later - minting, freezing, transferring - does need
                    a little test ETH. It is free and not real money.
                    <div class="row" style="margin-top:6px">
                      <button class="small ghost" id="copy-address">Copy my address</button>
                      <a class="btn ghost" href="https://cloud.google.com/application/web3/faucet/ethereum/sepolia" target="_blank" rel="noopener">Open the faucet</a>
                    </div></div>`
             }`
          : "",
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
  const nameInput = $("#request-name");
  if (nameInput) {
    nameInput.oninput = () => {
      state.requestName = nameInput.value;
    };
    if (document.activeElement !== nameInput && state.requestName) nameInput.value = state.requestName;
  }
  const sg = $("#onboard-sign");
  if (sg) sg.onclick = signIdentityRequest;

  const cp = $("#copy-request");
  if (cp) cp.onclick = () => copyText(state.request, cp, "Copied");
  const ca = $("#copy-address");
  if (ca) ca.onclick = () => copyText(state.actor, ca, "Copied");
}

function previewRequest() {
  const el = $("#approve-preview");
  const raw = $("#approve-code").value.trim();
  if (!raw) {
    el.textContent = "They sign; you submit and pay the gas.";
    return;
  }
  try {
    const r = decodeRequest(raw);
    const expired = r.deadline * 1000 < Date.now();
    const claimed = r.docURI.split("/").pop();
    el.textContent = wrongChainRequest(r)
      ? `Signed for chain ${r.chainId}, but this page is ${state.cfg.network}. Ask them to sign again on the right network.`
      : expired
        ? `Request from ${short(r.subject)} has expired - ask them to sign a fresh one`
        : `"${claimed}" at ${short(r.subject)} - they signed this name themselves; you cannot change it`;
  } catch {
    el.textContent = "Not a valid request code";
  }
}

function renderIdentities() {
  $("#approve-form").hidden = !can("REGISTER_IDENTITY");
  const box = $("#identities");
  const target = $("#mint-to");
  const active = state.identities.filter((i) => !i.revoked);
  const keep = target.value;
  target.innerHTML = active
    .map((i) => `<option value="${esc(i.didHash)}">${esc(label(i.controller))} - ${esc(shortDid(i.didHash))}</option>`)
    .join("");
  if (keep && active.some((i) => i.didHash === keep)) target.value = keep;

  // Someone who has registered but holds no role is a new joiner waiting to be given
  // access. That is on-chain fact, not a guess, and it is the first thing an
  // administrator should see when they open the platform.
  const awaiting = state.identities.filter((i) => !i.revoked && i.roles.length === 0);
  const badge = $("#pending-count");
  badge.hidden = awaiting.length === 0;
  badge.textContent = `${awaiting.length} awaiting access`;
  badge.className = awaiting.length ? "pill pill-wait" : "pill pill-muted";

  const ordered = [...awaiting, ...state.identities.filter((i) => !awaiting.includes(i))];

  box.innerHTML = state.identities.length ? "" : `<div class="empty">No identities yet.</div>`;
  for (const i of ordered) {
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div class="head">
        <span class="title">${esc(
          label(i.controller) === short(i.controller) ? i.docURI.split("/").pop() : label(i.controller)
        )}${sameAddr(i.controller, state.actor) ? " (you)" : ""}</span>
        ${i.revoked ? `<span class="pill pill-bad">revoked</span>` : `<span class="pill pill-good">active</span>`}
      </div>
      <div class="sub mono">${esc(i.didHash)} ${helpBtn("did")}</div>
      <div class="sub mono">key ${esc(i.controller)} ${helpBtn("key")} &middot; ${esc(i.docURI)} ${helpBtn("docuri")}</div>
      <div class="chips">
        ${
          i.roles.map((r) => `<span class="chip role">${ROLE_NAME[r] ?? shortDid(r)}</span>`).join("") ||
          (i.revoked
            ? `<span class="chip">no roles</span>`
            : `<span class="chip wait">awaiting access &mdash; registered, no permissions yet</span>`)
        }
      </div>
      <div class="actions">
        <select class="role-pick"><option value="">Choose a role…</option>${ROLE_LIST.map(
          (r) => `<option value="${ROLE_ID[r]}">${r}</option>`
        ).join("")}</select>${helpBtn("rolepick")}
        <button class="small grant" data-perm="MANAGE_ROLES" data-needs-role>Grant</button>${helpBtn("grant")}
        <button class="small ghost revoke-role" data-perm="MANAGE_ROLES" data-needs-role>Revoke role</button>${helpBtn("revokerole")}
        <button class="small danger revoke-id" data-perm="REVOKE_IDENTITY" data-owner="${i.controller}">Revoke identity</button>${helpBtn("revokeid")}
      </div>`;

    const role = () => el.querySelector(".role-pick").value;
    // Nothing is preselected, so a row never reads as though this person already holds
    // whichever role happened to sit at the top of the list. The two buttons stay
    // disabled until a role is actually chosen.
    el.querySelector(".role-pick").onchange = gate;
    el.querySelector(".grant").onclick = async () => {
      const who = label(i.controller) === short(i.controller) ? i.docURI.split("/").pop() : label(i.controller);
      // Admin is the one grant that cannot be quietly undone, so it is confirmed by name.
      if (role() === ROLE_ID.ADMIN) {
        const ok = await confirmAction({
          title: `Make ${who} an administrator?`,
          body: "Admin carries every permission on the platform: issuing and destroying assets, revoking identities, and granting roles to anyone including further administrators.",
          consequence: "Only another administrator can take this back, and the last administrator can never be removed at all.",
          confirmLabel: "Grant Admin",
        });
        if (!ok) return;
      }
      send("Grant role", async () => (await writer("RoleManager")).grantRole(i.didHash, role(), 0));
    };
    el.querySelector(".revoke-role").onclick = () =>
      send("Revoke role", async () => (await writer("RoleManager")).revokeRole(i.didHash, role()));
    el.querySelector(".revoke-id").onclick = async () => {
      const who = label(i.controller) === short(i.controller) ? i.docURI.split("/").pop() : label(i.controller);
      const roles = i.roles.map((r) => ROLE_NAME[r] ?? shortDid(r)).join(", ") || "no roles";
      const ok = await confirmAction({
        title: `Revoke ${who}'s identity?`,
        body: `They currently hold: ${roles}. Revoking the identity removes every one of them at once, and any assets they hold stop being transferable.`,
        consequence: "This cannot be undone. The same wallet can never register again. To remove a single permission, use Revoke role instead.",
        confirmLabel: "Revoke identity",
      });
      if (ok) send("Revoke identity", async () => (await writer("DIDRegistry")).revoke(i.didHash));
    };
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
        <span class="title">#${a.id} &middot; ${esc(a.category)}</span>
        <div class="chips">
          ${a.revoked ? `<span class="chip frozen">revoked</span>` : ""}
          ${a.soulbound ? `<span class="chip sb">soulbound</span>` : ""}
          ${a.frozen ? `<span class="chip frozen">frozen</span>` : ""}
          ${mine ? `<span class="chip role">yours</span>` : ""}
        </div>
      </div>
      <div class="sub mono">${esc(a.uri)}</div>
      <div class="sub mono">issued by ${esc(
        state.identities.find((i) => i.didHash === a.issuerDid)
          ? label(state.identities.find((i) => i.didHash === a.issuerDid).controller)
          : shortDid(a.issuerDid)
      )}</div>
      <div class="sub mono">held by ${esc(label(a.owner))} &middot; DID ${esc(shortDid(a.currentDid))}${
        a.currentDid !== a.originDid ? ` &middot; issued to ${esc(shortDid(a.originDid))}` : ""
      }</div>
      <div class="actions">
        <select class="to">${state.identities
          .filter((i) => !i.revoked && i.didHash !== a.currentDid)
          .map((i) => `<option value="${esc(i.controller)}">to ${esc(label(i.controller))}</option>`)
          .join("")}</select>
        <button class="small move" data-perm="TRANSFER_ASSET" data-owner="${a.owner}">Transfer</button>${helpBtn("transfer")}
        <button class="small ghost freeze" data-perm="FREEZE_ASSET">${a.frozen ? "Unfreeze" : "Freeze"}</button>${helpBtn("freeze")}
        <button class="small danger revoke-asset" data-perm="REVOKE_ASSET">${a.revoked ? "Reinstate" : "Revoke"}</button>${helpBtn("revokeasset")}
        <button class="small danger burn" data-perm="BURN_ASSET">Burn</button>${helpBtn("burn")}
        <label class="filebtn" title="Check a file against the hash recorded at issuance">
          Verify a file<input type="file" class="verify-file" hidden />
        </label>${helpBtn("verifyfile")}
        <input class="verify" placeholder="or a typed reference" />
        <button class="small ghost check">Check</button>
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
    el.querySelector(".revoke-asset").onclick = () =>
      send(a.revoked ? "Reinstate" : "Revoke", async () => {
        const nft = await writer("AssetNFT");
        return a.revoked ? nft.reinstateAsset(a.id) : nft.revokeAsset(a.id, "rescinded by issuer");
      });
    el.querySelector(".burn").onclick = async () => {
      const ok = await confirmAction({
        title: `Burn asset #${a.id}?`,
        body: `This destroys the ${a.category} entirely. Verification will report it as unknown rather than revoked, so nobody can later prove it ever existed.`,
        consequence: "This cannot be undone. For a credential that should stop being valid while keeping its record, use Revoke instead.",
        confirmLabel: "Burn permanently",
      });
      if (ok) send("Burn", async () => (await writer("AssetNFT")).burn(a.id));
    };
    const verifyFile = el.querySelector(".verify-file");
    verifyFile.onchange = async () => {
      const file = verifyFile.files[0];
      if (!file) return;
      const hash = await hashFile(file);
      const [status, matches, issuerDid] = await state.read.AssetNFT.verify(a.id, hash);
      const issuer = state.identities.find((i) => i.didHash === issuerDid);
      const issuedBy = issuer ? label(issuer.controller) : shortDid(issuerDid);

      let title, kind;
      if (Number(status) === 0) [title, kind] = [`Asset #${a.id} does not exist`, "err"];
      else if (!matches) [title, kind] = [`ALTERED — this file is not what was issued`, "err"];
      else if (Number(status) === 2) [title, kind] = [`REVOKED — issued by ${issuedBy}, since rescinded`, "err"];
      else [title, kind] = [`AUTHENTIC — issued by ${issuedBy}`, "ok"];

      toast(title, `${file.name} · ${prettyBytes(file.size)} · ${hash.slice(0, 22)}…`, kind);
      verifyFile.value = "";
    };

    el.querySelector(".check").onclick = async () => {
      const src = el.querySelector(".verify").value;
      if (!src) return toast(`Asset #${a.id}`, "choose a file above, or type a reference", "err");
      const match = await state.read.AssetNFT.verifyAuthenticity(a.id, ethers.id(src));
      toast(`Asset #${a.id}`, match ? `"${src}" matches the issued hash` : `"${src}" does not match`, match ? "ok" : "err");
    };
    box.append(el);
  }
}

const BLOCKS_SHOWN = 6;
const recentBlockNumbers = () => [...state.chain.blocks.keys()].sort((a, b) => b - a).slice(0, BLOCKS_SHOWN);

/**
 * Everything else on this page is the platform's own account of itself. This is the chain
 * underneath it: the blocks those transactions actually landed in, each one carrying the
 * hash of the block before it. That linkage is the whole argument for putting an audit
 * trail here rather than in a database - edit an old entry and every hash after it stops
 * matching, so the tampering is not hidden, it is arithmetic.
 *
 * Which blocks hold platform activity is already known, because every audit entry records
 * its own block number on-chain. Only the block headers need fetching, and a mined block
 * never changes, so each one is fetched once and kept.
 */
async function readBlocks(entries) {
  const c = state.chain;
  try {
    c.head = await state.provider.getBlockNumber();
    c.blocks = new Map();
    for (const e of entries) {
      const n = Number(e.blockNumber);
      if (!c.blocks.has(n)) c.blocks.set(n, []);
      c.blocks.get(n).push(ACTION_NAME[e.action] ?? shortDid(e.action));
    }
    for (const n of recentBlockNumbers()) {
      if (c.headers.has(n)) continue;
      const b = await state.provider.getBlock(n);
      if (b) c.headers.set(n, { hash: b.hash, parentHash: b.parentHash, time: Number(b.timestamp) });
    }
    c.failed = false;
  } catch {
    // A rate-limited endpoint must not take the rest of the page down with it: the
    // identities, assets and audit trail above have already been read successfully.
    c.failed = true;
  }
}

function renderBlocks() {
  const c = state.chain;
  const head = $("#chain-head");
  head.textContent = c.head ? `network is at block ${c.head.toLocaleString()}` : "reading…";
  head.className = c.failed ? "pill pill-muted" : "pill pill-good";

  $("#chain-node").innerHTML = `Read live from a node at <span class="mono">${esc(state.rpcUrl)}</span>.
    Every block names the hash of the block before it, so changing anything in an old block
    changes its hash, and every block after it stops pointing anywhere real.`;

  const box = $("#blocks");
  const numbers = recentBlockNumbers();
  if (!numbers.length) {
    box.innerHTML = `<div class="empty">Nothing from this platform is on the chain yet.</div>`;
    return;
  }

  box.innerHTML = "";
  numbers.forEach((n, idx) => {
    const h = c.headers.get(n);
    const el = document.createElement("div");
    el.className = "block";
    const title = `Block ${n.toLocaleString()}`;
    el.innerHTML = `
      <div class="block-head">
        <span class="num">${
          state.cfg.explorer
            ? `<a href="${esc(state.cfg.explorer)}/block/${n}" target="_blank" rel="noopener">${title}</a>`
            : title
        }</span>
        <span class="when">${h ? new Date(h.time * 1000).toLocaleString() : "…"}</span>
      </div>
      <div class="hashes">
        <div><span class="k">this block's hash</span><span class="v mono">${h ? esc(h.hash) : "…"}</span></div>
        <div><span class="k">the block before</span><span class="v mono prev">${h ? esc(h.parentHash) : "…"}</span></div>
      </div>
      <div class="chips">${(c.blocks.get(n) ?? [])
        .map((a) => `<span class="chip role">${esc(a)}</span>`)
        .join("")}</div>`;
    box.append(el);

    const older = numbers[idx + 1];
    if (older !== undefined) {
      const gap = n - older - 1;
      const sep = document.createElement("div");
      sep.className = "block-gap";
      sep.textContent =
        gap === 0
          ? "directly on top - the \"block before\" above is the block hash below"
          : `${gap.toLocaleString()} block${gap === 1 ? "" : "s"} of other people's transactions in between`;
      box.append(sep);
    }
  });

  if (state.cfg.deployedAtBlock) {
    const root = document.createElement("div");
    root.className = "block-gap root";
    root.textContent = `…back to block ${Number(state.cfg.deployedAtBlock).toLocaleString()}, where this platform was deployed`;
    box.append(root);
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
    tr.innerHTML = `<td>${i}</td><td class="action">${esc(ACTION_NAME[e.action] ?? shortDid(e.action))}</td>
      <td>${esc(label(e.actor))}</td><td>${esc(subject)}</td><td>${e.blockNumber}</td>
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

async function mint(ev) {
  ev.preventDefault();
  const didHash = $("#mint-to").value;
  const uri = $("#mint-uri").value.trim();
  const category = $("#mint-category").value.trim();
  const soulbound = $("#mint-soulbound").checked;

  // A chosen file wins over the typed label: only a hash of real bytes can later prove
  // that a document was not altered.
  const file = $("#mint-file").files[0];
  let assetHash;
  if (file) {
    assetHash = await hashFile(file);
  } else {
    const typed = $("#mint-source").value.trim();
    if (!typed) return toast("Mint asset", "choose a file, or type a source reference", "err");
    assetHash = ethers.id(typed);
  }

  return send("Mint asset", async () =>
    (await writer("AssetNFT")).mintToDid(didHash, uri, assetHash, category, soulbound)
  );
}

/** Show the issuer what will be committed before they commit it. */
async function previewMintFile() {
  const file = $("#mint-file").files[0];
  const out = $("#mint-file-hash");
  if (!file) {
    out.textContent = "";
    return;
  }
  out.textContent = `${file.name} · ${prettyBytes(file.size)} · ${(await hashFile(file)).slice(0, 22)}…`;
}

boot().catch((e) => {
  // A blank page tells the reader nothing. Any unexpected failure during startup is
  // reported in place instead.
  const msg = e?.shortMessage ?? e?.message ?? String(e);
  try {
    fatal(`The page failed to start: ${msg}`);
  } catch {
    document.body.textContent = `TrustChain failed to start: ${msg}`;
  }
});

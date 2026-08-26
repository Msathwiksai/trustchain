// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IDIDRegistry, IRoleManager, IAuditTrail} from "./interfaces/IPlatform.sol";
import {Perm, Actions} from "./libraries/Permissions.sol";

/**
 * @title AssetNFT
 * @notice One NFT per asset, allocated to a decentralised identity rather than to a bare
 *         address. Every token records the identity it was issued to (`originDid`), the
 *         identity that holds it now (`currentDid`), and a hash of the underlying asset
 *         so authenticity can be checked against the off-chain document or serial number.
 *
 *         Rules the contract enforces on every path, including `safeTransferFrom`:
 *           - only MINT_ASSET may create a token, and only for an active identity;
 *           - a token can never land on an address without an active identity;
 *           - frozen tokens do not move; soulbound tokens never move at all;
 *           - a custodial move by a Manager needs TRANSFER_ASSET and is logged as such.
 */
contract AssetNFT is ERC721, ERC721Enumerable, ERC721URIStorage, ReentrancyGuard {
    struct Asset {
        bytes32 issuerDid; // identity that issued it - the college, the registrar, the employer
        bytes32 originDid; // identity the asset was first allocated to
        bytes32 currentDid; // identity holding it now
        bytes32 assetHash; // keccak256 of the underlying document / serial / file
        uint64 mintedAt;
        bool soulbound; // credentials and licences: bound to the identity forever
        bool frozen; // temporarily immobilised, e.g. during a dispute
        bool revoked; // rescinded by its issuer; the record survives, the claim does not
        string category;
    }

    /// @notice What a verifier needs to know in one word.
    enum Status {
        Unknown, // never issued, or destroyed
        Valid,
        Revoked
    }

    IDIDRegistry public immutable didRegistry;
    IRoleManager public immutable roleManager;
    IAuditTrail public immutable auditTrail;

    uint256 private _nextTokenId = 1;
    mapping(uint256 => Asset) private _assets;

    event AssetMinted(
        uint256 indexed tokenId,
        bytes32 indexed didHash,
        address indexed to,
        bytes32 assetHash,
        string category,
        bool soulbound
    );
    event AssetTransferred(
        uint256 indexed tokenId, bytes32 indexed fromDid, bytes32 indexed toDid, address by, bool custodial
    );
    event AssetFrozenSet(uint256 indexed tokenId, bool frozen, address by);
    event AssetBurned(uint256 indexed tokenId, bytes32 indexed didHash, address by);
    event AssetRevoked(uint256 indexed tokenId, bytes32 indexed issuerDid, address by, string reason);
    event AssetReinstated(uint256 indexed tokenId, address by);

    error NotAuthorized();
    error InactiveIdentity();
    error RecipientHasNoIdentity();
    error AssetIsFrozen();
    error AssetIsSoulbound();
    error UnknownAsset();
    error ZeroAddress();
    error AssetIsRevoked();
    error NotRevoked();

    constructor(
        string memory name_,
        string memory symbol_,
        address didRegistry_,
        address roleManager_,
        address auditTrail_
    ) ERC721(name_, symbol_) {
        if (didRegistry_ == address(0) || roleManager_ == address(0) || auditTrail_ == address(0)) {
            revert ZeroAddress();
        }
        didRegistry = IDIDRegistry(didRegistry_);
        roleManager = IRoleManager(roleManager_);
        auditTrail = IAuditTrail(auditTrail_);
    }

    // ------------------------------------------------------------------------ mint

    /// @notice Mint an asset directly to an identity. Only MINT_ASSET holders.
    function mintToDid(
        bytes32 didHash,
        string calldata uri,
        bytes32 assetHash,
        string calldata category,
        bool soulbound
    ) public nonReentrant returns (uint256 tokenId) {
        if (!roleManager.hasPermission(msg.sender, Perm.MINT_ASSET)) revert NotAuthorized();
        address owner = didRegistry.controllerOf(didHash);
        if (owner == address(0)) revert InactiveIdentity();

        tokenId = _nextTokenId++;
        _assets[tokenId] = Asset({
            // Whoever authorised the mint is the issuer, and a verifier can check that
            // against the organisation they actually trust.
            issuerDid: didRegistry.didOf(msg.sender),
            originDid: didHash,
            currentDid: didHash,
            assetHash: assetHash,
            mintedAt: uint64(block.timestamp),
            soulbound: soulbound,
            frozen: false,
            revoked: false,
            category: category
        });

        // The URI, the event and the audit entry are all written before `_safeMint`, whose
        // ERC-721 receiver callback hands control to the recipient. A contract recipient
        // therefore observes a finished asset, never a half-built one.
        _setTokenURI(tokenId, uri);
        emit AssetMinted(tokenId, didHash, owner, assetHash, category, soulbound);
        auditTrail.record(
            msg.sender, Actions.ASSET_MINTED, bytes32(tokenId), keccak256(abi.encode(didHash, assetHash, uri))
        );

        _safeMint(owner, tokenId);
    }

    /// @notice Convenience wrapper - resolves the recipient's DID first.
    function mintTo(
        address to,
        string calldata uri,
        bytes32 assetHash,
        string calldata category,
        bool soulbound
    ) external returns (uint256) {
        bytes32 didHash = didRegistry.didOf(to);
        if (didHash == bytes32(0)) revert RecipientHasNoIdentity();
        return mintToDid(didHash, uri, assetHash, category, soulbound);
    }

    // -------------------------------------------------------------------- lifecycle

    /**
     * @notice Move an asset without the holder's key - a compliance action, not a
     *         convenience. Requires TRANSFER_ASSET and is written to the audit trail
     *         flagged as custodial.
     */
    function custodialTransfer(address from, address to, uint256 tokenId) external nonReentrant {
        if (!roleManager.hasPermission(msg.sender, Perm.TRANSFER_ASSET)) revert NotAuthorized();
        if (to == address(0)) revert ZeroAddress();
        if (_ownerOf(tokenId) != from) revert NotAuthorized();
        _custodial = true;
        _update(to, tokenId, address(0)); // address(0) auth: skips the owner/approval check
        _custodial = false;
    }

    /**
     * @notice Pull an asset onto the key that now controls its identity. After
     *         `DIDRegistry.acceptController` the DID owns the asset but the old key still
     *         appears as the ERC-721 holder; this realigns the two without a transfer from
     *         the retired key. The owning identity does not change, so soulbound and
     *         frozen assets can be claimed too.
     */
    function claimByIdentity(uint256 tokenId) external nonReentrant {
        Asset storage a = _assets[tokenId];
        if (a.mintedAt == 0) revert UnknownAsset();
        if (didRegistry.controllerOf(a.currentDid) != msg.sender) revert NotAuthorized();
        if (_ownerOf(tokenId) == msg.sender) revert NotAuthorized();
        _update(msg.sender, tokenId, address(0));
    }

    function setFrozen(uint256 tokenId, bool frozen) external {
        if (!roleManager.hasPermission(msg.sender, Perm.FREEZE_ASSET)) revert NotAuthorized();
        if (_ownerOf(tokenId) == address(0)) revert UnknownAsset();
        _assets[tokenId].frozen = frozen;

        emit AssetFrozenSet(tokenId, frozen, msg.sender);
        auditTrail.record(
            msg.sender, frozen ? Actions.ASSET_FROZEN : Actions.ASSET_UNFROZEN, bytes32(tokenId), bytes32(0)
        );
    }

    /**
     * @notice Rescind a credential without erasing it. A degree that was withdrawn, a licence
     *         that lapsed, a pass that was cancelled: the record must survive so the history
     *         stays honest, but it must stop verifying as valid.
     */
    function revokeAsset(uint256 tokenId, string calldata reason) external {
        Asset storage a = _assets[tokenId];
        if (a.mintedAt == 0 || _ownerOf(tokenId) == address(0)) revert UnknownAsset();
        if (a.revoked) revert AssetIsRevoked();
        // The issuing organisation, or anyone the platform has trusted with REVOKE_ASSET.
        if (
            didRegistry.didOf(msg.sender) != a.issuerDid
                && !roleManager.hasPermission(msg.sender, Perm.REVOKE_ASSET)
        ) revert NotAuthorized();

        a.revoked = true;
        emit AssetRevoked(tokenId, a.issuerDid, msg.sender, reason);
        auditTrail.record(msg.sender, Actions.ASSET_REVOKED, bytes32(tokenId), keccak256(bytes(reason)));
    }

    /// @notice Undo a revocation made in error. Also permanent in the record.
    function reinstateAsset(uint256 tokenId) external {
        Asset storage a = _assets[tokenId];
        if (a.mintedAt == 0 || _ownerOf(tokenId) == address(0)) revert UnknownAsset();
        if (!a.revoked) revert NotRevoked();
        if (
            didRegistry.didOf(msg.sender) != a.issuerDid
                && !roleManager.hasPermission(msg.sender, Perm.REVOKE_ASSET)
        ) revert NotAuthorized();

        a.revoked = false;
        emit AssetReinstated(tokenId, msg.sender);
        auditTrail.record(msg.sender, Actions.ASSET_REINSTATED, bytes32(tokenId), bytes32(0));
    }

    function burn(uint256 tokenId) external nonReentrant {
        if (!roleManager.hasPermission(msg.sender, Perm.BURN_ASSET)) revert NotAuthorized();
        bytes32 didHash = _assets[tokenId].currentDid;
        if (_ownerOf(tokenId) == address(0)) revert UnknownAsset();

        _burn(tokenId);
        emit AssetBurned(tokenId, didHash, msg.sender);
        auditTrail.record(msg.sender, Actions.ASSET_BURNED, bytes32(tokenId), didHash);
    }

    // ------------------------------------------------------------------ enforcement

    /**
     * @dev Every transfer path in ERC-721 - including both `safeTransferFrom` overloads -
     *      funnels through `transferFrom`, so guarding it alone stops a receiver callback
     *      re-entering mid-transfer. Guarding `safeTransferFrom` as well would trip the
     *      guard on its own internal call.
     */
    function transferFrom(address from, address to, uint256 tokenId)
        public
        override(ERC721, IERC721)
        nonReentrant
    {
        super.transferFrom(from, to, tokenId);
    }

    /// @dev Set only for the duration of a custodial move, which cannot be re-entered.
    bool private _custodial;

    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721, ERC721Enumerable)
        returns (address from)
    {
        from = super._update(to, tokenId, auth);

        // Mint and burn are gated by their own entry points; only movements are checked here.
        if (from != address(0) && to != address(0)) {
            Asset storage a = _assets[tokenId];

            bytes32 toDid = didRegistry.didOf(to);
            if (toDid == bytes32(0) || !didRegistry.isDidActive(toDid)) revert RecipientHasNoIdentity();

            // A move to a different key of the same identity is a key migration, not a
            // change of ownership, so the transfer restrictions do not apply to it.
            if (toDid != a.currentDid) {
                if (a.soulbound) revert AssetIsSoulbound();
                if (a.frozen) revert AssetIsFrozen();
                if (a.revoked) revert AssetIsRevoked();
            }

            bytes32 fromDid = a.currentDid;
            a.currentDid = toDid;

            emit AssetTransferred(tokenId, fromDid, toDid, msg.sender, _custodial);
            auditTrail.record(
                msg.sender,
                Actions.ASSET_TRANSFERRED,
                bytes32(tokenId),
                keccak256(abi.encode(fromDid, toDid, _custodial))
            );
        }
    }

    // ---------------------------------------------------------------- introspection

    function assetOf(uint256 tokenId) external view returns (Asset memory) {
        if (_assets[tokenId].mintedAt == 0) revert UnknownAsset();
        return _assets[tokenId];
    }

    /**
     * @notice Everything a verifier needs, in one call: was it issued by whom, is it still
     *         valid, does the file in front of me match, and who holds it now.
     * @param candidateHash keccak256 of the file being checked
     */
    function verify(uint256 tokenId, bytes32 candidateHash)
        external
        view
        returns (Status status, bool hashMatches, bytes32 issuerDid, bytes32 ownerDid)
    {
        Asset storage a = _assets[tokenId];
        if (a.mintedAt == 0 || _ownerOf(tokenId) == address(0)) {
            return (Status.Unknown, false, bytes32(0), bytes32(0));
        }
        return (
            a.revoked ? Status.Revoked : Status.Valid,
            a.assetHash == candidateHash,
            a.issuerDid,
            a.currentDid
        );
    }

    /// @notice True if `didHash` issued this asset - the check a verifier makes against the
    ///         organisation they actually trust.
    function wasIssuedBy(uint256 tokenId, bytes32 didHash) external view returns (bool) {
        return _assets[tokenId].mintedAt != 0 && _assets[tokenId].issuerDid == didHash;
    }

    /// @notice Check an artefact against the hash recorded at issuance. A burned asset has
    ///         no authenticity to verify - the record survives, the claim does not.
    function verifyAuthenticity(uint256 tokenId, bytes32 candidateHash) external view returns (bool) {
        if (_assets[tokenId].mintedAt == 0 || _ownerOf(tokenId) == address(0)) revert UnknownAsset();
        // A revoked credential must never come back "authentic" from any code path.
        if (_assets[tokenId].revoked) revert AssetIsRevoked();
        return _assets[tokenId].assetHash == candidateHash;
    }

    /// @notice True if `tokenId` is currently owned by the identity `didHash`.
    function isOwnedByDid(uint256 tokenId, bytes32 didHash) external view returns (bool) {
        return _ownerOf(tokenId) != address(0) && _assets[tokenId].currentDid == didHash;
    }

    function tokensOfOwner(address owner) external view returns (uint256[] memory ids) {
        uint256 n = balanceOf(owner);
        ids = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            ids[i] = tokenOfOwnerByIndex(owner, i);
        }
    }

    function totalMinted() external view returns (uint256) {
        return _nextTokenId - 1;
    }

    // ----------------------------------------------------------- required overrides

    function _increaseBalance(address account, uint128 value)
        internal
        override(ERC721, ERC721Enumerable)
    {
        super._increaseBalance(account, value);
    }

    function tokenURI(uint256 tokenId)
        public
        view
        override(ERC721, ERC721URIStorage)
        returns (string memory)
    {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC721Enumerable, ERC721URIStorage)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}

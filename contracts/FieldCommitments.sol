// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

import {IDIDRegistry} from "./interfaces/IPlatform.sol";

interface IAssetSource {
    struct Asset {
        bytes32 issuerDid;
        bytes32 originDid;
        bytes32 currentDid;
        bytes32 assetHash;
        uint64 mintedAt;
        bool soulbound;
        bool frozen;
        bool revoked;
        string category;
    }

    function assetOf(uint256 tokenId) external view returns (Asset memory);
}

/**
 * @title FieldCommitments
 * @notice Selective disclosure for issued credentials.
 *
 *         Hashing a whole certificate proves it was not altered, but proving anything
 *         then requires handing over the entire document. A graduate asked only whether
 *         they hold a degree must also surrender their marks, their roll number and their
 *         date of birth, because the proof is the file itself.
 *
 *         Here the issuer additionally commits a Merkle root over the certificate's
 *         individual fields. Each leaf is one field, salted:
 *
 *             leaf = keccak256(abi.encode(label, value, salt))
 *
 *         The holder can later reveal one field and its proof. Anyone can check that the
 *         field belongs to that credential, and learns nothing else: the sibling hashes in
 *         the proof are hashes, and the salt makes guessing a value useless - "cgpa" with
 *         every plausible number attached still will not reproduce a leaf without its
 *         64 bits of salt.
 *
 *         Deployed alongside the platform rather than inside AssetNFT, so credentials
 *         already issued can be given fields without redeploying anything or disturbing
 *         a single existing record.
 *
 *         It keeps its own record rather than writing to the platform's audit trail,
 *         because it cannot: the writer set was frozen at deployment and no contract
 *         written afterwards can ever append to it - including this one, by its own
 *         authors. The commitment is permanent all the same, in storage and in the event
 *         log, and the credential it belongs to is already in the audit trail.
 */
contract FieldCommitments {
    IAssetSource public immutable assets;
    IDIDRegistry public immutable didRegistry;

    struct Commitment {
        bytes32 root;
        uint16 fields; // how many leaves the tree holds, so a verifier knows what to expect
        uint64 committedAt;
        bytes32 byDid;
    }

    mapping(uint256 => Commitment) private _commitments;

    event FieldsCommitted(uint256 indexed tokenId, bytes32 indexed root, bytes32 indexed byDid, uint16 fields);

    error UnknownAsset();
    error NotTheIssuer();
    error AlreadyCommitted();
    error NothingCommitted();
    error EmptyTree();

    constructor(address assets_, address didRegistry_) {
        assets = IAssetSource(assets_);
        didRegistry = IDIDRegistry(didRegistry_);
    }

    /**
     * @notice Commit the field tree for a credential. Only the identity that issued it,
     *         and only once - a root that could be replaced would let an issuer quietly
     *         change what a certificate says after the fact, which is the whole thing
     *         this platform exists to prevent.
     */
    function commitFields(uint256 tokenId, bytes32 root, uint16 fields) external {
        IAssetSource.Asset memory a = assets.assetOf(tokenId);
        if (a.mintedAt == 0) revert UnknownAsset();
        if (root == bytes32(0) || fields == 0) revert EmptyTree();
        if (_commitments[tokenId].root != bytes32(0)) revert AlreadyCommitted();

        bytes32 me = didRegistry.didOf(msg.sender);
        if (me == bytes32(0) || me != a.issuerDid) revert NotTheIssuer();

        _commitments[tokenId] = Commitment({
            root: root,
            fields: fields,
            committedAt: uint64(block.timestamp),
            byDid: me
        });

        emit FieldsCommitted(tokenId, root, me, fields);
    }

    /**
     * @notice Check that one field belongs to a credential, revealing only that field.
     * @dev    A pure view: no wallet, no gas, no account. The verifier learns the label,
     *         the value and the salt of this field alone.
     */
    function verifyField(
        uint256 tokenId,
        string calldata label,
        string calldata value,
        bytes32 salt,
        bytes32[] calldata proof
    ) external view returns (bool) {
        bytes32 root = _commitments[tokenId].root;
        if (root == bytes32(0)) return false;
        return MerkleProof.verify(proof, root, leafOf(label, value, salt));
    }

    /// @notice The leaf a field hashes to. Exposed so the browser and the chain agree.
    function leafOf(string calldata label, string calldata value, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(label, value, salt));
    }

    function commitmentOf(uint256 tokenId)
        external
        view
        returns (bytes32 root, uint16 fields, uint64 committedAt, bytes32 byDid)
    {
        Commitment memory c = _commitments[tokenId];
        if (c.root == bytes32(0)) revert NothingCommitted();
        return (c.root, c.fields, c.committedAt, c.byDid);
    }

    function hasFields(uint256 tokenId) external view returns (bool) {
        return _commitments[tokenId].root != bytes32(0);
    }
}

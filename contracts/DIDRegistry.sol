// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {IDIDRegistry, IRoleManager, IAuditTrail} from "./interfaces/IPlatform.sol";
import {Perm, Actions} from "./libraries/Permissions.sol";

/**
 * @title DIDRegistry
 * @notice Self-sovereign decentralised identifiers of the form
 *         `did:tcid:<chainId>:<address>`.
 *
 *         The DID is anchored to the address that first registered it, so it survives
 *         key rotation: propose-and-accept moves control to a fresh key while the DID
 *         string - and therefore every NFT bound to it - stays the same.
 *
 *         Two authentication paths, both cryptographic:
 *           - `register`    - the subject signs the transaction itself.
 *           - `registerFor` - an operator holding REGISTER_IDENTITY pays the gas but must
 *                             present an EIP-712 signature from the subject. No admin can
 *                             conjure an identity the subject never consented to.
 */
contract DIDRegistry is IDIDRegistry, EIP712 {
    struct Identity {
        address controller;
        uint64 createdAt;
        uint64 updatedAt;
        bool revoked;
        string docURI; // IPFS/HTTPS pointer to the DID Document
    }

    bytes32 private constant REGISTER_TYPEHASH =
        keccak256("RegisterIdentity(address subject,string docURI,uint256 nonce,uint256 deadline)");

    address public governor;
    IRoleManager public roleManager;

    /// @notice Once true, the RoleManager can never be repointed. Every permission check
    ///         in the platform routes through that contract, so a governor able to swap it
    ///         is a governor able to grant themselves everything. Deployment locks it.
    bool public roleManagerLocked;
    IAuditTrail public immutable auditTrail;

    mapping(bytes32 => Identity) private _identities;
    mapping(address => bytes32) public override didOf;
    mapping(address => uint256) public nonces;

    /// @notice didHash => the key that has been offered control but has not taken it yet.
    mapping(bytes32 => address) public pendingController;

    /**
     * Social recovery. Two-step rotation saves you from a typo; it does not save you from a
     * key you no longer have. Guardians do: identities you nominate, any `threshold` of whom
     * can jointly move your DID to a new key.
     *
     * The delay is the safety valve in the other direction. Guardians reaching the threshold
     * does not move anything - it starts a clock, and until it runs out the real controller
     * can cancel with one transaction. So a quorum of guardians cannot quietly take an
     * identity away from someone who still holds their key.
     */
    struct GuardianSet {
        bytes32[] guardians;
        uint8 threshold;
        uint64 delay; // seconds between reaching the threshold and being able to execute
    }

    struct Recovery {
        address proposed;
        uint64 startedAt;
        uint8 approvals;
        uint256 round; // bumped on cancel/execute so old approvals cannot be replayed
    }

    mapping(bytes32 => GuardianSet) private _guardianSets;
    mapping(bytes32 => mapping(bytes32 => bool)) public isGuardian; // did => guardianDid
    mapping(bytes32 => Recovery) private _recoveries;
    mapping(bytes32 => mapping(uint256 => mapping(bytes32 => bool))) private _approved;

    uint256 public constant MAX_GUARDIANS = 10;

    bytes32[] private _allDids;

    event IdentityRegistered(bytes32 indexed didHash, address indexed controller, string did, string docURI);
    event DocumentUpdated(bytes32 indexed didHash, string docURI);
    event ControllerProposed(bytes32 indexed didHash, address indexed from, address indexed to);
    event ControllerProposalCancelled(bytes32 indexed didHash, address indexed was);
    event ControllerRotated(bytes32 indexed didHash, address indexed from, address indexed to);
    event IdentityRevoked(bytes32 indexed didHash, address indexed by);
    event RoleManagerUpdated(address indexed roleManager);
    event RoleManagerLocked(address indexed roleManager);
    event GuardiansSet(bytes32 indexed didHash, uint8 threshold, uint64 delay, uint256 count);
    event RecoveryStarted(bytes32 indexed didHash, address indexed proposed, bytes32 indexed by, uint64 executableAt);
    event RecoveryApproved(bytes32 indexed didHash, bytes32 indexed by, uint8 approvals, uint8 threshold);
    event RecoveryCancelled(bytes32 indexed didHash, address indexed by);
    event RecoveryExecuted(bytes32 indexed didHash, address indexed from, address indexed to);

    error NotGovernor();
    error AlreadyRegistered();
    error UnknownIdentity();
    error IdentityIsRevoked();
    error NotController();
    error NotAuthorized();
    error SignatureExpired();
    error InvalidSignature();
    error ZeroAddress();
    error RoleManagerUnset();
    error LastAdmin();
    error RoleManagerIsLocked();
    error NoProposal();
    error NotGuardian();
    error BadGuardianSet();
    error NoRecovery();
    error RecoveryPending();
    error AlreadyApproved();
    error ThresholdNotMet();
    error DelayNotElapsed();

    constructor(address governor_, address auditTrail_) EIP712("TrustChainDIDRegistry", "1") {
        if (governor_ == address(0) || auditTrail_ == address(0)) revert ZeroAddress();
        governor = governor_;
        auditTrail = IAuditTrail(auditTrail_);
    }

    // --------------------------------------------------------------------- wiring

    /// @notice RoleManager is deployed after this contract (it reads identities), so it is wired in here.
    function setRoleManager(address roleManager_) external {
        if (msg.sender != governor) revert NotGovernor();
        if (roleManagerLocked) revert RoleManagerIsLocked();
        if (roleManager_ == address(0)) revert ZeroAddress();
        roleManager = IRoleManager(roleManager_);
        emit RoleManagerUpdated(roleManager_);
    }

    /// @notice Freeze the RoleManager permanently. There is no unlock.
    function lockRoleManager() external {
        if (msg.sender != governor) revert NotGovernor();
        if (address(roleManager) == address(0)) revert RoleManagerUnset();
        roleManagerLocked = true;
        emit RoleManagerLocked(address(roleManager));
    }

    function transferGovernor(address newGovernor) external {
        if (msg.sender != governor) revert NotGovernor();
        if (newGovernor == address(0)) revert ZeroAddress();
        governor = newGovernor;
    }

    // ---------------------------------------------------------------- registration

    /// @notice Register your own identity. The transaction signature is the proof of control.
    function register(string calldata docURI) external returns (bytes32 didHash) {
        return _register(msg.sender, docURI, msg.sender);
    }

    /**
     * @notice Register an identity for `subject`, paid for by an operator holding
     *         REGISTER_IDENTITY and authorised by the subject's EIP-712 signature.
     */
    function registerFor(
        address subject,
        string calldata docURI,
        uint256 deadline,
        bytes calldata signature
    ) external returns (bytes32 didHash) {
        if (address(roleManager) == address(0)) revert RoleManagerUnset();
        if (!roleManager.hasPermission(msg.sender, Perm.REGISTER_IDENTITY)) revert NotAuthorized();
        if (block.timestamp > deadline) revert SignatureExpired();

        bytes32 structHash = keccak256(
            abi.encode(REGISTER_TYPEHASH, subject, keccak256(bytes(docURI)), nonces[subject], deadline)
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        if (!SignatureChecker.isValidSignatureNow(subject, digest, signature)) revert InvalidSignature();

        unchecked {
            nonces[subject] += 1;
        }
        return _register(subject, docURI, msg.sender);
    }

    function _register(address subject, string calldata docURI, address actor)
        private
        returns (bytes32 didHash)
    {
        if (subject == address(0)) revert ZeroAddress();
        if (didOf[subject] != bytes32(0)) revert AlreadyRegistered();

        string memory did = didStringFor(subject);
        didHash = keccak256(bytes(did));
        // The DID string is derived from an address, so an existing record here means this
        // subject registered before and (at most) revoked: identities are permanent.
        if (_identities[didHash].createdAt != 0) revert AlreadyRegistered();

        _identities[didHash] = Identity({
            controller: subject,
            createdAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp),
            revoked: false,
            docURI: docURI
        });
        didOf[subject] = didHash;
        _allDids.push(didHash);

        emit IdentityRegistered(didHash, subject, did, docURI);
        auditTrail.record(actor, Actions.IDENTITY_REGISTERED, didHash, keccak256(bytes(docURI)));
    }

    // ------------------------------------------------------------------ management

    function updateDocument(string calldata docURI) external {
        bytes32 didHash = _activeDidOfSender();
        _identities[didHash].docURI = docURI;
        _identities[didHash].updatedAt = uint64(block.timestamp);

        emit DocumentUpdated(didHash, docURI);
        auditTrail.record(msg.sender, Actions.IDENTITY_UPDATED, didHash, keccak256(bytes(docURI)));
    }

    /**
     * @notice Offer control of your DID to a new key. Nothing moves yet.
     *
     *         Rotation is two-step on purpose: a single-step version would hand an identity,
     *         its roles and its assets to whatever address was typed, including one nobody
     *         can sign for. Here the new key must claim it, which is only possible if it
     *         actually exists and its holder controls it.
     */
    function proposeController(address newController) external {
        if (newController == address(0)) revert ZeroAddress();
        if (didOf[newController] != bytes32(0)) revert AlreadyRegistered();

        bytes32 didHash = _activeDidOfSender();
        pendingController[didHash] = newController;
        emit ControllerProposed(didHash, msg.sender, newController);
    }

    /// @notice Withdraw an offer that has not been accepted.
    function cancelControllerProposal() external {
        bytes32 didHash = _activeDidOfSender();
        address was = pendingController[didHash];
        if (was == address(0)) revert NoProposal();
        pendingController[didHash] = address(0);
        emit ControllerProposalCancelled(didHash, was);
    }

    /**
     * @notice Take control of a DID that has been offered to you. Proving control of the
     *         new key is the whole point, so only that key can call this.
     */
    function acceptController(bytes32 didHash) external {
        Identity storage id = _identities[didHash];
        if (id.createdAt == 0) revert UnknownIdentity();
        if (id.revoked) revert IdentityIsRevoked();
        if (pendingController[didHash] != msg.sender) revert NoProposal();
        if (didOf[msg.sender] != bytes32(0)) revert AlreadyRegistered();

        address from = id.controller;
        pendingController[didHash] = address(0);
        didOf[from] = bytes32(0);
        didOf[msg.sender] = didHash;
        id.controller = msg.sender;
        id.updatedAt = uint64(block.timestamp);

        emit ControllerRotated(didHash, from, msg.sender);
        auditTrail.record(
            msg.sender, Actions.IDENTITY_ROTATED, didHash, keccak256(abi.encode(from, msg.sender))
        );
    }

    // ------------------------------------------------------------ social recovery

    /**
     * @notice Nominate the identities that can recover this one, and how many must agree.
     * @param guardians  guardian DIDs; each must be a registered, active identity
     * @param threshold  how many of them must approve
     * @param delay      seconds the controller has to veto after the threshold is reached.
     *                   Zero lets guardians act the instant they agree - fine for a
     *                   demonstration, reckless for anything real. Days, not seconds.
     */
    function setGuardians(bytes32[] calldata guardians, uint8 threshold, uint64 delay) external {
        bytes32 didHash = _activeDidOfSender();
        if (guardians.length > MAX_GUARDIANS) revert BadGuardianSet();
        if (threshold == 0 || threshold > guardians.length) revert BadGuardianSet();

        GuardianSet storage set = _guardianSets[didHash];
        for (uint256 i = 0; i < set.guardians.length; ++i) {
            isGuardian[didHash][set.guardians[i]] = false;
        }
        delete set.guardians;

        for (uint256 i = 0; i < guardians.length; ++i) {
            bytes32 g = guardians[i];
            // A guardian must be a real, live identity, must not be this identity, and must
            // not be listed twice - otherwise one person could meet the threshold alone.
            if (g == didHash || !isDidActive(g) || isGuardian[didHash][g]) revert BadGuardianSet();
            isGuardian[didHash][g] = true;
            set.guardians.push(g);
        }
        set.threshold = threshold;
        set.delay = delay;

        // Changing the guardian set invalidates anything they had already started.
        Recovery storage r = _recoveries[didHash];
        r.round += 1;
        r.proposed = address(0);
        r.approvals = 0;

        emit GuardiansSet(didHash, threshold, delay, guardians.length);
        auditTrail.record(
            msg.sender, Actions.GUARDIANS_SET, didHash, keccak256(abi.encode(guardians, threshold, delay))
        );
    }

    /// @notice Begin recovering an identity onto a new key. Callable by any of its guardians.
    function initiateRecovery(bytes32 didHash, address newController) external {
        bytes32 guardianDid = _guardianOfSender(didHash);
        if (newController == address(0) || didOf[newController] != bytes32(0)) revert AlreadyRegistered();

        Recovery storage r = _recoveries[didHash];
        if (r.proposed != address(0)) revert RecoveryPending();

        r.proposed = newController;
        r.startedAt = uint64(block.timestamp);
        r.approvals = 1;
        _approved[didHash][r.round][guardianDid] = true;

        uint64 executableAt = uint64(block.timestamp) + _guardianSets[didHash].delay;
        emit RecoveryStarted(didHash, newController, guardianDid, executableAt);
        auditTrail.record(
            msg.sender, Actions.RECOVERY_STARTED, didHash, keccak256(abi.encode(newController, executableAt))
        );
    }

    /// @notice Add your approval to the recovery already under way.
    function approveRecovery(bytes32 didHash) external {
        bytes32 guardianDid = _guardianOfSender(didHash);
        Recovery storage r = _recoveries[didHash];
        if (r.proposed == address(0)) revert NoRecovery();
        if (_approved[didHash][r.round][guardianDid]) revert AlreadyApproved();

        _approved[didHash][r.round][guardianDid] = true;
        r.approvals += 1;

        emit RecoveryApproved(didHash, guardianDid, r.approvals, _guardianSets[didHash].threshold);
        auditTrail.record(msg.sender, Actions.RECOVERY_APPROVED, didHash, bytes32(uint256(r.approvals)));
    }

    /// @notice Veto a recovery. Only the current controller - this is what the delay is for.
    function cancelRecovery() external {
        bytes32 didHash = _activeDidOfSender();
        Recovery storage r = _recoveries[didHash];
        if (r.proposed == address(0)) revert NoRecovery();

        r.round += 1;
        r.proposed = address(0);
        r.approvals = 0;

        emit RecoveryCancelled(didHash, msg.sender);
        auditTrail.record(msg.sender, Actions.RECOVERY_CANCELLED, didHash, bytes32(0));
    }

    /**
     * @notice Complete a recovery once enough guardians agree and the veto window has passed.
     *         Anyone may call it - the authorisation is the approvals, not the caller.
     */
    function executeRecovery(bytes32 didHash) external {
        Identity storage id = _identities[didHash];
        if (id.createdAt == 0) revert UnknownIdentity();
        if (id.revoked) revert IdentityIsRevoked();

        Recovery storage r = _recoveries[didHash];
        GuardianSet storage set = _guardianSets[didHash];
        if (r.proposed == address(0)) revert NoRecovery();
        if (r.approvals < set.threshold) revert ThresholdNotMet();
        if (block.timestamp < r.startedAt + set.delay) revert DelayNotElapsed();

        address to = r.proposed;
        if (didOf[to] != bytes32(0)) revert AlreadyRegistered();

        address from = id.controller;
        r.round += 1;
        r.proposed = address(0);
        r.approvals = 0;

        didOf[from] = bytes32(0);
        didOf[to] = didHash;
        id.controller = to;
        id.updatedAt = uint64(block.timestamp);
        pendingController[didHash] = address(0);

        emit RecoveryExecuted(didHash, from, to);
        emit ControllerRotated(didHash, from, to);
        auditTrail.record(msg.sender, Actions.IDENTITY_ROTATED, didHash, keccak256(abi.encode(from, to)));
    }

    function guardiansOf(bytes32 didHash)
        external
        view
        returns (bytes32[] memory guardians, uint8 threshold, uint64 delay)
    {
        GuardianSet storage set = _guardianSets[didHash];
        return (set.guardians, set.threshold, set.delay);
    }

    function recoveryOf(bytes32 didHash)
        external
        view
        returns (address proposed, uint64 startedAt, uint8 approvals, uint8 threshold, uint64 executableAt)
    {
        Recovery storage r = _recoveries[didHash];
        GuardianSet storage set = _guardianSets[didHash];
        return (r.proposed, r.startedAt, r.approvals, set.threshold, r.startedAt + set.delay);
    }

    function _guardianOfSender(bytes32 didHash) private view returns (bytes32 guardianDid) {
        Identity storage id = _identities[didHash];
        if (id.createdAt == 0) revert UnknownIdentity();
        if (id.revoked) revert IdentityIsRevoked();

        guardianDid = didOf[msg.sender];
        if (guardianDid == bytes32(0) || !isDidActive(guardianDid)) revert NotGuardian();
        if (!isGuardian[didHash][guardianDid]) revert NotGuardian();
    }

    /// @notice Revoke an identity - the controller itself, or an operator holding
    ///         REVOKE_IDENTITY. Revocation is permanent.
    function revoke(bytes32 didHash) external {
        Identity storage id = _identities[didHash];
        if (id.createdAt == 0) revert UnknownIdentity();
        if (id.revoked) revert IdentityIsRevoked();

        bool isSelf = id.controller == msg.sender;
        if (!isSelf) {
            if (address(roleManager) == address(0)) revert RoleManagerUnset();
            if (!roleManager.hasPermission(msg.sender, Perm.REVOKE_IDENTITY)) revert NotAuthorized();
        }
        // Roles resolve through the identity, so revoking the last administrator's identity
        // would strip its permissions just as surely as revoking the role itself.
        if (address(roleManager) != address(0) && roleManager.isLastAdmin(didHash)) revert LastAdmin();

        id.revoked = true;
        id.updatedAt = uint64(block.timestamp);

        emit IdentityRevoked(didHash, msg.sender);
        auditTrail.record(msg.sender, Actions.IDENTITY_REVOKED, didHash, bytes32(uint256(isSelf ? 1 : 0)));
    }

    // ---------------------------------------------------------------- introspection

    function didStringFor(address subject) public view returns (string memory) {
        return string.concat(
            "did:tcid:",
            Strings.toString(block.chainid),
            ":",
            Strings.toHexString(uint160(subject), 20)
        );
    }

    function resolve(bytes32 didHash) external view returns (Identity memory) {
        Identity memory id = _identities[didHash];
        if (id.createdAt == 0) revert UnknownIdentity();
        return id;
    }

    function resolveAddress(address account) external view returns (Identity memory) {
        bytes32 didHash = didOf[account];
        if (didHash == bytes32(0)) revert UnknownIdentity();
        return _identities[didHash];
    }

    function isActive(address account) public view override returns (bool) {
        bytes32 didHash = didOf[account];
        if (didHash == bytes32(0)) return false;
        return !_identities[didHash].revoked;
    }

    function isDidActive(bytes32 didHash) public view override returns (bool) {
        Identity storage id = _identities[didHash];
        return id.createdAt != 0 && !id.revoked;
    }

    function controllerOf(bytes32 didHash) external view override returns (address) {
        Identity storage id = _identities[didHash];
        if (id.createdAt == 0 || id.revoked) return address(0);
        return id.controller;
    }

    function identityCount() external view returns (uint256) {
        return _allDids.length;
    }

    function allDids(uint256 offset, uint256 limit) external view returns (bytes32[] memory page) {
        uint256 total = _allDids.length;
        if (offset >= total) return new bytes32[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        page = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = _allDids[i];
        }
    }

    function _activeDidOfSender() private view returns (bytes32 didHash) {
        didHash = didOf[msg.sender];
        if (didHash == bytes32(0)) revert NotController();
        if (_identities[didHash].revoked) revert IdentityIsRevoked();
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDIDRegistry, IRoleManager, IAuditTrail} from "./interfaces/IPlatform.sol";
import {Perm, Roles, Actions} from "./libraries/Permissions.sol";

/**
 * @title RoleManager
 * @notice Role-Based Access Control bound to decentralised identities, not to raw addresses.
 *
 *         Roles are granted to a DID. If the identity is revoked, every permission it held
 *         evaporates in the same block - there is no stale grant to clean up. If the
 *         identity rotates to a new key, the roles follow it, because they were never
 *         attached to the key in the first place.
 *
 *         Two independent checks guard a grant: the caller needs the MANAGE_ROLES
 *         capability bit, and must hold the target role's admin role (or ADMIN). So a
 *         Manager can onboard Users without being able to mint Managers.
 *
 *         Grants may carry an expiry - useful for a time-boxed Auditor.
 */
contract RoleManager is IRoleManager {
    struct RoleDef {
        uint256 permissions;
        bytes32 adminRole;
        bool exists;
        string label;
    }

    struct Grant {
        uint64 grantedAt;
        uint64 expiresAt; // 0 == never expires
        bool active;
    }

    uint256 public constant MAX_ROLES_PER_IDENTITY = 16;

    IDIDRegistry public immutable didRegistry;
    IAuditTrail public immutable auditTrail;

    mapping(bytes32 => RoleDef) private _roles;
    bytes32[] private _allRoles;

    mapping(bytes32 => mapping(bytes32 => Grant)) private _grants; // didHash => role => grant
    mapping(bytes32 => bytes32[]) private _rolesOf; // didHash => roles ever granted

    event RoleCreated(bytes32 indexed role, string label, uint256 permissions, bytes32 adminRole);
    event RolePermissionsUpdated(bytes32 indexed role, uint256 permissions);
    event RoleAdminUpdated(bytes32 indexed role, bytes32 adminRole);
    event RoleGranted(bytes32 indexed didHash, bytes32 indexed role, address indexed by, uint64 expiresAt);
    event RoleRevoked(bytes32 indexed didHash, bytes32 indexed role, address indexed by);

    error NotAuthorized();
    error UnknownRole();
    error RoleExists();
    error InactiveIdentity();
    error AlreadyGranted();
    error NotGranted();
    error TooManyRoles();
    error ZeroAddress();
    error ExpiryInPast();

    address public pendingRootAdmin;
    bool public bootstrapped;

    /**
     * @param didRegistry_ identity source of truth
     * @param auditTrail_  append-only log
     * @param rootAdmin    bootstrap administrator; claims ADMIN by calling `bootstrap()`
     *                     once this contract has been registered as an audit-trail writer
     */
    constructor(address didRegistry_, address auditTrail_, address rootAdmin) {
        if (didRegistry_ == address(0) || auditTrail_ == address(0) || rootAdmin == address(0)) {
            revert ZeroAddress();
        }
        didRegistry = IDIDRegistry(didRegistry_);
        auditTrail = IAuditTrail(auditTrail_);

        _createRole(Roles.ADMIN, "Admin", Perm.ALL, Roles.ADMIN);
        _createRole(
            Roles.MANAGER,
            "Manager",
            Perm.MANAGE_ROLES | Perm.REGISTER_IDENTITY | Perm.MINT_ASSET | Perm.TRANSFER_ASSET
                | Perm.FREEZE_ASSET,
            Roles.ADMIN
        );
        _createRole(Roles.AUDITOR, "Auditor", Perm.READ_AUDIT, Roles.ADMIN);
        _createRole(Roles.USER, "User", 0, Roles.MANAGER);

        pendingRootAdmin = rootAdmin;
    }

    /**
     * @notice One-shot bootstrap: the address named at deployment claims ADMIN.
     *         Kept out of the constructor so the grant can be written to the audit trail,
     *         which only accepts writers registered after this contract exists.
     */
    function bootstrap() external {
        if (bootstrapped || msg.sender != pendingRootAdmin) revert NotAuthorized();
        bytes32 rootDid = didRegistry.didOf(msg.sender);
        if (rootDid == bytes32(0) || !didRegistry.isDidActive(rootDid)) revert InactiveIdentity();

        bootstrapped = true;
        pendingRootAdmin = address(0);
        _grant(rootDid, Roles.ADMIN, 0, msg.sender);
    }

    // --------------------------------------------------------------------- role defs

    function createRole(bytes32 role, string calldata label, uint256 permissions, bytes32 adminRole)
        external
    {
        _requireRole(msg.sender, Roles.ADMIN);
        if (_roles[role].exists) revert RoleExists();
        if (!_roles[adminRole].exists) revert UnknownRole();
        _createRole(role, label, permissions, adminRole);
    }

    function setRolePermissions(bytes32 role, uint256 permissions) external {
        _requireRole(msg.sender, Roles.ADMIN);
        if (!_roles[role].exists) revert UnknownRole();
        _roles[role].permissions = permissions;

        emit RolePermissionsUpdated(role, permissions);
        auditTrail.record(msg.sender, Actions.ROLE_PERMS_UPDATED, role, bytes32(permissions));
    }

    function setRoleAdmin(bytes32 role, bytes32 adminRole) external {
        _requireRole(msg.sender, Roles.ADMIN);
        if (!_roles[role].exists || !_roles[adminRole].exists) revert UnknownRole();
        _roles[role].adminRole = adminRole;
        emit RoleAdminUpdated(role, adminRole);
    }

    // ----------------------------------------------------------------------- grants

    function grantRole(bytes32 didHash, bytes32 role, uint64 expiresAt) public {
        RoleDef storage def = _roles[role];
        if (!def.exists) revert UnknownRole();
        if (!hasPermission(msg.sender, Perm.MANAGE_ROLES)) revert NotAuthorized();
        if (!_holdsRole(msg.sender, Roles.ADMIN) && !_holdsRole(msg.sender, def.adminRole)) {
            revert NotAuthorized();
        }
        if (!didRegistry.isDidActive(didHash)) revert InactiveIdentity();
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert ExpiryInPast();

        _grant(didHash, role, expiresAt, msg.sender);
    }

    /// @notice Convenience wrapper - resolves the account's DID first.
    function grantRoleToAccount(address account, bytes32 role, uint64 expiresAt) external {
        bytes32 didHash = didRegistry.didOf(account);
        if (didHash == bytes32(0)) revert InactiveIdentity();
        grantRole(didHash, role, expiresAt);
    }

    function revokeRole(bytes32 didHash, bytes32 role) external {
        RoleDef storage def = _roles[role];
        if (!def.exists) revert UnknownRole();
        if (!hasPermission(msg.sender, Perm.MANAGE_ROLES)) revert NotAuthorized();
        if (!_holdsRole(msg.sender, Roles.ADMIN) && !_holdsRole(msg.sender, def.adminRole)) {
            revert NotAuthorized();
        }
        _revoke(didHash, role, msg.sender);
    }

    /// @notice Give up one of your own roles. Needs no permission.
    function renounceRole(bytes32 role) external {
        bytes32 didHash = didRegistry.didOf(msg.sender);
        if (didHash == bytes32(0)) revert InactiveIdentity();
        _revoke(didHash, role, msg.sender);
    }

    function _createRole(bytes32 role, string memory label, uint256 permissions, bytes32 adminRole)
        private
    {
        _roles[role] = RoleDef({permissions: permissions, adminRole: adminRole, exists: true, label: label});
        _allRoles.push(role);
        emit RoleCreated(role, label, permissions, adminRole);
    }

    function _grant(bytes32 didHash, bytes32 role, uint64 expiresAt, address by) private {
        Grant storage g = _grants[didHash][role];
        if (g.active) revert AlreadyGranted();
        if (g.grantedAt == 0) {
            if (_rolesOf[didHash].length >= MAX_ROLES_PER_IDENTITY) revert TooManyRoles();
            _rolesOf[didHash].push(role);
        }
        g.grantedAt = uint64(block.timestamp);
        g.expiresAt = expiresAt;
        g.active = true;

        emit RoleGranted(didHash, role, by, expiresAt);
        auditTrail.record(by, Actions.ROLE_GRANTED, didHash, keccak256(abi.encode(role, expiresAt)));
    }

    function _revoke(bytes32 didHash, bytes32 role, address by) private {
        Grant storage g = _grants[didHash][role];
        if (!g.active) revert NotGranted();
        g.active = false;

        emit RoleRevoked(didHash, role, by);
        auditTrail.record(by, Actions.ROLE_REVOKED, didHash, keccak256(abi.encode(role)));
    }

    // ------------------------------------------------------------------- resolution

    /// @notice Union of the permissions of every live role the account's identity holds.
    ///         Returns 0 for an unregistered or revoked identity.
    function permissionsOf(address account) public view override returns (uint256 mask) {
        bytes32 didHash = didRegistry.didOf(account);
        if (didHash == bytes32(0) || !didRegistry.isDidActive(didHash)) return 0;
        return permissionsOfDid(didHash);
    }

    function permissionsOfDid(bytes32 didHash) public view returns (uint256 mask) {
        bytes32[] storage held = _rolesOf[didHash];
        for (uint256 i = 0; i < held.length; ++i) {
            if (_isLive(_grants[didHash][held[i]])) {
                mask |= _roles[held[i]].permissions;
            }
        }
    }

    function hasPermission(address account, uint256 permissions) public view override returns (bool) {
        if (permissions == 0) return true;
        return (permissionsOf(account) & permissions) == permissions;
    }

    function hasRole(address account, bytes32 role) external view returns (bool) {
        return _holdsRole(account, role);
    }

    function hasRoleDid(bytes32 didHash, bytes32 role) external view returns (bool) {
        return didRegistry.isDidActive(didHash) && _isLive(_grants[didHash][role]);
    }

    /// @notice Every role currently live for an identity.
    function rolesOfDid(bytes32 didHash) external view returns (bytes32[] memory live) {
        bytes32[] storage held = _rolesOf[didHash];
        uint256 n;
        for (uint256 i = 0; i < held.length; ++i) {
            if (_isLive(_grants[didHash][held[i]])) ++n;
        }
        live = new bytes32[](n);
        uint256 j;
        for (uint256 i = 0; i < held.length; ++i) {
            if (_isLive(_grants[didHash][held[i]])) live[j++] = held[i];
        }
    }

    function grantOf(bytes32 didHash, bytes32 role) external view returns (Grant memory) {
        return _grants[didHash][role];
    }

    function roleDef(bytes32 role) external view returns (RoleDef memory) {
        if (!_roles[role].exists) revert UnknownRole();
        return _roles[role];
    }

    function allRoles() external view returns (bytes32[] memory) {
        return _allRoles;
    }

    function _holdsRole(address account, bytes32 role) private view returns (bool) {
        bytes32 didHash = didRegistry.didOf(account);
        if (didHash == bytes32(0) || !didRegistry.isDidActive(didHash)) return false;
        return _isLive(_grants[didHash][role]);
    }

    function _requireRole(address account, bytes32 role) private view {
        if (!_holdsRole(account, role)) revert NotAuthorized();
    }

    function _isLive(Grant storage g) private view returns (bool) {
        return g.active && (g.expiresAt == 0 || g.expiresAt > block.timestamp);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Permission bits used across the platform. A role is a bitmask of these.
library Perm {
    uint256 internal constant MANAGE_ROLES      = 1 << 0; // grant / revoke roles, edit role permissions
    uint256 internal constant REGISTER_IDENTITY = 1 << 1; // register a DID on behalf of a subject
    uint256 internal constant REVOKE_IDENTITY   = 1 << 2; // revoke someone else's DID
    uint256 internal constant MINT_ASSET        = 1 << 3; // mint an asset NFT
    uint256 internal constant TRANSFER_ASSET    = 1 << 4; // move an asset the caller does not own (custodial)
    uint256 internal constant FREEZE_ASSET      = 1 << 5; // freeze / unfreeze an asset
    uint256 internal constant BURN_ASSET        = 1 << 6; // destroy an asset
    // Not enforceable on-chain and deliberately not enforced: everything on a public chain
    // is readable by everyone. This bit gates an off-chain indexer, dashboard or export -
    // it is an application-level capability, not a confidentiality guarantee.
    uint256 internal constant READ_AUDIT        = 1 << 7;

    uint256 internal constant ALL = (1 << 8) - 1;
}

/// @notice Canonical role identifiers. Extra roles can be created at runtime.
library Roles {
    bytes32 internal constant ADMIN   = keccak256("ROLE_ADMIN");
    bytes32 internal constant MANAGER = keccak256("ROLE_MANAGER");
    bytes32 internal constant AUDITOR = keccak256("ROLE_AUDITOR");
    bytes32 internal constant USER    = keccak256("ROLE_USER");
}

/// @notice Action codes written into the audit trail.
library Actions {
    bytes32 internal constant IDENTITY_REGISTERED = keccak256("IDENTITY_REGISTERED");
    bytes32 internal constant IDENTITY_UPDATED    = keccak256("IDENTITY_UPDATED");
    bytes32 internal constant IDENTITY_ROTATED    = keccak256("IDENTITY_ROTATED");
    bytes32 internal constant IDENTITY_REVOKED    = keccak256("IDENTITY_REVOKED");
    bytes32 internal constant ROLE_GRANTED        = keccak256("ROLE_GRANTED");
    bytes32 internal constant ROLE_REVOKED        = keccak256("ROLE_REVOKED");
    bytes32 internal constant ROLE_PERMS_UPDATED  = keccak256("ROLE_PERMS_UPDATED");
    bytes32 internal constant ASSET_MINTED        = keccak256("ASSET_MINTED");
    bytes32 internal constant ASSET_TRANSFERRED   = keccak256("ASSET_TRANSFERRED");
    bytes32 internal constant ASSET_FROZEN        = keccak256("ASSET_FROZEN");
    bytes32 internal constant ASSET_UNFROZEN      = keccak256("ASSET_UNFROZEN");
    bytes32 internal constant ASSET_BURNED        = keccak256("ASSET_BURNED");
    bytes32 internal constant GUARDIANS_SET       = keccak256("GUARDIANS_SET");
    bytes32 internal constant RECOVERY_STARTED    = keccak256("RECOVERY_STARTED");
    bytes32 internal constant RECOVERY_APPROVED   = keccak256("RECOVERY_APPROVED");
    bytes32 internal constant RECOVERY_CANCELLED  = keccak256("RECOVERY_CANCELLED");
}

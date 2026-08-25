// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAuditTrail {
    function record(address actor, bytes32 action, bytes32 subject, bytes32 dataHash)
        external
        returns (uint256 id);
}

interface IDIDRegistry {
    /// @return didHash keccak256 of the DID string, or bytes32(0) if the account controls no DID
    function didOf(address account) external view returns (bytes32 didHash);

    /// @return true if the account controls a registered, non-revoked DID
    function isActive(address account) external view returns (bool);

    /// @return the address currently controlling `didHash` (address(0) if unknown/revoked)
    function controllerOf(bytes32 didHash) external view returns (address);

    function isDidActive(bytes32 didHash) external view returns (bool);
}

interface IRoleManager {
    /// @return true if `account` holds a non-expired role carrying every bit in `permissions`
    function hasPermission(address account, uint256 permissions) external view returns (bool);

    function permissionsOf(address account) external view returns (uint256);

    /// @return true if revoking this identity would leave the platform with no administrator
    function isLastAdmin(bytes32 didHash) external view returns (bool);
}

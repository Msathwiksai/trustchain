// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRoleManager} from "../interfaces/IPlatform.sol";

/**
 * Test-only: a RoleManager that says yes to everyone.
 *
 * If a governor could repoint DIDRegistry at this, every permission check in the platform
 * would pass for every caller - mint, burn, revoke anyone. It exists to prove that swap
 * cannot happen once the pointer is locked.
 */
contract EvilRoleManager is IRoleManager {
    function hasPermission(address, uint256) external pure returns (bool) {
        return true;
    }

    function permissionsOf(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function isLastAdmin(bytes32) external pure returns (bool) {
        return false;
    }

    function isAdmin(bytes32) external pure returns (bool) {
        return false;
    }
}

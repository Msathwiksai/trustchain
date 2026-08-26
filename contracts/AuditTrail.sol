// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title AuditTrail
 * @notice Append-only ledger of every privileged action on the platform.
 *         Entries can never be edited or deleted - there is no code path that writes
 *         to an existing index. Only registered platform contracts may append.
 */
contract AuditTrail {
    struct Entry {
        uint64 timestamp;
        uint64 blockNumber;
        address actor;      // the address that authorised the action
        bytes32 action;     // Actions.* code
        bytes32 subject;    // didHash, tokenId or role the action applied to
        bytes32 dataHash;   // hash of the action payload (URI, target, amount...)
    }

    Entry[] private _entries;

    address public governor;
    mapping(address => bool) public isWriter;

    /// @notice Once true, the set of writers can never change again - not by this governor,
    ///         not by any future one. Deployment locks it, so "only the platform contracts
    ///         can append" stops being a promise about governance and becomes a property
    ///         of the code.
    bool public writersLocked;

    event AuditRecorded(
        uint256 indexed id,
        address indexed actor,
        bytes32 indexed action,
        bytes32 subject,
        bytes32 dataHash,
        uint64 timestamp
    );
    event WriterUpdated(address indexed writer, bool allowed);
    event WritersLocked();
    event GovernorTransferred(address indexed from, address indexed to);

    error NotGovernor();
    error NotWriter();
    error ZeroAddress();
    error WritersAreLocked();

    constructor(address governor_) {
        if (governor_ == address(0)) revert ZeroAddress();
        governor = governor_;
    }

    modifier onlyGovernor() {
        if (msg.sender != governor) revert NotGovernor();
        _;
    }

    /// @notice Authorise (or de-authorise) a platform contract to append entries.
    function setWriter(address writer, bool allowed) external onlyGovernor {
        if (writersLocked) revert WritersAreLocked();
        if (writer == address(0)) revert ZeroAddress();
        isWriter[writer] = allowed;
        emit WriterUpdated(writer, allowed);
    }

    /// @notice Freeze the writer set permanently. There is no unlock.
    function lockWriters() external onlyGovernor {
        writersLocked = true;
        emit WritersLocked();
    }

    function transferGovernor(address newGovernor) external onlyGovernor {
        if (newGovernor == address(0)) revert ZeroAddress();
        emit GovernorTransferred(governor, newGovernor);
        governor = newGovernor;
    }

    /// @notice Append one immutable entry. Callable only by registered platform contracts.
    function record(address actor, bytes32 action, bytes32 subject, bytes32 dataHash)
        external
        returns (uint256 id)
    {
        if (!isWriter[msg.sender]) revert NotWriter();
        id = _entries.length;
        _entries.push(
            Entry({
                timestamp: uint64(block.timestamp),
                blockNumber: uint64(block.number),
                actor: actor,
                action: action,
                subject: subject,
                dataHash: dataHash
            })
        );
        emit AuditRecorded(id, actor, action, subject, dataHash, uint64(block.timestamp));
    }

    function entryCount() external view returns (uint256) {
        return _entries.length;
    }

    function getEntry(uint256 id) external view returns (Entry memory) {
        return _entries[id];
    }

    /// @notice Page through the trail, newest-last. Returns fewer than `limit` at the end.
    function getEntries(uint256 offset, uint256 limit) external view returns (Entry[] memory page) {
        uint256 total = _entries.length;
        if (offset >= total) return new Entry[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        page = new Entry[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = _entries[i];
        }
    }
}

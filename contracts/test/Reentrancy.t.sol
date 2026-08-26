// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

interface IAssetNFT {
    // A struct return is one ABI tuple, not a list of values - declaring it flat decodes wrong.
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

    function transferFrom(address from, address to, uint256 tokenId) external;
    function tokenURI(uint256 tokenId) external view returns (string memory);
    function assetOf(uint256 tokenId) external view returns (Asset memory);
}

/**
 * Test-only recipient that tries to move another token while it is being handed one.
 * Accepts any signature so it can hold an identity via the sponsored-registration path.
 */
contract ReentrantRecipient is IERC721Receiver, IERC1271 {
    IAssetNFT public immutable nft;
    uint256 private _armedToken;
    address private _target;

    constructor(address nft_) {
        nft = IAssetNFT(nft_);
    }

    function arm(uint256 tokenId, address target) external {
        _armedToken = tokenId;
        _target = target;
    }

    function isValidSignature(bytes32, bytes memory) external pure returns (bytes4) {
        return IERC1271.isValidSignature.selector;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (_armedToken != 0) {
            uint256 t = _armedToken;
            _armedToken = 0;
            nft.transferFrom(address(this), _target, t);
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}

/// Test-only recipient that records what the asset looked like at callback time.
contract MintObserver is IERC721Receiver, IERC1271 {
    IAssetNFT public immutable nft;
    string public sawURI;
    string public sawCategory;

    constructor(address nft_) {
        nft = IAssetNFT(nft_);
    }

    function isValidSignature(bytes32, bytes memory) external pure returns (bytes4) {
        return IERC1271.isValidSignature.selector;
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        sawURI = nft.tokenURI(tokenId);
        sawCategory = nft.assetOf(tokenId).category;
        return IERC721Receiver.onERC721Received.selector;
    }
}

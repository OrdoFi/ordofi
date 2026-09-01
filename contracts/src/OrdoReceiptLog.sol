// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IOrdoSettlementAuctioneer {
    function auctioneer() external view returns (address);
}

/// @title  OrdoReceiptLog — on-chain anchors for auction receipt history
/// @notice The auction signs a receipt for every sealed-bid round it runs
///         (see packages/core/src/receipt.ts). Signatures stop receipts being
///         forged, but a signature cannot stop the operator from *withholding*
///         a receipt and serving a different one later — each searcher only
///         ever sees their own. Committing the Merkle root of every receipt
///         issued fixes the whole history at a point in time: replacing any
///         receipt afterwards would change the root, and the root is here.
///
/// @dev    Who may commit is read from OrdoSettlement rather than stored
///         again. The auctioneer is already the identity that signs receipts
///         and submits settlements; giving this contract its own copy would
///         just be a second thing to rotate and a way for the two to drift.
contract OrdoReceiptLog {
    IOrdoSettlementAuctioneer public immutable settlement;

    struct Commitment {
        bytes32 root;
        /// @dev How many receipts the root covers, so an auditor knows which
        ///      prefix of the published log is anchored.
        uint64 count;
        uint64 committedAt;
    }

    Commitment[] public commitments;

    event Committed(uint256 indexed index, bytes32 root, uint64 count);

    error NotAuctioneer();
    error EmptyRoot();
    error ShrinkingLog(uint64 previous, uint64 submitted);

    constructor(address settlement_) {
        settlement = IOrdoSettlementAuctioneer(settlement_);
    }

    function commit(bytes32 root, uint64 count) external {
        if (msg.sender != settlement.auctioneer()) revert NotAuctioneer();
        if (root == bytes32(0)) revert EmptyRoot();
        // Receipts accumulate; a commitment covering fewer of them than the
        // last one is the log being rewritten, which is the attack this
        // contract exists to make visible.
        if (commitments.length > 0 && count < commitments[commitments.length - 1].count) {
            revert ShrinkingLog(commitments[commitments.length - 1].count, count);
        }
        commitments.push(Commitment(root, count, uint64(block.timestamp)));
        emit Committed(commitments.length - 1, root, count);
    }

    function latest() external view returns (Commitment memory) {
        require(commitments.length > 0, "no commitments");
        return commitments[commitments.length - 1];
    }

    function total() external view returns (uint256) {
        return commitments.length;
    }

    /// @notice Check a receipt hash against a committed root. Pairs are hashed
    ///         in sorted order and odd nodes carry up unpaired — this must
    ///         mirror merkleProof() in packages/core/src/receipt.ts exactly,
    ///         and the cross-implementation fixtures in the test suite hold
    ///         the two to that.
    function verify(bytes32 leaf, bytes32[] calldata proof, uint256 index) external view returns (bool) {
        bytes32 computed = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 sibling = proof[i];
            computed = computed <= sibling
                ? keccak256(abi.encodePacked(computed, sibling))
                : keccak256(abi.encodePacked(sibling, computed));
        }
        return computed == commitments[index].root;
    }
}

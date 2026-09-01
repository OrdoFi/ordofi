// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/OrdoSettlement.sol";

/// @notice Proves OrdoSettlement deploys and runs a full settlement lifecycle
///         against REAL Robinhood Chain mainnet state (forked). Run with:
///         forge test --match-contract Fork --fork-url robinhood
///         (skips automatically if no fork RPC is configured.)
contract OrdoSettlementForkTest is Test {
    OrdoSettlement settlement;
    address auctioneer = makeAddr("auctioneer");
    address treasury = makeAddr("treasury");
    address user = makeAddr("user");
    address app = makeAddr("app");
    uint256 searcherPk = 0xA11CE;
    address searcher;

    bool forked;

    function setUp() public {
        // `--fork-url` may already have put us on the chain. Re-forking would
        // drop back to the `robinhood` alias, whose public endpoint refuses
        // Foundry's user agent — so the suite would silently skip while
        // appearing to pass. Run this through `scripts/fork-proxy.mjs` or a
        // node of your own.
        if (block.chainid != 4663) {
            try vm.createSelectFork("robinhood") {} catch {}
        }
        if (block.chainid != 4663) {
            forked = false;
            return;
        }
        forked = true;
        searcher = vm.addr(searcherPk);
        settlement = new OrdoSettlement(auctioneer, treasury, 500, 500);
    }

    function test_Fork_FullLifecycleOnMainnetState() public {
        if (!forked) {
            emit log("SKIPPED: not forked. Run: node scripts/fork-proxy.mjs");
            emit log("         then: forge test --fork-url http://127.0.0.1:8545");
            return;
        }

        assertEq(block.chainid, 4663, "forked Robinhood Chain");
        emit log_named_uint("forked at block", block.number);

        // Searcher bonds real-looking ETH on the forked chain.
        vm.deal(searcher, 5 ether);
        vm.prank(searcher);
        settlement.deposit{value: 2 ether}();
        assertEq(settlement.bond(searcher), 2 ether);

        // Searcher signs a max bid; auctioneer settles at a lower clearing price.
        bytes32 oppId = keccak256("fork-opp");
        bytes32 digest = settlement.bidDigest(searcher, oppId, 1 ether);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(searcherPk, digest);
        OrdoSettlement.Settlement memory st =
            OrdoSettlement.Settlement(searcher, oppId, 1 ether, 0.8 ether, user, app);
        vm.prank(auctioneer);
        settlement.settle(st, abi.encodePacked(r, s, v));

        assertEq(settlement.bond(searcher), 2 ether - 0.8 ether, "charged clearing price");
        assertEq(settlement.claimable(user), (0.8 ether * 9000) / 10000);
        assertEq(settlement.claimable(app), (0.8 ether * 500) / 10000);
        assertEq(settlement.claimable(treasury), (0.8 ether * 500) / 10000);

        // Beneficiary claims real ETH out.
        uint256 before = user.balance;
        vm.prank(user);
        settlement.claim();
        assertEq(user.balance - before, (0.8 ether * 9000) / 10000, "user claimed rebate");
    }
}

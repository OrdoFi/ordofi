// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/OrdoSettlement.sol";

contract OrdoSettlementTest is Test {
    OrdoSettlement settlement;

    address owner = address(this);
    address auctioneer = makeAddr("auctioneer");
    address treasury = makeAddr("treasury");
    address user = makeAddr("user");
    address app = makeAddr("app");

    uint256 searcherPk = 0xA11CE;
    address searcher;

    // 5% app, 5% protocol, 90% user
    uint16 constant APP_BPS = 500;
    uint16 constant PROTOCOL_BPS = 500;

    function setUp() public {
        searcher = vm.addr(searcherPk);
        settlement = new OrdoSettlement(auctioneer, treasury, APP_BPS, PROTOCOL_BPS);
        vm.deal(searcher, 100 ether);
    }

    function _sign(bytes32 opportunityId, uint256 amount) internal view returns (bytes memory) {
        bytes32 digest = settlement.bidDigest(searcher, opportunityId, amount);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(searcherPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _deposit(uint256 amount) internal {
        vm.prank(searcher);
        settlement.deposit{value: amount}();
    }

    function test_DepositAndBond() public {
        _deposit(10 ether);
        assertEq(settlement.bond(searcher), 10 ether);
    }

    function test_ReceiveFallbackDeposits() public {
        vm.prank(searcher);
        (bool ok,) = address(settlement).call{value: 3 ether}("");
        assertTrue(ok);
        assertEq(settlement.bond(searcher), 3 ether);
    }

    function test_SettleSplitsCorrectly() public {
        _deposit(10 ether);
        bytes32 oppId = keccak256("opp-1");
        uint256 amount = 1 ether;
        bytes memory sig = _sign(oppId, amount);

        // First-price case: charge == signed max.
        OrdoSettlement.Settlement memory s = OrdoSettlement.Settlement({
            searcher: searcher,
            opportunityId: oppId,
            maxAmountWei: amount,
            chargeWei: amount,
            user: user,
            app: app
        });

        vm.prank(auctioneer);
        settlement.settle(s, sig);

        assertEq(settlement.bond(searcher), 9 ether, "bond debited");
        assertEq(settlement.claimable(app), 0.05 ether, "app 5%");
        assertEq(settlement.claimable(treasury), 0.05 ether, "protocol 5%");
        assertEq(settlement.claimable(user), 0.90 ether, "user 90%");
        assertTrue(settlement.settled(oppId));
    }

    function test_SecondPriceChargesLessThanBid() public {
        _deposit(10 ether);
        bytes32 oppId = keccak256("opp-2price");
        // Searcher signs a max bid of 2 ETH but the clearing price is 1.2 ETH.
        bytes memory sig = _sign(oppId, 2 ether);
        OrdoSettlement.Settlement memory s =
            OrdoSettlement.Settlement(searcher, oppId, 2 ether, 1.2 ether, user, app);
        vm.prank(auctioneer);
        settlement.settle(s, sig);

        assertEq(settlement.bond(searcher), 10 ether - 1.2 ether, "charged clearing price, not bid");
        assertEq(settlement.claimable(user), (1.2 ether * 9000) / 10000);
    }

    function test_RevertWhen_ChargeExceedsBid() public {
        _deposit(10 ether);
        bytes32 oppId = keccak256("opp-overcharge");
        bytes memory sig = _sign(oppId, 1 ether);
        // Auctioneer tries to charge 1.5 ETH on a 1 ETH signed bid.
        OrdoSettlement.Settlement memory s =
            OrdoSettlement.Settlement(searcher, oppId, 1 ether, 1.5 ether, user, app);
        vm.prank(auctioneer);
        vm.expectRevert(OrdoSettlement.ChargeExceedsBid.selector);
        settlement.settle(s, sig);
    }

    function test_ClaimPaysOut() public {
        _deposit(10 ether);
        bytes32 oppId = keccak256("opp-claim");
        bytes memory sig = _sign(oppId, 1 ether);
        OrdoSettlement.Settlement memory s = OrdoSettlement.Settlement(searcher, oppId, 1 ether, 1 ether, user, app);
        vm.prank(auctioneer);
        settlement.settle(s, sig);

        uint256 before = user.balance;
        vm.prank(user);
        settlement.claim();
        assertEq(user.balance - before, 0.90 ether);
        assertEq(settlement.claimable(user), 0);
    }

    function test_RevertWhen_Replay() public {
        _deposit(10 ether);
        bytes32 oppId = keccak256("opp-replay");
        bytes memory sig = _sign(oppId, 1 ether);
        OrdoSettlement.Settlement memory s = OrdoSettlement.Settlement(searcher, oppId, 1 ether, 1 ether, user, app);
        vm.prank(auctioneer);
        settlement.settle(s, sig);

        vm.prank(auctioneer);
        vm.expectRevert(OrdoSettlement.AlreadySettled.selector);
        settlement.settle(s, sig);
    }

    function test_RevertWhen_NotAuctioneer() public {
        _deposit(10 ether);
        bytes32 oppId = keccak256("opp-auth");
        bytes memory sig = _sign(oppId, 1 ether);
        OrdoSettlement.Settlement memory s = OrdoSettlement.Settlement(searcher, oppId, 1 ether, 1 ether, user, app);
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(OrdoSettlement.NotAuctioneer.selector);
        settlement.settle(s, sig);
    }

    function test_RevertWhen_BadSignature() public {
        _deposit(10 ether);
        bytes32 oppId = keccak256("opp-badsig");
        // Sign a DIFFERENT amount than the one submitted -> signature won't match.
        bytes memory sig = _sign(oppId, 2 ether);
        OrdoSettlement.Settlement memory s = OrdoSettlement.Settlement(searcher, oppId, 1 ether, 1 ether, user, app);
        vm.prank(auctioneer);
        vm.expectRevert(OrdoSettlement.BadSignature.selector);
        settlement.settle(s, sig);
    }

    function test_RevertWhen_ForgedSignerMismatch() public {
        _deposit(10 ether);
        bytes32 oppId = keccak256("opp-forge");
        // Auctioneer tries to charge a searcher who never signed: sign with a
        // different key but claim s.searcher is our searcher.
        uint256 otherPk = 0xB0B;
        bytes32 digest = settlement.bidDigest(searcher, oppId, 1 ether);
        (uint8 v, bytes32 r, bytes32 sb) = vm.sign(otherPk, digest);
        bytes memory sig = abi.encodePacked(r, sb, v);
        OrdoSettlement.Settlement memory s = OrdoSettlement.Settlement(searcher, oppId, 1 ether, 1 ether, user, app);
        vm.prank(auctioneer);
        vm.expectRevert(OrdoSettlement.BadSignature.selector);
        settlement.settle(s, sig);
    }

    function test_RevertWhen_InsufficientBond() public {
        _deposit(0.5 ether);
        bytes32 oppId = keccak256("opp-poor");
        bytes memory sig = _sign(oppId, 1 ether);
        OrdoSettlement.Settlement memory s = OrdoSettlement.Settlement(searcher, oppId, 1 ether, 1 ether, user, app);
        vm.prank(auctioneer);
        vm.expectRevert(OrdoSettlement.InsufficientBond.selector);
        settlement.settle(s, sig);
    }

    function test_WithdrawBond() public {
        _deposit(10 ether);
        uint256 before = searcher.balance;
        vm.prank(searcher);
        settlement.withdrawBond(4 ether);
        assertEq(searcher.balance - before, 4 ether);
        assertEq(settlement.bond(searcher), 6 ether);
    }

    function test_RevertWhen_WithdrawTooMuch() public {
        _deposit(1 ether);
        vm.prank(searcher);
        vm.expectRevert(OrdoSettlement.InsufficientBond.selector);
        settlement.withdrawBond(2 ether);
    }

    function test_RevertWhen_ClaimNothing() public {
        vm.prank(user);
        vm.expectRevert(OrdoSettlement.NothingToClaim.selector);
        settlement.claim();
    }

    function test_AdminSetSplit() public {
        settlement.setSplit(1000, 2000);
        assertEq(settlement.appBps(), 1000);
        assertEq(settlement.protocolBps(), 2000);
    }

    function test_RevertWhen_SplitTooHigh() public {
        vm.expectRevert(OrdoSettlement.InvalidSplit.selector);
        settlement.setSplit(6000, 5000);
    }

    function test_RevertWhen_NotOwner() public {
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(OrdoSettlement.NotOwner.selector);
        settlement.setAuctioneer(makeAddr("x"));
    }

    function testFuzz_SplitConservation(uint96 amount, uint16 aBps, uint16 pBps) public {
        vm.assume(uint256(aBps) + uint256(pBps) <= 10_000);
        vm.assume(amount > 0);
        settlement.setSplit(aBps, pBps);

        vm.deal(searcher, uint256(amount));
        vm.prank(searcher);
        settlement.deposit{value: amount}();

        bytes32 oppId = keccak256(abi.encode(amount, aBps, pBps));
        bytes memory sig = _sign(oppId, amount);
        OrdoSettlement.Settlement memory s = OrdoSettlement.Settlement(searcher, oppId, amount, amount, user, app);
        vm.prank(auctioneer);
        settlement.settle(s, sig);

        // No wei is created or destroyed across the split.
        uint256 total = settlement.claimable(user) + settlement.claimable(app) + settlement.claimable(treasury);
        assertEq(total, amount, "split conserves value");
    }
}

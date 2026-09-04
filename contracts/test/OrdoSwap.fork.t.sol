// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/OrdoSwap.sol";

interface IFactory {
    function getPool(address, address, uint24) external view returns (address);
}

interface IQuoterV2 {
    function quoteExactInput(bytes memory path, uint256 amountIn)
        external
        returns (uint256 amountOut, uint160[] memory, uint32[] memory, uint256);
}

/// @notice OrdoSwap against real Robinhood Chain state: a swap big enough to
///         open a cross-tier gap, and the reclaim that closes it inside the
///         same transaction.
///
///   node scripts/fork-proxy.mjs &   (or any endpoint that serves Foundry)
///   forge test --match-contract OrdoSwapFork --fork-url http://127.0.0.1:8545 -vv
contract OrdoSwapForkTest is Test {
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant QUOTER = 0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7;

    OrdoSwap ordo;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address user = makeAddr("user");
    bool forked;

    // The two tiers the tests trade across: the thinnest (moves most) and the deepest.
    uint24 thin;
    uint24 deep;

    function setUp() public {
        if (block.chainid != 4663) {
            try vm.createSelectFork("robinhood") {} catch {}
        }
        if (block.chainid != 4663) return;
        forked = true;

        ordo = new OrdoSwap(WETH, ROUTER, owner, treasury, 1000);
        vm.deal(owner, 100 ether);
        vm.prank(owner);
        ordo.fund{value: 5 ether}();
        vm.deal(user, 1000 ether);

        _pickTiers();
    }

    // ------------------------------------------------------------ helpers

    function _pickTiers() internal {
        uint24[4] memory fees = [uint24(100), 500, 3000, 10000];
        uint256 minBal = type(uint256).max;
        uint256 maxBal = 0;
        for (uint256 i = 0; i < 4; i++) {
            address pool = IFactory(FACTORY).getPool(WETH, USDG, fees[i]);
            if (pool == address(0)) continue;
            uint256 bal = IERC20(WETH).balanceOf(pool);
            if (bal < 1 ether) continue; // too thin to be a real venue
            if (bal < minBal) {
                minBal = bal;
                thin = fees[i];
            }
            if (bal > maxBal) {
                maxBal = bal;
                deep = fees[i];
            }
        }
        require(thin != 0 && deep != 0 && thin != deep, "need two WETH/USDG tiers");
        emit log_named_uint("thin tier", thin);
        emit log_named_uint("deep tier", deep);
    }

    function _path(address a, uint24 fee, address b) internal pure returns (bytes memory) {
        return abi.encodePacked(a, fee, b);
    }

    function _path3(address a, uint24 f1, address b, uint24 f2, address c) internal pure returns (bytes memory) {
        return abi.encodePacked(a, f1, b, f2, c);
    }

    function _none() internal pure returns (OrdoSwap.Reclaim memory) {
        return OrdoSwap.Reclaim({path: "", amountIn: 0, minProfit: 0});
    }

    /// @dev The off-chain search the gateway performs, run here against the
    ///      post-swap state: for a cycle in through `inTier` and out through
    ///      `outTier`, the size that returns the most WETH above what it put in.
    function _bestReclaim(uint24 inTier, uint24 outTier) internal returns (uint256 size, uint256 profit) {
        uint256[6] memory ladder = [uint256(0.05 ether), 0.1 ether, 0.25 ether, 0.5 ether, 1 ether, 2 ether];
        bytes memory cycle = _path3(WETH, inTier, USDG, outTier, WETH);
        for (uint256 i = 0; i < ladder.length; i++) {
            (bool ok, bytes memory ret) =
                QUOTER.call(abi.encodeCall(IQuoterV2.quoteExactInput, (cycle, ladder[i])));
            if (!ok) continue;
            (uint256 out,,,) = abi.decode(ret, (uint256, uint160[], uint32[], uint256));
            if (out > ladder[i] && out - ladder[i] > profit) {
                profit = out - ladder[i];
                size = ladder[i];
            }
        }
    }

    /// @dev A buy of `amount` ETH into USDG on `tier`, from `user`, with the given reclaim.
    function _buy(uint24 tier, uint256 amount, OrdoSwap.Reclaim memory r)
        internal
        returns (uint256 out, uint256 surplus)
    {
        vm.prank(user);
        (out, surplus) = ordo.swap{value: amount}(_path(WETH, tier, USDG), amount, 0, user, false, r);
    }

    // -------------------------------------------------------------- tests

    function test_Fork_SwapWithoutReclaimIsJustASwap() public {
        vm.skip(!forked);
        uint256 floatBefore = ordo.float();

        (uint256 out, uint256 surplus) = _buy(deep, 1 ether, _none());

        assertGt(out, 0, "user received USDG");
        assertEq(IERC20(USDG).balanceOf(user), out, "all of it");
        assertEq(surplus, 0, "no reclaim was asked for");
        assertEq(ordo.float(), floatBefore, "the float was not touched");
        assertEq(address(ordo).balance, 0, "no ETH left behind");
    }

    function test_Fork_ReclaimPaysTheUserAndTheFloatGrows() public {
        vm.skip(!forked);

        // A buy on the thin tier large enough to push it away from the deep one.
        uint256 buy = 20 ether;

        // Find the reclaim the gateway would find: simulate the buy, search, rewind.
        uint256 snap = vm.snapshotState();
        _buy(thin, buy, _none());
        // The buy raised USDG's price on `thin`: buy USDG cheap on `deep`, sell dear on `thin`.
        (uint256 size, uint256 profit) = _bestReclaim(deep, thin);
        vm.revertToState(snap);

        emit log_named_decimal_uint("reclaim size", size, 18);
        emit log_named_decimal_uint("reclaim profit (WETH)", profit, 18);
        assertGt(profit, 0, "a 20 ETH buy on the thin tier opens a cross-tier gap");

        uint256 floatBefore = ordo.float();
        OrdoSwap.Reclaim memory r =
            OrdoSwap.Reclaim({path: _path3(WETH, deep, USDG, thin, WETH), amountIn: size, minProfit: profit / 2});

        vm.expectEmit(true, false, false, false);
        emit OrdoSwap.Reclaimed(user, 0, 0, 0);
        (uint256 out, uint256 surplus) = _buy(thin, buy, r);

        assertGt(out, 0, "the user's swap executed");
        assertEq(IERC20(USDG).balanceOf(user), out, "and paid the user");
        assertGt(surplus, 0, "the reclaim paid the user a surplus");
        assertEq(IERC20(WETH).balanceOf(user), surplus, "in WETH, since the swap was not native-out");
        assertGe(surplus, (profit / 2) * 9000 / 10_000, "at least 90% of the guaranteed minimum");
        assertGt(ordo.float(), floatBefore, "the protocol's 10% stayed in the float");

        emit log_named_decimal_uint("user surplus (WETH)", surplus, 18);
        emit log_named_decimal_uint("float growth (WETH)", ordo.float() - floatBefore, 18);
    }

    function test_Fork_AReclaimThatCannotClearItsMinimumIsSkippedNotFatal() public {
        vm.skip(!forked);
        uint256 floatBefore = ordo.float();

        OrdoSwap.Reclaim memory r = OrdoSwap.Reclaim({
            path: _path3(WETH, deep, USDG, thin, WETH),
            amountIn: 1 ether,
            minProfit: 100 ether // impossible
        });

        vm.expectEmit(true, false, false, false);
        emit OrdoSwap.ReclaimSkipped(user, "");
        (uint256 out, uint256 surplus) = _buy(thin, 20 ether, r);

        assertGt(out, 0, "the swap still went through");
        assertEq(surplus, 0, "no surplus");
        assertEq(ordo.float(), floatBefore, "the float is exactly what it was");
    }

    function test_Fork_ReclaimMustStartAndEndAtWETH() public {
        vm.skip(!forked);
        uint256 floatBefore = ordo.float();

        OrdoSwap.Reclaim memory r =
            OrdoSwap.Reclaim({path: _path(USDG, deep, WETH), amountIn: 1 ether, minProfit: 0});

        (uint256 out, uint256 surplus) = _buy(thin, 1 ether, r);
        assertGt(out, 0);
        assertEq(surplus, 0);
        assertEq(ordo.float(), floatBefore, "a path that is not WETH-closed cannot touch the float");
    }

    function test_Fork_QuoteMatchesWhatExecutionPays() public {
        vm.skip(!forked);
        uint256 buy = 20 ether;

        uint256 snap = vm.snapshotState();
        _buy(thin, buy, _none());
        (uint256 size, uint256 profit) = _bestReclaim(deep, thin);
        vm.revertToState(snap);
        assertGt(profit, 0);

        OrdoSwap.Reclaim memory r =
            OrdoSwap.Reclaim({path: _path3(WETH, deep, USDG, thin, WETH), amountIn: size, minProfit: profit / 2});

        // Quote: always reverts with the answer. The value stands in for the
        // user's input, exactly as the gateway's eth_call attaches it.
        vm.deal(address(this), buy);
        (bool ok, bytes memory ret) =
            address(ordo).call{value: buy}(abi.encodeCall(OrdoSwap.quote, (_path(WETH, thin, USDG), buy, r)));
        assertFalse(ok, "quote reverts by design");
        assertEq(bytes4(ret), OrdoSwap.QuoteResult.selector);
        bytes memory payload = new bytes(ret.length - 4);
        for (uint256 i = 0; i < payload.length; i++) payload[i] = ret[i + 4];
        (uint256 qOut, uint256 qProfit, bytes memory qFail) = abi.decode(payload, (uint256, uint256, bytes));
        assertEq(qFail.length, 0, "the reclaim quoted clean");

        // Execute against the same state.
        (uint256 out, uint256 surplus) = _buy(thin, buy, r);
        assertEq(out, qOut, "quoted output is the executed output");
        assertEq(surplus, qProfit - (qProfit * 1000) / 10_000, "quoted profit minus the protocol share is the surplus");
    }

    function test_Fork_SellSideReclaimPaysNativeETH() public {
        vm.skip(!forked);

        // Give the user USDG first.
        (uint256 usdg,) = _buy(deep, 30 ether, _none());
        vm.prank(user);
        IERC20(USDG).approve(address(ordo), usdg);

        // Selling on the thin tier pushes USDG cheap there: buy cheap on thin, sell on deep.
        uint256 snap = vm.snapshotState();
        vm.prank(user);
        ordo.swap(_path(USDG, thin, WETH), usdg, 0, user, true, _none());
        (uint256 size, uint256 profit) = _bestReclaim(thin, deep);
        vm.revertToState(snap);
        assertGt(profit, 0, "a large sell opens the mirror-image gap");

        OrdoSwap.Reclaim memory r =
            OrdoSwap.Reclaim({path: _path3(WETH, thin, USDG, deep, WETH), amountIn: size, minProfit: profit / 2});

        uint256 ethBefore = user.balance;
        vm.prank(user);
        (uint256 out, uint256 surplus) = ordo.swap(_path(USDG, thin, WETH), usdg, 0, user, true, r);

        assertGt(out, 0);
        assertGt(surplus, 0);
        assertEq(user.balance - ethBefore, out + surplus, "proceeds and surplus both arrived as ETH");
        assertEq(IERC20(WETH).balanceOf(user), 0, "nothing left as WETH");
        assertEq(address(ordo).balance, 0, "the contract holds no ETH between transactions");
    }

    function test_Fork_NativeInMustMatch() public {
        vm.skip(!forked);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(OrdoSwap.ValueMismatch.selector, 2 ether, 1 ether));
        ordo.swap{value: 1 ether}(_path(WETH, deep, USDG), 2 ether, 0, user, false, _none());
    }

    function test_Fork_TheUserCannotSpendTheFloat() public {
        vm.skip(!forked);
        // No value, no WETH held, amountIn asks for the float: transferFrom fails, nothing moves.
        vm.prank(user);
        vm.expectRevert(OrdoSwap.TransferFailed.selector);
        ordo.swap(_path(WETH, deep, USDG), 1 ether, 0, user, false, _none());
    }

    function test_Fork_NobodyElseCanDriveTheFloat() public {
        vm.skip(!forked);
        OrdoSwap.Reclaim memory r =
            OrdoSwap.Reclaim({path: _path3(WETH, deep, USDG, thin, WETH), amountIn: 1 ether, minProfit: 0});
        vm.prank(user);
        vm.expectRevert(OrdoSwap.NotSelf.selector);
        ordo.reclaimFor(user, r, false);
    }

    function test_Fork_OnlyOwnerWithdraws() public {
        vm.skip(!forked);
        vm.prank(user);
        vm.expectRevert(OrdoSwap.NotOwner.selector);
        ordo.withdraw(user, 1 ether);

        uint256 before = treasury.balance;
        vm.prank(owner);
        ordo.withdraw(treasury, 1 ether);
        assertEq(treasury.balance - before, 1 ether);
        assertEq(ordo.float(), 4 ether);
    }

    function test_Fork_ProtocolShareIsCapped() public {
        vm.skip(!forked);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(OrdoSwap.BpsTooHigh.selector, uint16(5001)));
        ordo.setProtocolBps(5001);
    }
}

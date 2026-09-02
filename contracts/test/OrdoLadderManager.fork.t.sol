// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/OrdoLadderManager.sol";

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256);
}

/// Runs against Robinhood Chain state: `forge test --fork-url $RPC --match-contract LadderFork`.
/// Skips itself anywhere else.
contract OrdoLadderManagerForkTest is Test {
    address constant NPM = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant POOL = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca; // WETH/USDG 0.01%
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    OrdoLadderManager mgr;
    address alice = makeAddr("alice");
    address treasury = makeAddr("treasury");
    address whale = makeAddr("whale");

    function setUp() public {
        if (block.chainid != 4663) return;
        mgr = new OrdoLadderManager(NPM, treasury);
        vm.deal(alice, 100 ether);
        vm.deal(whale, 5_000 ether);
        deal(USDG, alice, 1_000_000e6);
        deal(USDG, whale, 50_000_000e6);
    }

    modifier onFork() {
        if (block.chainid != 4663) {
            emit log("skipped: not a Robinhood Chain fork");
            return;
        }
        _;
    }

    function _tick() internal view returns (int24 t) {
        (, t,,,,,) = IUniswapV3Pool(POOL).slot0();
    }

    /// Three rungs straddling the price: one all-USDG below, one mixed around it, one all-WETH above.
    function _rungs(int24 tick) internal pure returns (OrdoLadderManager.Rung[] memory r) {
        r = new OrdoLadderManager.Rung[](3);
        r[0] = OrdoLadderManager.Rung({tickLower: tick - 60, tickUpper: tick - 30, amount0: 0, amount1: 3_000e6, amount0Min: 0, amount1Min: 0});
        r[1] = OrdoLadderManager.Rung({tickLower: tick - 20, tickUpper: tick + 20, amount0: 1 ether, amount1: 3_000e6, amount0Min: 0, amount1Min: 0});
        r[2] = OrdoLadderManager.Rung({tickLower: tick + 30, tickUpper: tick + 60, amount0: 1 ether, amount1: 0, amount0Min: 0, amount1Min: 0});
    }

    function _open() internal returns (uint256 id, int24 tick) {
        tick = _tick();
        vm.startPrank(alice);
        IERC20(USDG).approve(address(mgr), type(uint256).max);
        id = mgr.openLadder{value: 2 ether}(POOL, _rungs(tick), 2, tick - 1000, tick + 1000, block.timestamp + 60);
        vm.stopPrank();
    }

    function _churn() internal {
        // A whale trades back and forth through the range so the bins earn fees.
        vm.startPrank(whale);
        IWETH(WETH).deposit{value: 400 ether}();
        IERC20(WETH).approve(ROUTER, type(uint256).max);
        IERC20(USDG).approve(ROUTER, type(uint256).max);
        ISwapRouter02(ROUTER).exactInputSingle(ISwapRouter02.ExactInputSingleParams(WETH, USDG, 100, whale, 400 ether, 0, 0));
        ISwapRouter02(ROUTER).exactInputSingle(ISwapRouter02.ExactInputSingleParams(USDG, WETH, 100, whale, 900_000e6, 0, 0));
        vm.stopPrank();
    }

    function _liq(uint256 tokenId) internal view returns (uint128 liq) {
        (,,,,,,, liq,,,,) = INonfungiblePositionManager(NPM).positions(tokenId);
    }

    // ------------------------------------------------------------------ open

    function test_open_mintsEveryBinAndRefundsTheRest() public onFork {
        uint256 ethBefore = alice.balance;
        uint256 usdgBefore = IERC20(USDG).balanceOf(alice);
        (uint256 id,) = _open();

        OrdoLadderManager.Ladder memory l = mgr.ladder(id);
        assertEq(l.owner, alice);
        assertEq(l.pool, POOL);
        assertEq(l.shape, 2, "shape stored");
        assertEq(l.bins.length, 3, "three bins");
        assertEq(l.openBins, 3);
        assertEq(l.closedAt, 0);
        assertEq(mgr.laddersOf(alice).length, 1);
        assertGt(l.deposited0, 0, "some WETH went in");
        assertGt(l.deposited1, 0, "some USDG went in");

        // Exactly what the pool took left Alice; the rest came straight back.
        assertEq(ethBefore - alice.balance, l.deposited0, "ETH refund exact");
        assertEq(usdgBefore - IERC20(USDG).balanceOf(alice), l.deposited1, "USDG refund exact");
        assertEq(address(mgr).balance, 0);
        assertEq(IERC20(WETH).balanceOf(address(mgr)), 0);
        assertEq(IERC20(USDG).balanceOf(address(mgr)), 0);

        for (uint256 i = 0; i < 3; i++) {
            assertTrue(l.bins[i].open);
            assertGt(_liq(l.bins[i].tokenId), 0, "bin has liquidity");
        }
    }

    function test_open_refusesIfPriceLeftTheBand() public onFork {
        int24 tick = _tick();
        vm.startPrank(alice);
        IERC20(USDG).approve(address(mgr), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(OrdoLadderManager.PriceOutOfBounds.selector, tick, tick + 100, tick + 200));
        mgr.openLadder{value: 2 ether}(POOL, _rungs(tick), 2, tick + 100, tick + 200, block.timestamp + 60);
        vm.stopPrank();
    }

    function test_open_refusesMisalignedOrOverlappingRungs() public onFork {
        int24 tick = _tick();
        OrdoLadderManager.Rung[] memory r = _rungs(tick);
        r[1].tickLower = tick - 40; // overlaps rung 0's upper (tick - 30)
        vm.startPrank(alice);
        IERC20(USDG).approve(address(mgr), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(OrdoLadderManager.RungsOutOfOrder.selector, 1));
        mgr.openLadder{value: 2 ether}(POOL, r, 2, tick - 1000, tick + 1000, block.timestamp + 60);
        vm.stopPrank();
    }

    // --------------------------------------------------------------- collect

    function test_collect_paysOwner99AndTreasury1() public onFork {
        (uint256 id,) = _open();
        _churn();

        uint256 ethBefore = alice.balance;
        uint256 usdgBefore = IERC20(USDG).balanceOf(alice);
        uint256 tEthBefore = treasury.balance;
        uint256 tUsdgBefore = IERC20(USDG).balanceOf(treasury);

        vm.prank(alice);
        (uint256 o0, uint256 o1) = mgr.collect(id);
        assertTrue(o0 > 0 || o1 > 0, "fees were earned");

        uint256 fees0 = o0 + (treasury.balance - tEthBefore);
        uint256 fees1 = o1 + (IERC20(USDG).balanceOf(treasury) - tUsdgBefore);
        assertEq(treasury.balance - tEthBefore, fees0 / 100, "1% of WETH fees, as ETH");
        assertEq(IERC20(USDG).balanceOf(treasury) - tUsdgBefore, fees1 / 100, "1% of USDG fees");
        assertEq(alice.balance - ethBefore, o0, "owner's WETH fees arrive as native ETH");
        assertEq(IERC20(USDG).balanceOf(alice) - usdgBefore, o1);

        OrdoLadderManager.Ladder memory l = mgr.ladder(id);
        assertEq(l.collected0, o0);
        assertEq(l.collected1, o1);
        assertEq(address(mgr).balance, 0, "nothing sticks to the manager");
    }

    function test_collect_onlyOwner() public onFork {
        (uint256 id,) = _open();
        vm.prank(whale);
        vm.expectRevert(OrdoLadderManager.NotOwner.selector);
        mgr.collect(id);
    }

    // ----------------------------------------------------------------- close

    function test_close_returnsPrincipalWithoutFeeAndBurns() public onFork {
        (uint256 id,) = _open();
        OrdoLadderManager.Ladder memory before = mgr.ladder(id);
        _churn();

        uint256 tEth = treasury.balance;
        uint256 tUsdg = IERC20(USDG).balanceOf(treasury);
        uint256 ethBefore = alice.balance;
        uint256 usdgBefore = IERC20(USDG).balanceOf(alice);

        vm.prank(alice);
        (uint256 p0, uint256 p1) = mgr.close(id);

        assertTrue(p0 > 0 || p1 > 0, "principal returned");
        assertGe(alice.balance - ethBefore, p0, "principal ETH plus net fees");
        assertGe(IERC20(USDG).balanceOf(alice) - usdgBefore, p1);

        // Treasury only ever got a cut of fees, never of principal.
        assertLt(treasury.balance - tEth, before.deposited0 / 100, "treasury cut is far below 1% of principal");
        assertLt(IERC20(USDG).balanceOf(treasury) - tUsdg, before.deposited1 / 100);

        OrdoLadderManager.Ladder memory after_ = mgr.ladder(id);
        assertGt(after_.closedAt, 0, "closed");
        assertEq(after_.openBins, 0);
        assertEq(after_.withdrawn0, p0);
        assertEq(after_.withdrawn1, p1);
        for (uint256 i = 0; i < after_.bins.length; i++) {
            assertFalse(after_.bins[i].open);
            vm.expectRevert();
            INonfungiblePositionManager(NPM).positions(after_.bins[i].tokenId);
        }
        vm.prank(alice);
        vm.expectRevert(OrdoLadderManager.AlreadyClosed.selector);
        mgr.collect(id);
        assertEq(address(mgr).balance, 0);
    }

    function test_closeBins_takesOnlyTheChosenBinsAndTheirFees() public onFork {
        (uint256 id,) = _open();
        _churn();
        uint256 ethBefore = alice.balance;
        uint256 usdgBefore = IERC20(USDG).balanceOf(alice);

        // Take out the all-USDG bin below the price only.
        uint256[] memory idx = new uint256[](1);
        idx[0] = 0;
        vm.prank(alice);
        (uint256 p0, uint256 p1) = mgr.closeBins(id, idx);
        assertTrue(p0 > 0 || p1 > 0, "that bin's principal came back");

        OrdoLadderManager.Ladder memory l = mgr.ladder(id);
        assertEq(l.openBins, 2, "two bins still open");
        assertEq(l.closedAt, 0, "ladder still open");
        assertFalse(l.bins[0].open);
        assertTrue(l.bins[1].open);
        assertTrue(l.bins[2].open);
        assertGt(_liq(l.bins[1].tokenId), 0, "untouched bins keep their liquidity");
        assertGt(_liq(l.bins[2].tokenId), 0);
        vm.expectRevert();
        INonfungiblePositionManager(NPM).positions(l.bins[0].tokenId);

        // Fees came only from that bin: the other bins still have theirs to collect.
        assertGe(alice.balance - ethBefore, p0);
        assertGe(IERC20(USDG).balanceOf(alice) - usdgBefore, p1);
        vm.prank(alice);
        (uint256 o0, uint256 o1) = mgr.collect(id);
        assertTrue(o0 > 0 || o1 > 0, "the bins left behind kept their fees");

        // Closing the same bin twice, or a bin that is not there, is refused.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OrdoLadderManager.BinNotOpen.selector, 0));
        mgr.closeBins(id, idx);
        idx = new uint256[](2);
        idx[0] = 1;
        idx[1] = 1;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OrdoLadderManager.DuplicateBin.selector, 1));
        mgr.closeBins(id, idx);

        // Taking the rest closes the ladder.
        idx[1] = 2;
        vm.prank(alice);
        mgr.closeBins(id, idx);
        l = mgr.ladder(id);
        assertGt(l.closedAt, 0);
        assertEq(l.openBins, 0);
        assertEq(address(mgr).balance, 0);
    }

    function test_closeMany_closesEveryLadderOfTheCaller() public onFork {
        (uint256 a,) = _open();
        (uint256 b,) = _open();
        uint256[] memory ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;

        vm.prank(whale);
        vm.expectRevert(OrdoLadderManager.NotOwner.selector);
        mgr.closeMany(ids);

        vm.prank(alice);
        mgr.closeMany(ids);
        assertGt(mgr.ladder(a).closedAt, 0);
        assertGt(mgr.ladder(b).closedAt, 0);
        assertEq(address(mgr).balance, 0);
    }

    // ------------------------------------------------------------------- add

    function test_addLiquidity_topsUpMatchingBinsAndAppendsNewOnes() public onFork {
        (uint256 id, int24 tick) = _open();
        OrdoLadderManager.Ladder memory before = mgr.ladder(id);
        uint128 liq2Before = _liq(before.bins[2].tokenId);

        // Same ticks as bin 2 (top-up) plus a brand-new bin further up.
        OrdoLadderManager.Rung[] memory r = new OrdoLadderManager.Rung[](2);
        r[0] = OrdoLadderManager.Rung({tickLower: tick + 30, tickUpper: tick + 60, amount0: 0.5 ether, amount1: 0, amount0Min: 0, amount1Min: 0});
        r[1] = OrdoLadderManager.Rung({tickLower: tick + 70, tickUpper: tick + 100, amount0: 0.5 ether, amount1: 0, amount0Min: 0, amount1Min: 0});

        uint256 ethBefore = alice.balance;
        vm.prank(alice);
        (uint256 added0, uint256 added1) = mgr.addLiquidity{value: 1 ether}(id, r, block.timestamp + 60);
        assertGt(added0, 0);
        assertEq(added1, 0);
        assertEq(ethBefore - alice.balance, added0, "only what the pool took left Alice");

        OrdoLadderManager.Ladder memory l = mgr.ladder(id);
        assertEq(l.bins.length, 4, "one new bin");
        assertEq(l.openBins, 4);
        assertEq(l.bins[2].tokenId, before.bins[2].tokenId, "bin 2 is the same position");
        assertGt(_liq(l.bins[2].tokenId), liq2Before, "bin 2 got deeper");
        assertEq(l.bins[3].tickLower, tick + 70);
        assertGt(_liq(l.bins[3].tokenId), 0);
        assertEq(l.deposited0, before.deposited0 + added0, "deposit tally grows");
        assertEq(address(mgr).balance, 0);
    }

    function test_addLiquidity_refusedOnClosedOrForeignLadder() public onFork {
        (uint256 id, int24 tick) = _open();
        OrdoLadderManager.Rung[] memory r = new OrdoLadderManager.Rung[](1);
        r[0] = OrdoLadderManager.Rung({tickLower: tick + 30, tickUpper: tick + 60, amount0: 0.1 ether, amount1: 0, amount0Min: 0, amount1Min: 0});

        vm.deal(whale, 10 ether);
        vm.prank(whale);
        vm.expectRevert(OrdoLadderManager.NotOwner.selector);
        mgr.addLiquidity{value: 0.1 ether}(id, r, block.timestamp + 60);

        vm.prank(alice);
        mgr.close(id);
        vm.prank(alice);
        vm.expectRevert(OrdoLadderManager.AlreadyClosed.selector);
        mgr.addLiquidity{value: 0.1 ether}(id, r, block.timestamp + 60);
    }
}

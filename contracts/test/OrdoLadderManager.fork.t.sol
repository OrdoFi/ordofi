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

    function _mint() internal returns (uint256 id, int24 tick) {
        tick = _tick();
        vm.startPrank(alice);
        IERC20(USDG).approve(address(mgr), type(uint256).max);
        id = mgr.mintLadder{value: 2 ether}(POOL, _rungs(tick), tick - 1000, tick + 1000, block.timestamp + 60);
        vm.stopPrank();
    }

    function test_mintLadder_mintsEveryRungAndRefundsTheRest() public onFork {
        uint256 ethBefore = alice.balance;
        uint256 usdgBefore = IERC20(USDG).balanceOf(alice);
        (uint256 id,) = _mint();

        OrdoLadderManager.Ladder memory l = mgr.ladder(id);
        assertEq(l.owner, alice);
        assertEq(l.pool, POOL);
        assertEq(l.tokenIds.length, 3, "three positions");
        assertEq(mgr.laddersOf(alice).length, 1);
        assertGt(l.deposited0, 0, "some WETH went in");
        assertGt(l.deposited1, 0, "some USDG went in");

        // Exactly what the pool took left Alice; the rest came straight back.
        assertEq(ethBefore - alice.balance, l.deposited0, "ETH refund exact");
        assertEq(usdgBefore - IERC20(USDG).balanceOf(alice), l.deposited1, "USDG refund exact");
        assertEq(address(mgr).balance, 0);
        assertEq(IERC20(WETH).balanceOf(address(mgr)), 0);
        assertEq(IERC20(USDG).balanceOf(address(mgr)), 0);

        // The NFTs are held here, for Alice, not by Alice.
        for (uint256 i = 0; i < 3; i++) {
            (,,,,,,, uint128 liq,,,,) = INonfungiblePositionManager(NPM).positions(l.tokenIds[i]);
            assertGt(liq, 0, "rung has liquidity");
        }
    }

    function test_mintLadder_refusesIfPriceLeftTheBand() public onFork {
        int24 tick = _tick();
        vm.startPrank(alice);
        IERC20(USDG).approve(address(mgr), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(OrdoLadderManager.PriceOutOfBounds.selector, tick, tick + 100, tick + 200));
        mgr.mintLadder{value: 2 ether}(POOL, _rungs(tick), tick + 100, tick + 200, block.timestamp + 60);
        vm.stopPrank();
    }

    function test_mintLadder_refusesMisalignedOrOverlappingRungs() public onFork {
        int24 tick = _tick();
        OrdoLadderManager.Rung[] memory r = _rungs(tick);
        r[1].tickLower = tick - 40; // overlaps rung 0's upper (tick - 30)
        vm.startPrank(alice);
        IERC20(USDG).approve(address(mgr), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(OrdoLadderManager.RungsOutOfOrder.selector, 1));
        mgr.mintLadder{value: 2 ether}(POOL, r, tick - 1000, tick + 1000, block.timestamp + 60);
        vm.stopPrank();
    }

    function _churn() internal {
        // A whale trades back and forth through the range so the rungs earn fees.
        vm.startPrank(whale);
        IWETH(WETH).deposit{value: 400 ether}();
        IERC20(WETH).approve(ROUTER, type(uint256).max);
        IERC20(USDG).approve(ROUTER, type(uint256).max);
        ISwapRouter02(ROUTER).exactInputSingle(ISwapRouter02.ExactInputSingleParams(WETH, USDG, 100, whale, 400 ether, 0, 0));
        ISwapRouter02(ROUTER).exactInputSingle(ISwapRouter02.ExactInputSingleParams(USDG, WETH, 100, whale, 900_000e6, 0, 0));
        vm.stopPrank();
    }

    function test_collect_paysOwner99AndTreasury1() public onFork {
        (uint256 id,) = _mint();
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
        (uint256 id,) = _mint();
        vm.prank(whale);
        vm.expectRevert(OrdoLadderManager.NotOwner.selector);
        mgr.collect(id);
    }

    function test_close_returnsPrincipalWithoutFeeAndBurns() public onFork {
        (uint256 id,) = _mint();
        OrdoLadderManager.Ladder memory before = mgr.ladder(id);
        _churn();

        uint256 tEth = treasury.balance;
        uint256 tUsdg = IERC20(USDG).balanceOf(treasury);
        uint256 ethBefore = alice.balance;
        uint256 usdgBefore = IERC20(USDG).balanceOf(alice);

        vm.prank(alice);
        (uint256 p0, uint256 p1) = mgr.close(id);

        // Principal came back in full (the price moved, so its composition
        // differs, but its combined value is what was deposited plus fees).
        assertTrue(p0 > 0 || p1 > 0, "principal returned");
        uint256 gotEth = alice.balance - ethBefore;
        uint256 gotUsdg = IERC20(USDG).balanceOf(alice) - usdgBefore;
        assertGe(gotEth, p0, "principal ETH plus net fees");
        assertGe(gotUsdg, p1);

        // Treasury only ever got a cut of fees, never of principal.
        uint256 treasuryEth = treasury.balance - tEth;
        uint256 treasuryUsdg = IERC20(USDG).balanceOf(treasury) - tUsdg;
        assertLt(treasuryEth, before.deposited0 / 100, "treasury cut is far below 1% of principal");
        assertLt(treasuryUsdg, before.deposited1 / 100);

        OrdoLadderManager.Ladder memory after_ = mgr.ladder(id);
        assertTrue(after_.closed);
        for (uint256 i = 0; i < after_.tokenIds.length; i++) {
            vm.expectRevert();
            INonfungiblePositionManager(NPM).positions(after_.tokenIds[i]);
        }
        vm.prank(alice);
        vm.expectRevert(OrdoLadderManager.AlreadyClosed.selector);
        mgr.collect(id);
        assertEq(address(mgr).balance, 0);
    }
}

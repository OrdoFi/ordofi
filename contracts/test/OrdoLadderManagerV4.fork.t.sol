// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/OrdoLadderManagerV4.sol";
import {V4TestSwapper} from "./V4TestSwapper.sol";

interface IERC721 {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// Runs against Robinhood Chain state: `forge test --fork-url robinhood --match-contract ManagerV4Fork`.
/// Skips itself anywhere else.
contract OrdoLadderManagerV4ForkTest is Test {
    address constant POSM = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    /// The V4 ETH pool: native ETH / USDG, 0.01%, tick spacing 1, no hook.
    PoolKey ethUsdg = PoolKey({currency0: address(0), currency1: USDG, fee: 100, tickSpacing: 1, hooks: address(0)});

    OrdoLadderManagerV4 mgr;
    V4TestSwapper swapper;
    address alice = makeAddr("alice");
    address treasury = makeAddr("treasury");
    address whale = makeAddr("whale");

    function setUp() public {
        if (block.chainid != 4663) return;
        mgr = new OrdoLadderManagerV4(POSM, STATE_VIEW, treasury);
        swapper = new V4TestSwapper(POOL_MANAGER);
        vm.deal(alice, 100 ether);
        vm.deal(whale, 5_000 ether);
        deal(USDG, alice, 1_000_000e6);
        deal(USDG, whale, 50_000_000e6);
    }

    modifier onFork() {
        // Reported as skipped, not passed: a run without the fork must not look green.
        vm.skip(block.chainid != 4663);
        _;
    }

    function _tick() internal view returns (int24 t) {
        (, t,,) = IStateView(STATE_VIEW).getSlot0(mgr.toId(ethUsdg));
    }

    function _liq(uint256 tokenId) internal view returns (uint128) {
        return IPositionManagerV4(POSM).getPositionLiquidity(tokenId);
    }

    /// Three rungs straddling the price: one all-USDG below, one mixed around it, one all-ETH above.
    function _rungs(int24 tick) internal pure returns (OrdoLadderManagerV4.Rung[] memory r) {
        r = new OrdoLadderManagerV4.Rung[](3);
        r[0] = OrdoLadderManagerV4.Rung({tickLower: tick - 60, tickUpper: tick - 30, amount0: 0, amount1: 3_000e6, amount0Min: 0, amount1Min: 0});
        r[1] = OrdoLadderManagerV4.Rung({tickLower: tick - 20, tickUpper: tick + 20, amount0: 1 ether, amount1: 3_000e6, amount0Min: 0, amount1Min: 0});
        r[2] = OrdoLadderManagerV4.Rung({tickLower: tick + 30, tickUpper: tick + 60, amount0: 1 ether, amount1: 0, amount0Min: 0, amount1Min: 0});
    }

    function _open() internal returns (uint256 id, int24 tick) {
        tick = _tick();
        vm.startPrank(alice);
        IERC20(USDG).approve(address(mgr), type(uint256).max);
        id = mgr.openLadder{value: 2 ether}(ethUsdg, _rungs(tick), 2, tick - 1000, tick + 1000, block.timestamp + 60);
        vm.stopPrank();
    }

    function _churn() internal {
        // A whale trades through the range and back so the bins earn fees.
        vm.startPrank(whale);
        swapper.swapExactIn{value: 50 ether}(ethUsdg, true, 50 ether);
        IERC20(USDG).transfer(address(swapper), 120_000e6);
        swapper.swapExactIn(ethUsdg, false, 120_000e6);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- permit

    bytes32 constant PERMIT_TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function _signPermit(address token, address owner, uint256 key, uint256 value, uint256 deadline) internal view returns (OrdoLadderManagerV4.Permit memory pm) {
        (, bytes memory ds) = token.staticcall(abi.encodeWithSignature("DOMAIN_SEPARATOR()"));
        (, bytes memory n) = token.staticcall(abi.encodeWithSignature("nonces(address)", owner));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", abi.decode(ds, (bytes32)), keccak256(abi.encode(PERMIT_TYPEHASH, owner, address(mgr), value, abi.decode(n, (uint256)), deadline))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        pm = OrdoLadderManagerV4.Permit({token: token, value: value, deadline: deadline, v: v, r: r, s: s});
    }

    function test_openWithPermit_needsNoApproveTransaction() public onFork {
        (address bob, uint256 bobKey) = makeAddrAndKey("bob-permit");
        vm.deal(bob, 10 ether);
        deal(USDG, bob, 100_000e6);
        int24 tick = _tick();
        uint256 deadline = block.timestamp + 600;
        OrdoLadderManagerV4.Permit memory pm = _signPermit(USDG, bob, bobKey, 6_000e6, deadline);
        assertEq(IERC20(USDG).allowance(bob, address(mgr)), 0, "no allowance beforehand");

        vm.prank(bob);
        uint256 id = mgr.openLadderWithPermit{value: 2 ether}(ethUsdg, _rungs(tick), 2, tick - 1000, tick + 1000, deadline, pm);

        OrdoLadderManagerV4.Ladder memory l = mgr.ladder(id);
        assertEq(l.owner, bob);
        assertEq(l.bins.length, 3);
        assertGt(l.deposited1, 0, "USDG was pulled by the permit alone");
        assertEq(IERC20(USDG).balanceOf(address(mgr)), 0, "nothing left in the manager");
    }

    function test_openWithPermit_refusesABadSignature() public onFork {
        (address bob,) = makeAddrAndKey("bob-permit");
        (, uint256 malloryKey) = makeAddrAndKey("mallory");
        vm.deal(bob, 10 ether);
        deal(USDG, bob, 100_000e6);
        int24 tick = _tick();
        uint256 deadline = block.timestamp + 600;
        OrdoLadderManagerV4.Permit memory pm = _signPermit(USDG, bob, malloryKey, 6_000e6, deadline);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(OrdoLadderManagerV4.PermitFailed.selector, USDG));
        mgr.openLadderWithPermit{value: 2 ether}(ethUsdg, _rungs(tick), 2, tick - 1000, tick + 1000, deadline, pm);
    }

    // ------------------------------------------------------------------ open

    function test_open_mintsEveryBinAndRefundsTheRest() public onFork {
        uint256 ethBefore = alice.balance;
        uint256 usdgBefore = IERC20(USDG).balanceOf(alice);
        uint256 posmEthBefore = POSM.balance;
        (uint256 id,) = _open();

        OrdoLadderManagerV4.Ladder memory l = mgr.ladder(id);
        assertEq(l.owner, alice);
        assertEq(l.poolId, mgr.toId(ethUsdg));
        assertEq(l.key.currency1, USDG, "pool key stored");
        assertEq(l.shape, 2, "shape stored");
        assertEq(l.bins.length, 3, "three bins");
        assertEq(l.openBins, 3);
        assertEq(l.closedAt, 0);
        assertEq(mgr.laddersOf(alice).length, 1);
        assertGt(l.deposited0, 0, "some ETH went in");
        assertGt(l.deposited1, 0, "some USDG went in");

        // Exactly what the pool took left Alice; the rest came straight back.
        assertEq(ethBefore - alice.balance, l.deposited0, "ETH refund exact");
        assertEq(usdgBefore - IERC20(USDG).balanceOf(alice), l.deposited1, "USDG refund exact");
        assertEq(address(mgr).balance, 0);
        assertEq(IERC20(USDG).balanceOf(address(mgr)), 0);
        assertEq(POSM.balance, posmEthBefore, "nothing stranded in the PositionManager");

        for (uint256 i = 0; i < 3; i++) {
            assertTrue(l.bins[i].open);
            assertGt(_liq(l.bins[i].tokenId), 0, "bin has liquidity");
            assertEq(IERC721(POSM).ownerOf(l.bins[i].tokenId), address(mgr), "position held by the manager");
        }
        // The all-USDG bin takes its whole budget and the all-ETH bin its whole
        // budget (less a few wei of rounding); the mixed bin takes some of each,
        // bounded by whichever side is worth less at today's price.
        assertGt(l.deposited1, 3_000e6, "rung 0 in full, plus part of rung 1");
        assertLe(l.deposited1, 6_000e6);
        assertGt(l.deposited0, 1 ether - 1_000, "rung 2 in full, plus part of rung 1");
        assertLe(l.deposited0, 2 ether);
    }

    // ------------------------------------------------------- Solady tokens

    /// PROLOGUE: a Solady ERC-20, the base most launchpads on the chain build on.
    /// Its allowance to Permit2 is fixed at infinity and `approve(permit2, x)`
    /// reverts for any other x — the first live V4 pool the UI tried.
    address constant PROLOGUE = 0xb9972CA7188e511174947E3936a5315ac7073277;
    PoolKey ethPrologue = PoolKey({currency0: address(0), currency1: PROLOGUE, fee: 2500, tickSpacing: 25, hooks: address(0)});

    function _prologueTick() internal view returns (int24 t) {
        (, t,,) = IStateView(STATE_VIEW).getSlot0(mgr.toId(ethPrologue));
    }

    /// Solady's storage layout defeats `deal`, so the token is bought in the pool.
    function _buyPrologue(address to, uint256 ethIn) internal {
        vm.deal(address(this), ethIn);
        swapper.swapExactIn{value: ethIn}(ethPrologue, true, ethIn);
        IERC20(PROLOGUE).transfer(to, IERC20(PROLOGUE).balanceOf(address(this)));
    }

    function test_soladyToken_ethOnlyLadderNeedsNoTokenApproval() public onFork {
        // The case the page hit: ETH only, every rung above the price, the token side zero.
        int24 tick = _prologueTick();
        int24 lo = (tick / 25 + 2) * 25;
        OrdoLadderManagerV4.Rung[] memory r = new OrdoLadderManagerV4.Rung[](2);
        r[0] = OrdoLadderManagerV4.Rung({tickLower: lo, tickUpper: lo + 500, amount0: 0.01 ether, amount1: 0, amount0Min: 0, amount1Min: 0});
        r[1] = OrdoLadderManagerV4.Rung({tickLower: lo + 500, tickUpper: lo + 1000, amount0: 0.01 ether, amount1: 0, amount0Min: 0, amount1Min: 0});
        vm.prank(alice);
        uint256 id = mgr.openLadder{value: 0.02 ether}(ethPrologue, r, 0, tick - 5000, tick + 5000, block.timestamp + 60);
        OrdoLadderManagerV4.Ladder memory l = mgr.ladder(id);
        assertEq(l.openBins, 2);
        assertEq(l.deposited1, 0, "no token went in");
        assertGt(l.deposited0, 0.019 ether, "the ETH did");
        assertEq(IERC20(PROLOGUE).allowance(address(mgr), address(mgr.permit2())), type(uint256).max, "Solady: infinite by construction");
    }

    function test_soladyToken_twoSidedLadderMintsCollectsAndCloses() public onFork {
        _buyPrologue(alice, 1 ether);
        uint256 have = IERC20(PROLOGUE).balanceOf(alice);
        assertGt(have, 0, "bought some");
        int24 tick = _prologueTick();
        int24 mid = (tick / 25) * 25;
        OrdoLadderManagerV4.Rung[] memory r = new OrdoLadderManagerV4.Rung[](3);
        r[0] = OrdoLadderManagerV4.Rung({tickLower: mid - 1000, tickUpper: mid - 500, amount0: 0, amount1: have / 3, amount0Min: 0, amount1Min: 0});
        r[1] = OrdoLadderManagerV4.Rung({tickLower: mid - 500, tickUpper: mid + 525, amount0: 0.5 ether, amount1: have / 3, amount0Min: 0, amount1Min: 0});
        r[2] = OrdoLadderManagerV4.Rung({tickLower: mid + 525, tickUpper: mid + 1025, amount0: 0.5 ether, amount1: 0, amount0Min: 0, amount1Min: 0});
        vm.startPrank(alice);
        IERC20(PROLOGUE).approve(address(mgr), type(uint256).max);
        uint256 id = mgr.openLadder{value: 1 ether}(ethPrologue, r, 2, tick - 5000, tick + 5000, block.timestamp + 60);
        vm.stopPrank();
        OrdoLadderManagerV4.Ladder memory l = mgr.ladder(id);
        assertEq(l.openBins, 3);
        assertGt(l.deposited1, 0, "token side settled through Permit2");
        assertEq(have - IERC20(PROLOGUE).balanceOf(alice), l.deposited1, "exactly what the pool took left Alice");
        assertEq(IERC20(PROLOGUE).balanceOf(address(mgr)), 0, "nothing left in the manager");
        // The Permit2 grant to the PositionManager is spent and cleared; only the ERC-20 grant to Permit2 remains.
        (uint160 amt,,) = mgr.permit2().allowance(address(mgr), PROLOGUE, POSM);
        assertEq(amt, 0, "Permit2 allowance cleared");

        // Trade through it, collect, close: the whole life of a ladder on a Solady token.
        vm.deal(whale, 100 ether);
        vm.startPrank(whale);
        swapper.swapExactIn{value: 20 ether}(ethPrologue, true, 20 ether);
        IERC20(PROLOGUE).transfer(address(swapper), IERC20(PROLOGUE).balanceOf(whale));
        swapper.swapExactIn(ethPrologue, false, IERC20(PROLOGUE).balanceOf(address(swapper)));
        vm.stopPrank();
        vm.prank(alice);
        (uint256 f0, uint256 f1) = mgr.collect(id);
        assertTrue(f0 > 0 || f1 > 0, "fees earned");
        uint256 tokBefore = IERC20(PROLOGUE).balanceOf(alice);
        vm.prank(alice);
        mgr.close(id);
        assertGt(IERC20(PROLOGUE).balanceOf(alice), tokBefore, "token side returned");
        assertEq(mgr.ladder(id).openBins, 0);
        assertEq(IERC20(PROLOGUE).balanceOf(address(mgr)), 0);
        assertEq(address(mgr).balance, 0);
    }

    // ------------------------------------------------------- token / USDG pool

    /// CNPY / USDG 3%: a V4 pool with no ETH in it at all. currency0 is the
    /// token, currency1 is USDG, both settle through Permit2, msg.value is zero.
    address constant CNPY = 0x532c5583671870723CEEf573600208aF49c87c54;
    PoolKey cnpyUsdg = PoolKey({currency0: CNPY, currency1: USDG, fee: 30000, tickSpacing: 300, hooks: address(0)});

    function _cnpyTick() internal view returns (int24 t) {
        (, t,,) = IStateView(STATE_VIEW).getSlot0(mgr.toId(cnpyUsdg));
    }

    /// Bought in the pool: a launchpad token's storage layout may defeat `deal`.
    function _buyCnpy(address to, uint256 usdgIn) internal {
        vm.startPrank(whale);
        IERC20(USDG).transfer(address(swapper), usdgIn);
        swapper.swapExactIn(cnpyUsdg, false, usdgIn);
        IERC20(CNPY).transfer(to, IERC20(CNPY).balanceOf(whale));
        vm.stopPrank();
    }

    function test_tokenUsdgPool_bothSidesAreErc20AndNoValueIsSent() public onFork {
        _buyCnpy(alice, 5_000e6);
        uint256 haveTok = IERC20(CNPY).balanceOf(alice);
        uint256 haveUsdg = IERC20(USDG).balanceOf(alice);
        assertGt(haveTok, 0, "bought some");
        int24 tick = _cnpyTick();
        int24 mid = (tick / 300) * 300;
        if (mid > tick) mid -= 300;
        // Below the price only USDG, around it both, above it only the token.
        OrdoLadderManagerV4.Rung[] memory r = new OrdoLadderManagerV4.Rung[](3);
        r[0] = OrdoLadderManagerV4.Rung({tickLower: mid - 6000, tickUpper: mid - 3000, amount0: 0, amount1: 1_000e6, amount0Min: 0, amount1Min: 0});
        r[1] = OrdoLadderManagerV4.Rung({tickLower: mid - 3000, tickUpper: mid + 3300, amount0: haveTok / 2, amount1: 1_000e6, amount0Min: 0, amount1Min: 0});
        r[2] = OrdoLadderManagerV4.Rung({tickLower: mid + 3300, tickUpper: mid + 6300, amount0: haveTok / 2, amount1: 0, amount0Min: 0, amount1Min: 0});
        vm.startPrank(alice);
        IERC20(CNPY).approve(address(mgr), type(uint256).max);
        IERC20(USDG).approve(address(mgr), type(uint256).max);
        uint256 id = mgr.openLadder(cnpyUsdg, r, 2, tick - 30_000, tick + 30_000, block.timestamp + 60);
        vm.stopPrank();
        OrdoLadderManagerV4.Ladder memory l = mgr.ladder(id);
        assertEq(l.openBins, 3);
        assertGt(l.deposited0, 0, "token side went in");
        assertGt(l.deposited1, 0, "USDG side went in");
        assertEq(haveTok - IERC20(CNPY).balanceOf(alice), l.deposited0, "exactly the token the pool took left Alice");
        assertEq(haveUsdg - IERC20(USDG).balanceOf(alice), l.deposited1, "exactly the USDG the pool took left Alice");
        assertEq(IERC20(CNPY).balanceOf(address(mgr)), 0, "no token left in the manager");
        assertEq(IERC20(USDG).balanceOf(address(mgr)), 0, "no USDG left in the manager");
        assertEq(address(mgr).balance, 0);
        (uint160 a0,,) = mgr.permit2().allowance(address(mgr), CNPY, POSM);
        (uint160 a1,,) = mgr.permit2().allowance(address(mgr), USDG, POSM);
        assertEq(a0, 0, "Permit2 grant for the token cleared");
        assertEq(a1, 0, "Permit2 grant for USDG cleared");

        // Trade through it both ways, collect, close.
        vm.startPrank(whale);
        IERC20(USDG).transfer(address(swapper), 30_000e6);
        swapper.swapExactIn(cnpyUsdg, false, 30_000e6);
        IERC20(CNPY).transfer(address(swapper), IERC20(CNPY).balanceOf(whale));
        swapper.swapExactIn(cnpyUsdg, true, IERC20(CNPY).balanceOf(address(swapper)));
        vm.stopPrank();
        vm.prank(alice);
        (uint256 f0, uint256 f1) = mgr.collect(id);
        assertTrue(f0 > 0 || f1 > 0, "fees earned");
        uint256 tokBefore = IERC20(CNPY).balanceOf(alice);
        uint256 usdgBefore = IERC20(USDG).balanceOf(alice);
        vm.prank(alice);
        mgr.close(id);
        assertGt(IERC20(CNPY).balanceOf(alice) + IERC20(USDG).balanceOf(alice), tokBefore + usdgBefore, "principal returned");
        assertEq(mgr.ladder(id).openBins, 0);
        assertEq(IERC20(CNPY).balanceOf(address(mgr)), 0);
        assertEq(IERC20(USDG).balanceOf(address(mgr)), 0);
    }

    function test_tokenUsdgPool_refusesStrayValue() public onFork {
        _buyCnpy(alice, 1_000e6);
        int24 tick = _cnpyTick();
        int24 mid = (tick / 300) * 300;
        if (mid > tick) mid -= 300;
        OrdoLadderManagerV4.Rung[] memory r = new OrdoLadderManagerV4.Rung[](1);
        r[0] = OrdoLadderManagerV4.Rung({tickLower: mid - 3000, tickUpper: mid + 3300, amount0: IERC20(CNPY).balanceOf(alice), amount1: 500e6, amount0Min: 0, amount1Min: 0});
        vm.startPrank(alice);
        IERC20(CNPY).approve(address(mgr), type(uint256).max);
        IERC20(USDG).approve(address(mgr), type(uint256).max);
        vm.expectRevert(OrdoLadderManagerV4.ETHNotAccepted.selector);
        mgr.openLadder{value: 0.1 ether}(cnpyUsdg, r, 0, tick - 30_000, tick + 30_000, block.timestamp + 60);
        vm.stopPrank();
    }

    function test_open_takesExactlyWhatPreviewSaid() public onFork {
        int24 tick = _tick();
        OrdoLadderManagerV4.Rung[] memory r = _rungs(tick);
        (int24 pTick, uint128[] memory liq, uint256[] memory a0, uint256[] memory a1) = mgr.preview(ethUsdg, r);
        assertEq(pTick, tick);
        uint256 sum0;
        uint256 sum1;
        for (uint256 i = 0; i < 3; i++) {
            assertGt(liq[i], 0);
            assertLe(a0[i], r[i].amount0, "never more than the budget");
            assertLe(a1[i], r[i].amount1);
            sum0 += a0[i];
            sum1 += a1[i];
        }
        assertEq(a0[0], 0, "all-USDG rung takes no ETH");
        assertEq(a1[2], 0, "all-ETH rung takes no USDG");

        (uint256 id,) = _open();
        OrdoLadderManagerV4.Ladder memory l = mgr.ladder(id);
        assertEq(l.deposited0, sum0, "the pool took the previewed ETH");
        assertEq(l.deposited1, sum1, "the pool took the previewed USDG");
        for (uint256 i = 0; i < 3; i++) {
            assertEq(_liq(l.bins[i].tokenId), liq[i], "previewed liquidity minted");
        }
    }

    function test_open_refusesIfPriceLeftTheBand() public onFork {
        int24 tick = _tick();
        vm.startPrank(alice);
        IERC20(USDG).approve(address(mgr), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(OrdoLadderManagerV4.PriceOutOfBounds.selector, tick, tick + 100, tick + 200));
        mgr.openLadder{value: 2 ether}(ethUsdg, _rungs(tick), 2, tick + 100, tick + 200, block.timestamp + 60);
        vm.stopPrank();
    }

    function test_open_refusesMisalignedOrOverlappingRungs() public onFork {
        int24 tick = _tick();
        OrdoLadderManagerV4.Rung[] memory r = _rungs(tick);
        r[1].tickLower = tick - 40; // overlaps rung 0's upper (tick - 30)
        vm.startPrank(alice);
        IERC20(USDG).approve(address(mgr), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(OrdoLadderManagerV4.RungsOutOfOrder.selector, 1));
        mgr.openLadder{value: 2 ether}(ethUsdg, r, 2, tick - 1000, tick + 1000, block.timestamp + 60);

        // A pool with spacing 200 refuses ticks off the grid.
        PoolKey memory spaced = PoolKey({currency0: address(0), currency1: USDG, fee: 3000, tickSpacing: 200, hooks: address(0)});
        r = _rungs(tick);
        vm.expectRevert(); // NotAPool or RangeNotAligned, depending on whether that pool exists
        mgr.openLadder{value: 2 ether}(spaced, r, 2, tick - 1000, tick + 1000, block.timestamp + 60);
        vm.stopPrank();
    }

    function test_open_refusesAPoolThatDoesNotExist() public onFork {
        PoolKey memory ghost = PoolKey({currency0: address(0), currency1: USDG, fee: 123, tickSpacing: 1, hooks: address(0)});
        int24 tick = _tick();
        vm.startPrank(alice);
        IERC20(USDG).approve(address(mgr), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(OrdoLadderManagerV4.NotAPool.selector, mgr.toId(ghost)));
        mgr.openLadder{value: 2 ether}(ghost, _rungs(tick), 2, tick - 1000, tick + 1000, block.timestamp + 60);
        vm.stopPrank();
    }

    function test_open_refusesTooLittleETH() public onFork {
        int24 tick = _tick();
        vm.startPrank(alice);
        IERC20(USDG).approve(address(mgr), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(OrdoLadderManagerV4.InsufficientETH.selector, 1 ether, 2 ether));
        mgr.openLadder{value: 1 ether}(ethUsdg, _rungs(tick), 2, tick - 1000, tick + 1000, block.timestamp + 60);
        vm.stopPrank();
    }

    function test_open_honoursSlippageFloors() public onFork {
        int24 tick = _tick();
        OrdoLadderManagerV4.Rung[] memory r = _rungs(tick);
        // Demand more ETH than the all-USDG rung can possibly take.
        r[0].amount0Min = 1;
        vm.startPrank(alice);
        IERC20(USDG).approve(address(mgr), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(OrdoLadderManagerV4.Slippage.selector, 0, 0, _previewed1(r, 0)));
        mgr.openLadder{value: 2 ether}(ethUsdg, r, 2, tick - 1000, tick + 1000, block.timestamp + 60);
        vm.stopPrank();
    }

    function _previewed1(OrdoLadderManagerV4.Rung[] memory r, uint256 i) internal view returns (uint256) {
        (,,, uint256[] memory a1) = mgr.preview(ethUsdg, r);
        return a1[i];
    }

    function test_strayETHIsRefused() public onFork {
        vm.prank(alice);
        (bool ok,) = address(mgr).call{value: 1 ether}("");
        assertFalse(ok, "only the pool and the PositionManager may push ETH in");
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
        assertEq(treasury.balance - tEthBefore, fees0 / 100, "1% of ETH fees");
        assertEq(IERC20(USDG).balanceOf(treasury) - tUsdgBefore, fees1 / 100, "1% of USDG fees");
        assertEq(alice.balance - ethBefore, o0, "owner's ETH fees arrive as ETH");
        assertEq(IERC20(USDG).balanceOf(alice) - usdgBefore, o1);

        OrdoLadderManagerV4.Ladder memory l = mgr.ladder(id);
        assertEq(l.collected0, o0);
        assertEq(l.collected1, o1);
        assertEq(address(mgr).balance, 0, "nothing sticks to the manager");
        assertEq(l.openBins, 3, "collecting leaves every bin in place");
        for (uint256 i = 0; i < 3; i++) {
            assertGt(_liq(l.bins[i].tokenId), 0);
        }

        // Nothing more to collect straight after.
        vm.prank(alice);
        (uint256 again0, uint256 again1) = mgr.collect(id);
        assertEq(again0, 0);
        assertEq(again1, 0);
    }

    function test_collect_onlyOwner() public onFork {
        (uint256 id,) = _open();
        vm.prank(whale);
        vm.expectRevert(OrdoLadderManagerV4.NotOwner.selector);
        mgr.collect(id);
    }

    // ----------------------------------------------------------------- close

    function test_close_returnsPrincipalWithoutFeeAndBurns() public onFork {
        (uint256 id,) = _open();
        OrdoLadderManagerV4.Ladder memory before = mgr.ladder(id);
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

        OrdoLadderManagerV4.Ladder memory after_ = mgr.ladder(id);
        assertGt(after_.closedAt, 0, "closed");
        assertEq(after_.openBins, 0);
        assertEq(after_.withdrawn0, p0);
        assertEq(after_.withdrawn1, p1);
        for (uint256 i = 0; i < after_.bins.length; i++) {
            assertFalse(after_.bins[i].open);
            assertEq(_liq(after_.bins[i].tokenId), 0, "position emptied");
            vm.expectRevert();
            IERC721(POSM).ownerOf(after_.bins[i].tokenId); // burned
        }
        vm.prank(alice);
        vm.expectRevert(OrdoLadderManagerV4.AlreadyClosed.selector);
        mgr.collect(id);
        assertEq(address(mgr).balance, 0);
        assertEq(IERC20(USDG).balanceOf(address(mgr)), 0);
    }

    function test_close_withoutChurnReturnsTheDepositAlmostWhole() public onFork {
        (uint256 id,) = _open();
        OrdoLadderManagerV4.Ladder memory before = mgr.ladder(id);
        uint256 ethBefore = alice.balance;
        uint256 usdgBefore = IERC20(USDG).balanceOf(alice);
        vm.prank(alice);
        (uint256 p0, uint256 p1) = mgr.close(id);
        // Rounding in the pool's favour on the way in and out costs a few wei per bin, nothing more.
        assertApproxEqAbs(p0, before.deposited0, 10, "ETH principal back");
        assertApproxEqAbs(p1, before.deposited1, 10, "USDG principal back");
        assertEq(alice.balance - ethBefore, p0);
        assertEq(IERC20(USDG).balanceOf(alice) - usdgBefore, p1);
        assertEq(treasury.balance, 0, "no fees, no cut");
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

        OrdoLadderManagerV4.Ladder memory l = mgr.ladder(id);
        assertEq(l.openBins, 2, "two bins still open");
        assertEq(l.closedAt, 0, "ladder still open");
        assertFalse(l.bins[0].open);
        assertTrue(l.bins[1].open);
        assertTrue(l.bins[2].open);
        assertGt(_liq(l.bins[1].tokenId), 0, "untouched bins keep their liquidity");
        assertGt(_liq(l.bins[2].tokenId), 0);
        vm.expectRevert();
        IERC721(POSM).ownerOf(l.bins[0].tokenId);

        // Fees came only from that bin: the other bins still have theirs to collect.
        assertGe(alice.balance - ethBefore, p0);
        assertGe(IERC20(USDG).balanceOf(alice) - usdgBefore, p1);
        vm.prank(alice);
        (uint256 o0, uint256 o1) = mgr.collect(id);
        assertTrue(o0 > 0 || o1 > 0, "the bins left behind kept their fees");

        // Closing the same bin twice, or a bin that is not there, is refused.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OrdoLadderManagerV4.BinNotOpen.selector, 0));
        mgr.closeBins(id, idx);
        idx = new uint256[](2);
        idx[0] = 1;
        idx[1] = 1;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OrdoLadderManagerV4.DuplicateBin.selector, 1));
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
        vm.expectRevert(OrdoLadderManagerV4.NotOwner.selector);
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
        OrdoLadderManagerV4.Ladder memory before = mgr.ladder(id);
        uint128 liq2Before = _liq(before.bins[2].tokenId);

        // Same ticks as bin 2 (top-up) plus a brand-new bin further up.
        OrdoLadderManagerV4.Rung[] memory r = new OrdoLadderManagerV4.Rung[](2);
        r[0] = OrdoLadderManagerV4.Rung({tickLower: tick + 30, tickUpper: tick + 60, amount0: 0.5 ether, amount1: 0, amount0Min: 0, amount1Min: 0});
        r[1] = OrdoLadderManagerV4.Rung({tickLower: tick + 70, tickUpper: tick + 100, amount0: 0.5 ether, amount1: 0, amount0Min: 0, amount1Min: 0});

        uint256 ethBefore = alice.balance;
        vm.prank(alice);
        (uint256 added0, uint256 added1) = mgr.addLiquidity{value: 1 ether}(id, r, block.timestamp + 60);
        assertGt(added0, 0);
        assertEq(added1, 0);
        assertEq(ethBefore - alice.balance, added0, "only what the pool took left Alice");

        OrdoLadderManagerV4.Ladder memory l = mgr.ladder(id);
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
        OrdoLadderManagerV4.Rung[] memory r = new OrdoLadderManagerV4.Rung[](1);
        r[0] = OrdoLadderManagerV4.Rung({tickLower: tick + 30, tickUpper: tick + 60, amount0: 0.1 ether, amount1: 0, amount0Min: 0, amount1Min: 0});

        vm.prank(whale);
        vm.expectRevert(OrdoLadderManagerV4.NotOwner.selector);
        mgr.addLiquidity{value: 0.1 ether}(id, r, block.timestamp + 60);

        vm.prank(alice);
        mgr.close(id);
        vm.prank(alice);
        vm.expectRevert(OrdoLadderManagerV4.AlreadyClosed.selector);
        mgr.addLiquidity{value: 0.1 ether}(id, r, block.timestamp + 60);
    }

    // ------------------------------------------------------------ full size

    function test_open_fortyBinsFitInOneTransaction() public onFork {
        int24 tick = _tick();
        OrdoLadderManagerV4.Rung[] memory r = new OrdoLadderManagerV4.Rung[](40);
        for (uint256 i = 0; i < 40; i++) {
            int24 lo = tick - 400 + int24(int256(i)) * 20;
            bool below = lo + 20 <= tick;
            bool above = lo > tick;
            r[i] = OrdoLadderManagerV4.Rung({
                tickLower: lo,
                tickUpper: lo + 20,
                amount0: above || !below ? 0.05 ether : 0,
                amount1: below || !above ? 150e6 : 0,
                amount0Min: 0,
                amount1Min: 0
            });
        }
        vm.startPrank(alice);
        IERC20(USDG).approve(address(mgr), type(uint256).max);
        uint256 gasBefore = gasleft();
        uint256 id = mgr.openLadder{value: 2 ether}(ethUsdg, r, 1, tick - 1000, tick + 1000, block.timestamp + 60);
        uint256 used = gasBefore - gasleft();
        vm.stopPrank();
        emit log_named_uint("gas: open 40 bins", used);
        OrdoLadderManagerV4.Ladder memory l = mgr.ladder(id);
        assertEq(l.bins.length, 40);
        assertLt(used, 20_000_000, "forty bins stay well inside a block");
        _churn();
        gasBefore = gasleft();
        vm.prank(alice);
        mgr.close(id);
        emit log_named_uint("gas: close 40 bins", gasBefore - gasleft());
        assertGt(mgr.ladder(id).closedAt, 0);
        assertEq(address(mgr).balance, 0);
    }
}

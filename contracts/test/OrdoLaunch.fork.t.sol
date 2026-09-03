// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {OrdoLadderManagerV4, IERC20} from "../src/OrdoLadderManagerV4.sol";
import {OrdoStakeFactoryV4, OrdoStakeVaultV4, OrdoStakeZapV4, OrdoStakeFarm} from "../src/OrdoStakesV4.sol";
import {PoolKey, IStateView} from "../src/V4Common.sol";
import {V4TestSwapper} from "./V4TestSwapper.sol";

interface IPoolManagerInit {
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick);
}

/// The path $ORDO takes on the pools page, run against the contracts already
/// deployed on Robinhood Chain: create the plain ETH pool at the launchpad
/// pool's price, seed it through OrdoLadderManagerV4, attach a stake with
/// OrdoStakeFactoryV4, zap ETH into the stake, trade through it, harvest,
/// withdraw. `forge test --fork-url robinhood --match-contract OrdoLaunchFork`.
contract OrdoLaunchForkTest is Test {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant ORDO = 0xFE2f0fB0C00d19786A8ABf98d4B1f1AC8763b167;
    /// The launchpad pool ORDO trades in today: hooked, hook-set fee.
    address constant LAUNCH_HOOK = 0xcf8f482e998d18793414d10c9Fc48fC8277Ab8CC;
    PoolKey launch = PoolKey({currency0: address(0), currency1: ORDO, fee: 0x800000, tickSpacing: 200, hooks: LAUNCH_HOOK});
    /// The pool the page creates: plain, 1%, spacing 200.
    PoolKey plain = PoolKey({currency0: address(0), currency1: ORDO, fee: 10000, tickSpacing: 200, hooks: address(0)});

    OrdoLadderManagerV4 mgr = OrdoLadderManagerV4(payable(0x2B0E53c9f869dE1Fe7C5b43ABAaBaa90e23C073b));
    OrdoStakeFactoryV4 factory = OrdoStakeFactoryV4(0x9a4A6420C027a0BAFA0A55464196cf5D966122D2);
    V4TestSwapper swapper;
    address team = makeAddr("team");
    address holder = makeAddr("holder");
    address trader = makeAddr("trader");

    modifier onFork() {
        vm.skip(block.chainid != 4663);
        _;
    }

    function setUp() public {
        if (block.chainid != 4663) return;
        swapper = new V4TestSwapper(POOL_MANAGER);
        vm.deal(team, 100 ether);
        vm.deal(holder, 10 ether);
        vm.deal(trader, 100 ether);
    }

    /// ORDO bought in the launchpad pool, as anyone would get it.
    function _buyOrdo(address to, uint256 ethIn) internal {
        vm.deal(address(this), ethIn);
        swapper.swapExactIn{value: ethIn}(launch, true, ethIn);
        IERC20(ORDO).transfer(to, IERC20(ORDO).balanceOf(address(this)));
    }

    function test_ordo_poolLadderStakeLifecycle() public onFork {
        // 1. The pool does not exist yet; create it at the launchpad's price.
        bytes32 plainId = mgr.toId(plain);
        (uint160 before,,,) = IStateView(STATE_VIEW).getSlot0(plainId);
        assertEq(before, 0, "no plain ETH pool yet");
        (uint160 launchSqrt, int24 launchTick,,) = IStateView(STATE_VIEW).getSlot0(mgr.toId(launch));
        assertGt(launchSqrt, 0, "the launchpad pool has a price");
        vm.prank(team);
        int24 tick = IPoolManagerInit(POOL_MANAGER).initialize(plain, launchSqrt);
        assertEq(tick, launchTick, "opens at the same price");

        // 2. Seed it: a two-sided ladder through the deployed manager.
        _buyOrdo(team, 5 ether);
        uint256 ordoHave = IERC20(ORDO).balanceOf(team);
        assertGt(ordoHave, 0, "team holds ORDO");
        int24 mid = (tick / 200) * 200;
        if (mid > tick) mid -= 200;
        OrdoLadderManagerV4.Rung[] memory r = new OrdoLadderManagerV4.Rung[](3);
        // Ticks count ORDO per ETH: below the price a range holds only currency1 (ORDO), above it only currency0 (ETH).
        r[0] = OrdoLadderManagerV4.Rung({tickLower: mid - 4000, tickUpper: mid - 2000, amount0: 0, amount1: ordoHave / 2, amount0Min: 0, amount1Min: 0});
        r[1] = OrdoLadderManagerV4.Rung({tickLower: mid - 2000, tickUpper: mid + 2200, amount0: 3 ether, amount1: ordoHave / 2, amount0Min: 0, amount1Min: 0});
        r[2] = OrdoLadderManagerV4.Rung({tickLower: mid + 2200, tickUpper: mid + 4200, amount0: 3 ether, amount1: 0, amount0Min: 0, amount1Min: 0});
        vm.startPrank(team);
        IERC20(ORDO).approve(address(mgr), type(uint256).max);
        uint256 id = mgr.openLadder{value: 6 ether}(plain, r, 2, tick - 20_000, tick + 20_000, block.timestamp + 60);
        vm.stopPrank();
        OrdoLadderManagerV4.Ladder memory l = mgr.ladder(id);
        assertEq(l.openBins, 3, "three bins minted");
        assertGt(l.deposited0, 0);
        assertGt(l.deposited1, 0);
        assertGt(IStateView(STATE_VIEW).getLiquidity(plainId), 0, "the pool now holds liquidity");

        // 3. A stake on the new pool, from the deployed factory.
        (address v, address f) = factory.createStake(plain);
        OrdoStakeVaultV4 vault = OrdoStakeVaultV4(payable(v));
        OrdoStakeFarm farm = OrdoStakeFarm(f);
        OrdoStakeZapV4 zap = factory.zap();
        assertEq(vault.token(), ORDO);

        // 4. A holder puts ETH in with one transaction and is staked.
        vm.prank(holder);
        uint256 shares = zap.zapETH{value: 1 ether}(address(vault), 0);
        assertGt(shares, 0, "shares minted");
        assertEq(farm.balanceOf(holder), shares, "and staked in the farm");

        // 5. Trade through the pool both ways; the ladder and the stake earn.
        vm.startPrank(trader);
        swapper.swapExactIn{value: 4 ether}(plain, true, 4 ether);
        IERC20(ORDO).transfer(address(swapper), IERC20(ORDO).balanceOf(trader));
        swapper.swapExactIn(plain, false, IERC20(ORDO).balanceOf(address(swapper)));
        vm.stopPrank();
        vm.prank(team);
        (uint256 f0, uint256 f1) = mgr.collect(id);
        assertTrue(f0 > 0 || f1 > 0, "the ladder collected fees");
        vault.harvest();

        // 6. Everyone gets out whole.
        vm.startPrank(holder);
        farm.withdraw(shares);
        (uint256 ethOut, uint256 tokOut) = vault.withdraw(shares, 0, 0, holder);
        vm.stopPrank();
        assertTrue(ethOut > 0 || tokOut > 0, "the holder's deposit comes back");
        uint256 teamEth = team.balance;
        vm.prank(team);
        mgr.close(id);
        assertGt(team.balance, teamEth, "the team's ETH side comes back");
        assertEq(mgr.ladder(id).openBins, 0);
        assertEq(IERC20(ORDO).balanceOf(address(mgr)), 0, "nothing stuck in the manager");
        assertEq(address(mgr).balance, 0);
    }

    function test_ordo_factoryRefusesTheHookedPool() public onFork {
        vm.expectRevert(OrdoStakeFactoryV4.HookedPool.selector);
        factory.createStake(launch);
    }
}

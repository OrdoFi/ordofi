// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/OrdoStakesV4.sol";
import {V4TestSwapper} from "./V4TestSwapper.sol";

/// Runs against Robinhood Chain state: `forge test --fork-url robinhood --match-contract StakesV4Fork`.
contract OrdoStakesV4ForkTest is Test {
    address constant POSM = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    /// The V4 ETH pool: native ETH / USDG, 0.01%, tick spacing 1, no hook.
    PoolKey ethUsdg = PoolKey({currency0: address(0), currency1: USDG, fee: 100, tickSpacing: 1, hooks: address(0)});

    OrdoStakeFactoryV4 factory;
    OrdoStakeVaultV4 vault;
    OrdoStakeFarm farm;
    OrdoStakeZapV4 zap;
    V4TestSwapper swapper;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address whale = makeAddr("whale");

    // Reported as skipped, not passed: a run without the fork must not look green.
    modifier onFork() {
        vm.skip(block.chainid != 4663);
        _;
    }

    function setUp() public {
        if (block.chainid != 4663) return;
        factory = new OrdoStakeFactoryV4(POSM, STATE_VIEW, treasury);
        (address v, address f) = factory.createStake(ethUsdg);
        vault = OrdoStakeVaultV4(payable(v));
        farm = OrdoStakeFarm(f);
        zap = factory.zap();
        swapper = new V4TestSwapper(POOL_MANAGER);
        vm.deal(alice, 50 ether);
        vm.deal(bob, 50 ether);
        vm.deal(whale, 3_000 ether);
        deal(USDG, whale, 50_000_000e6);
    }

    function _churn() internal {
        vm.startPrank(whale);
        swapper.swapExactIn{value: 50 ether}(ethUsdg, true, 50 ether);
        IERC20(USDG).transfer(address(swapper), 120_000e6);
        swapper.swapExactIn(ethUsdg, false, 120_000e6);
        vm.stopPrank();
    }

    function _tick() internal view returns (int24 t) {
        (, t,,) = IStateView(STATE_VIEW).getSlot0(vault.poolId());
    }

    // --------------------------------------------------------------- factory

    function test_factory_createsOncePerPoolAndOnlyForHooklessEthPools() public onFork {
        assertEq(factory.stakeCount(), 1);
        OrdoStakeFactoryV4.Stake memory s = factory.stakeForPool(vault.poolId());
        assertEq(s.token, USDG);
        assertEq(s.vault, address(vault));
        assertEq(s.farm, address(farm));
        assertEq(vault.farm(), address(farm));
        assertEq(farm.vault(), address(vault));
        assertEq(address(farm.rewardsToken()), WETH, "rewards stream as WETH");
        assertEq(vault.symbol(), "osUSDG");
        assertEq(vault.token(), USDG);
        assertEq(vault.tickLower(), -887272);
        assertEq(vault.tickUpper(), 887272);
        assertEq(address(vault.weth()), WETH);

        vm.expectRevert(OrdoStakeFactoryV4.StakeExists.selector);
        factory.createStake(ethUsdg);

        vm.expectRevert(OrdoStakeFactoryV4.NotAnEthPool.selector);
        factory.createStake(PoolKey(WETH, USDG, 3000, 60, address(0)));

        // A launchpad pool behind a hook: refused, whatever the hook does.
        vm.expectRevert(OrdoStakeFactoryV4.HookedPool.selector);
        factory.createStake(PoolKey(address(0), 0xDFa07c165d41AA538af6174924575eBc2f0B4c35, 0, 200, 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044));

        vm.expectRevert(OrdoStakeFactoryV4.NotAPool.selector);
        factory.createStake(PoolKey(address(0), USDG, 123, 1, address(0)));

        // Only the factory may use its deployer.
        OrdoStakeDeployerV4 dep = factory.deployer();
        vm.expectRevert(OrdoStakeDeployerV4.NotFactory.selector);
        dep.deploy(POSM, STATE_VIEW, ethUsdg, treasury, "X", WETH, address(0));
    }

    function test_factory_fullRangeFollowsTheTickSpacing() public onFork {
        // ETH / 0x1C1D…, 0.9%, spacing 90, no hook: a full range must sit on the 90 grid.
        PoolKey memory key = PoolKey(address(0), 0x1C1DAEF0300551aDBfbE403e7d567b6c5aFF566f, 9000, 90, address(0));
        (address v,) = factory.createStake(key);
        OrdoStakeVaultV4 other = OrdoStakeVaultV4(payable(v));
        assertEq(other.tickLower(), -887220);
        assertEq(other.tickUpper(), 887220);
        assertEq(factory.stakeCount(), 2);
        vm.prank(alice);
        uint256 shares = zap.zapETH{value: 0.5 ether}(v, 0);
        assertGt(shares, 0, "a stake on a second pool takes deposits too");
        assertGt(other.liquidity(), 0);
    }

    // -------------------------------------------------------- Solady tokens

    /// PROLOGUE is a Solady ERC-20: its allowance to Permit2 is fixed at infinity
    /// and `approve(permit2, x)` reverts for anything else. Most launchpad tokens
    /// on the chain share that base, so a stake must work on one end to end.
    address constant PROLOGUE = 0xb9972CA7188e511174947E3936a5315ac7073277;

    function test_soladyToken_stakeLifecycle() public onFork {
        PoolKey memory key = PoolKey(address(0), PROLOGUE, 2500, 25, address(0));
        (address v,) = factory.createStake(key);
        OrdoStakeVaultV4 pv = OrdoStakeVaultV4(payable(v));

        // ETH in, half swapped for the token inside the zap: the token side reaches the PositionManager through Permit2.
        vm.prank(alice);
        uint256 shares = zap.zapETH{value: 1 ether}(v, 0);
        assertGt(shares, 0);
        assertGt(pv.liquidity(), 0);
        assertEq(IERC20(PROLOGUE).balanceOf(v), 0, "vault keeps no token");
        assertEq(IERC20(PROLOGUE).balanceOf(address(zap)), 0, "zap keeps no token");

        // Token in: bought in the pool since Solady's storage layout defeats `deal`.
        vm.deal(address(this), 1 ether);
        swapper.swapExactIn{value: 1 ether}(key, true, 1 ether);
        uint256 have = IERC20(PROLOGUE).balanceOf(address(this));
        IERC20(PROLOGUE).transfer(bob, have);
        vm.startPrank(bob);
        IERC20(PROLOGUE).approve(address(zap), type(uint256).max);
        uint256 shares2 = zap.zapToken(v, have, 0);
        vm.stopPrank();
        assertGt(shares2, 0, "token deposit staked");
        assertEq(IERC20(PROLOGUE).balanceOf(address(zap)), 0);

        // Fees accrue, harvest sells nothing until the reference has aged, then withdraw pays both sides.
        vm.deal(whale, 100 ether);
        vm.startPrank(whale);
        swapper.swapExactIn{value: 10 ether}(key, true, 10 ether);
        IERC20(PROLOGUE).transfer(address(swapper), IERC20(PROLOGUE).balanceOf(whale));
        swapper.swapExactIn(key, false, IERC20(PROLOGUE).balanceOf(address(swapper)));
        vm.stopPrank();
        vm.warp(block.timestamp + 700);
        pv.harvest();
        OrdoStakeFarm pf = OrdoStakeFarm(pv.farm());
        vm.startPrank(alice);
        pf.withdraw(shares);
        uint256 ethBefore = alice.balance;
        uint256 tokBefore = IERC20(PROLOGUE).balanceOf(alice);
        pv.withdraw(shares, 0, 0, alice);
        vm.stopPrank();
        assertGt(alice.balance, ethBefore, "ETH side back");
        assertGt(IERC20(PROLOGUE).balanceOf(alice), tokBefore, "token side back");
        // Token fees wait in the vault until the reference is old enough to sell against; ETH never waits.
        assertEq(address(v).balance, 0);
    }

    // ------------------------------------------------------------------ zap

    function test_zapETH_endsStakedInOneTransaction() public onFork {
        uint256 ethBefore = alice.balance;
        vm.prank(alice);
        uint256 shares = zap.zapETH{value: 1 ether}(address(vault), 0);
        assertGt(shares, 0, "shares minted");
        assertEq(vault.balanceOf(alice), 0, "shares are not in the wallet");
        assertEq(farm.balanceOf(alice), shares, "they are staked in the farm");
        assertEq(vault.balanceOf(address(farm)), shares);
        assertGt(vault.liquidity(), 0, "the vault holds a live position");
        assertTrue(vault.tokenId() != 0);
        assertEq(vault.balanceOf(address(zap)), 0);
        assertEq(address(zap).balance, 0, "zap keeps nothing");
        assertEq(IERC20(USDG).balanceOf(address(zap)), 0);
        assertEq(address(vault).balance, 0, "vault keeps no ETH");
        assertEq(IERC20(USDG).balanceOf(address(vault)), 0, "vault keeps no USDG");
        // Dust came back: Alice spent less than or equal to 1 ETH, and most of it went in.
        assertLe(ethBefore - alice.balance, 1 ether);
        assertGt(ethBefore - alice.balance, 0.9 ether, "most of it went in");
    }

    function test_deposit_pullsExactlyWhatThePositionTakes() public onFork {
        deal(USDG, alice, 100_000e6);
        (uint128 liq, uint256 pEth, uint256 pTok) = vault.previewDeposit(1 ether, 10_000e6);
        assertGt(liq, 0);
        uint256 ethBefore = alice.balance;
        uint256 usdgBefore = IERC20(USDG).balanceOf(alice);
        vm.startPrank(alice);
        IERC20(USDG).approve(address(vault), type(uint256).max);
        (uint256 shares, uint256 usedEth, uint256 usedTok) = vault.deposit{value: 1 ether}(10_000e6, 0, 0, alice);
        vm.stopPrank();
        assertEq(usedEth, pEth, "ETH as previewed");
        assertEq(usedTok, pTok, "USDG as previewed");
        assertEq(ethBefore - alice.balance, usedEth, "only the ETH the position took left Alice");
        assertEq(usdgBefore - IERC20(USDG).balanceOf(alice), usedTok, "only the USDG the position took was pulled");
        assertEq(vault.balanceOf(alice), shares);
        assertEq(vault.liquidity(), liq);
        assertEq(shares, uint256(liq) - vault.MIN_SHARES(), "first depositor: liquidity less the locked floor");
        assertEq(address(vault).balance, 0);
        assertEq(IERC20(USDG).balanceOf(address(vault)), 0);

        // Slippage floors bind on what the position takes.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OrdoStakeVaultV4.Slippage.selector, usedEth, usedTok));
        vault.deposit{value: 1 ether}(10_000e6, uint128(usedEth + 1), 0, alice);
    }

    // -------------------------------------------------------------- harvest

    function test_harvest_streamsEthFeesAsWethAndSellsTokenFeesOnceTheReferenceHasAged() public onFork {
        vm.prank(alice);
        zap.zapETH{value: 5 ether}(address(vault), 0);
        (, uint40 at, bool usable) = vault.referencePrice();
        assertEq(at, block.timestamp, "the deposit recorded a reference");
        assertFalse(usable, "but it is too young to be used");
        _churn();

        // Harvest #1, same block: the ETH side streams, the USDG side waits.
        uint256 tBefore = IERC20(WETH).balanceOf(treasury);
        uint256 fBefore = IERC20(WETH).balanceOf(address(farm));
        vault.harvest();
        uint256 toTreasury = IERC20(WETH).balanceOf(treasury) - tBefore;
        uint256 toFarm = IERC20(WETH).balanceOf(address(farm)) - fBefore;
        assertGt(toFarm, 0, "ETH fees were earned and streamed");
        assertEq(toTreasury, (toFarm + toTreasury) / 100, "1% of the ETH");
        assertGt(farm.rewardRate(), 0);
        assertEq(farm.periodFinish(), block.timestamp + 7 days);
        uint256 held = IERC20(USDG).balanceOf(address(vault));
        assertGt(held, 0, "USDG fees wait for a reference");
        assertEq(address(vault).balance, 0, "no ETH sits in the vault");

        // Rewards accrue to the staker over time and can be claimed as WETH.
        vm.warp(block.timestamp + 1 days);
        uint256 e = farm.earned(alice);
        assertGt(e, 0);
        assertApproxEqRel(e, toFarm / 7, 0.02e18, "a seventh after a day");
        vm.prank(alice);
        farm.getReward();
        assertEq(IERC20(WETH).balanceOf(alice), e);

        // Harvest #2, a day later: the reference is old enough to use. It dates
        // from before the churn, though, and the churn may have moved the price
        // by more than the 3% band; then the sale waits once more while this
        // harvest records the settled price. Harvest #3 a window later sells
        // against that, and the price has not moved since.
        (,, usable) = vault.referencePrice();
        assertTrue(usable);
        fBefore = IERC20(WETH).balanceOf(address(farm));
        vault.harvest();
        vm.warp(block.timestamp + 11 minutes);
        vault.harvest();
        assertEq(IERC20(USDG).balanceOf(address(vault)), 0, "USDG fees sold");
        assertGt(IERC20(WETH).balanceOf(address(farm)) - fBefore, 0, "and streamed as WETH");
        assertEq(address(vault).balance, 0);

        // Compounding: the WETH just claimed goes straight back in through the zap.
        uint256 stakedBefore = farm.balanceOf(alice);
        vm.startPrank(alice);
        IERC20(WETH).approve(address(zap), e);
        uint256 more = zap.zapWETH(address(vault), e, 0);
        vm.stopPrank();
        assertGt(more, 0);
        assertEq(farm.balanceOf(alice), stakedBefore + more);
        assertEq(IERC20(WETH).balanceOf(alice), 0, "all of it went in");
    }

    function test_harvest_refusesToSellTokenFeesIntoAPushedPrice() public onFork {
        vm.prank(alice);
        zap.zapETH{value: 5 ether}(address(vault), 0);
        _churn();
        vault.harvest(); // ETH side streamed; USDG held, reference too young
        uint256 held = IERC20(USDG).balanceOf(address(vault));
        assertGt(held, 0);
        vm.warp(block.timestamp + 20 minutes);

        // A sandwich: ETH is bought up 10%+ against USDG right before the harvest,
        // so the vault's USDG would fetch far less ETH than the reference says.
        // (Tick is log-price of USDG per ETH, so dearer ETH means a higher tick.)
        int24 before = _tick();
        vm.startPrank(whale);
        IERC20(USDG).transfer(address(swapper), 600_000e6);
        swapper.swapExactIn(ethUsdg, false, 600_000e6);
        vm.stopPrank();
        assertGt(_tick(), before + 900, "price moved by well over 3%");

        uint256 fBefore = IERC20(WETH).balanceOf(address(farm));
        vault.harvest();
        // The push itself paid the pool USDG fees, part of which are now the vault's; none was sold.
        assertGe(IERC20(USDG).balanceOf(address(vault)), held, "the sale was skipped, the USDG stays");
        assertEq(IERC20(WETH).balanceOf(address(farm)), fBefore, "nothing streamed from a bad sale");
    }

    // ------------------------------------------------------------- withdraw

    function test_withdraw_returnsBothSidesProRata() public onFork {
        vm.prank(alice);
        uint256 sa = zap.zapETH{value: 2 ether}(address(vault), 0);
        vm.prank(bob);
        uint256 sb = zap.zapETH{value: 2 ether}(address(vault), 0);
        assertApproxEqRel(sa, sb, 0.02e18, "same deposit, same shares");
        // Bob leaves entirely: farm → wallet, then vault → coins.
        vm.startPrank(bob);
        farm.withdraw(sb);
        assertEq(vault.balanceOf(bob), sb);
        uint256 ethBefore = bob.balance;
        uint256 usdgBefore = IERC20(USDG).balanceOf(bob); // the zap's USDG dust
        (uint256 a0, uint256 a1) = vault.withdraw(sb, 0, 0, bob);
        vm.stopPrank();
        assertTrue(a0 > 0 && a1 > 0, "both sides came back");
        assertEq(bob.balance - ethBefore, a0, "his ETH half as native ETH");
        assertGt(a0, 0.9 ether);
        assertEq(IERC20(USDG).balanceOf(bob) - usdgBefore, a1, "his USDG half");
        assertEq(vault.balanceOf(bob), 0);
        assertEq(vault.totalSupply(), sa + vault.MIN_SHARES(), "Alice's shares and the locked floor are all that is left");
        assertGt(vault.liquidity(), 0);
        assertEq(address(vault).balance, 0);
    }

    function test_withdraw_honoursFloors() public onFork {
        vm.prank(alice);
        uint256 s = zap.zapETH{value: 2 ether}(address(vault), 0);
        vm.startPrank(alice);
        farm.withdraw(s);
        vm.expectRevert(); // the PositionManager's MinimumAmountInsufficient
        vault.withdraw(s, uint128(5 ether), 0, alice);
        vm.stopPrank();
        assertEq(vault.balanceOf(alice), s, "nothing moved");
    }

    // ------------------------------------------------------------- position

    /// V4's PositionManager only lets the owner (or an approved operator) touch
    /// a position, so the third-party top-up V3 allowed — and the share
    /// inflation it enabled — does not exist here.
    function test_vault_positionCannotBeTouchedByStrangers() public onFork {
        vm.prank(alice);
        zap.zapETH{value: 1 ether}(address(vault), 0);
        uint256 id = vault.tokenId();
        deal(USDG, whale, 1_000_000e6);
        vm.startPrank(whale);
        bytes memory actions = abi.encodePacked(V4Actions.INCREASE_LIQUIDITY, V4Actions.SETTLE_PAIR);
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(id, uint256(1e12), type(uint128).max, type(uint128).max, bytes(""));
        params[1] = abi.encode(address(0), USDG);
        vm.expectRevert();
        IPositionManagerV4(POSM).modifyLiquidities{value: 1 ether}(abi.encode(actions, params), block.timestamp);
        actions = abi.encodePacked(V4Actions.DECREASE_LIQUIDITY, V4Actions.TAKE_PAIR);
        params[0] = abi.encode(id, uint256(0), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(address(0), USDG, whale);
        vm.expectRevert();
        IPositionManagerV4(POSM).modifyLiquidities(abi.encode(actions, params), block.timestamp);
        vm.stopPrank();
    }

    function test_firstDeposit_locksAFloorAndRefusesDust() public onFork {
        deal(USDG, alice, 100_000e6);
        vm.startPrank(alice);
        IERC20(USDG).approve(address(vault), type(uint256).max);
        // A wei of ETH buys no liquidity at all...
        vm.expectRevert(OrdoStakeVaultV4.NothingIn.selector);
        vault.deposit{value: 1}(100, 0, 0, alice);
        // ...a few cents buy some, but not enough to clear the floor...
        vm.expectRevert(OrdoStakeVaultV4.FirstDepositTooSmall.selector);
        vault.deposit{value: 1e13}(40_000, 0, 0, alice);
        // ...and the smallest accepted deposit leaves a supply of at least MIN_SHARES.
        (uint256 shares,,) = vault.deposit{value: 0.0001 ether}(1e6, 0, 0, alice);
        vm.stopPrank();
        assertGt(shares, 0);
        assertEq(vault.balanceOf(vault.DEAD()), vault.MIN_SHARES(), "floor locked forever");
        assertEq(vault.totalSupply(), shares + vault.MIN_SHARES());
    }

    /// Once everyone has left the supply is the floor, never zero, so the next
    /// deposit is priced like any other.
    function test_vault_worksAfterEveryoneLeaves() public onFork {
        vm.prank(alice);
        uint256 s = zap.zapETH{value: 1 ether}(address(vault), 0);
        vm.startPrank(alice);
        farm.withdraw(s);
        vault.withdraw(s, 0, 0, alice);
        vm.stopPrank();
        assertEq(vault.totalSupply(), vault.MIN_SHARES(), "only the floor remains");
        assertTrue(vault.tokenId() != 0);
        assertGt(vault.liquidity(), 0, "the floor's liquidity stays in the pool");

        vm.prank(bob);
        uint256 again = zap.zapETH{value: 1 ether}(address(vault), 0);
        assertGt(again, 0, "deposits still work");
        uint256 ethBefore = bob.balance;
        vm.startPrank(bob);
        farm.withdraw(again);
        vault.withdraw(again, 0, 0, bob);
        vm.stopPrank();
        assertGt(bob.balance - ethBefore, 0.45 ether, "his ETH half came back");
    }

    /// Shares minted to, or coins paid to, the zero address are lost to everyone.
    function test_vault_refusesZeroRecipient() public onFork {
        deal(USDG, alice, 10_000e6);
        vm.startPrank(alice);
        IERC20(USDG).approve(address(vault), type(uint256).max);
        vm.expectRevert(OrdoStakeVaultV4.ZeroAddress.selector);
        vault.deposit{value: 1 ether}(2_000e6, 0, 0, address(0));
        vm.stopPrank();

        vm.prank(bob);
        uint256 s = zap.zapETH{value: 1 ether}(address(vault), 0);
        vm.startPrank(bob);
        farm.withdraw(s);
        vm.expectRevert(OrdoStakeVaultV4.ZeroAddress.selector);
        vault.withdraw(s, 0, 0, address(0));
        vm.expectRevert(Shares.ZeroRecipient.selector);
        vault.transfer(address(0), s);
        vm.stopPrank();
        assertEq(vault.balanceOf(bob), s, "nothing moved");
    }

    function test_zapToken_andZapBoth() public onFork {
        deal(USDG, alice, 10_000e6);
        vm.startPrank(alice);
        IERC20(USDG).approve(address(zap), type(uint256).max);
        uint256 s1 = zap.zapToken(address(vault), 4_000e6, 0);
        assertGt(s1, 0);
        uint256 s2 = zap.zapBoth{value: 0.5 ether}(address(vault), 2_000e6);
        assertGt(s2, 0);
        vm.stopPrank();
        assertEq(farm.balanceOf(alice), s1 + s2);
        assertEq(IERC20(USDG).balanceOf(address(zap)), 0);
        assertEq(address(zap).balance, 0);
        // zapBoth with 0.5 ETH against 2,000 USDG: whichever side was worth less went
        // in whole and the other side's remainder came back, so Alice still holds USDG or ETH.
        assertTrue(IERC20(USDG).balanceOf(alice) > 0 || alice.balance > 49 ether);
    }

    function test_zap_honoursMinOut() public onFork {
        vm.prank(alice);
        vm.expectPartialRevert(V4Swap.SwapMinOut.selector);
        zap.zapETH{value: 1 ether}(address(vault), type(uint256).max);
    }

    bytes32 constant PERMIT_TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function _permitFor(address owner, uint256 key, uint256 value, uint256 deadline) internal view returns (OrdoStakeZapV4.Permit memory pm) {
        (, bytes memory ds) = USDG.staticcall(abi.encodeWithSignature("DOMAIN_SEPARATOR()"));
        (, bytes memory n) = USDG.staticcall(abi.encodeWithSignature("nonces(address)", owner));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", abi.decode(ds, (bytes32)), keccak256(abi.encode(PERMIT_TYPEHASH, owner, address(zap), value, abi.decode(n, (uint256)), deadline))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        pm = OrdoStakeZapV4.Permit({value: value, deadline: deadline, v: v, r: r, s: s});
    }

    function test_zapWithPermit_tokenAndBoth_needNoApprove() public onFork {
        (address carol, uint256 carolKey) = makeAddrAndKey("carol");
        vm.deal(carol, 10 ether);
        deal(USDG, carol, 10_000e6);
        assertEq(IERC20(USDG).allowance(carol, address(zap)), 0, "no allowance beforehand");
        uint256 deadline = block.timestamp + 600;

        // Permits are signed before pranking: signing reads the token, and a read would consume the prank.
        OrdoStakeZapV4.Permit memory p1 = _permitFor(carol, carolKey, 4_000e6, deadline);
        vm.prank(carol);
        uint256 s1 = zap.zapTokenWithPermit(address(vault), 4_000e6, 0, p1);
        assertGt(s1, 0, "token zap by permit");
        OrdoStakeZapV4.Permit memory p2 = _permitFor(carol, carolKey, 2_000e6, deadline);
        vm.prank(carol);
        uint256 s2 = zap.zapBothWithPermit{value: 0.5 ether}(address(vault), 2_000e6, p2);
        assertGt(s2, 0, "both zap by permit");
        assertEq(farm.balanceOf(carol), s1 + s2);
        assertEq(IERC20(USDG).balanceOf(address(zap)), 0);

        // A signature by someone else over Carol's account is refused before anything moves.
        (, uint256 malloryKey) = makeAddrAndKey("mallory");
        OrdoStakeZapV4.Permit memory bad = _permitFor(carol, malloryKey, 1_000e6, deadline);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(OrdoStakeZapV4.PermitFailed.selector, USDG));
        zap.zapTokenWithPermit(address(vault), 1_000e6, 0, bad);
    }

    function test_vault_refusesRandomETH() public onFork {
        vm.prank(alice);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertFalse(ok);
    }

    // ------------------------------------------------- gen 2: compound, zap out

    /// Rewards accrue to Alice while Bob trades; compound puts them back as
    /// staked shares in one call, with nothing taken and nothing left behind.
    function test_compound_restakesRewardsInOneCallWithNothingTaken() public onFork {
        vm.prank(alice);
        uint256 shares = zap.zapETH{value: 2 ether}(address(vault), 0);
        _churn();
        vault.harvest();
        vm.warp(block.timestamp + 3 days);
        uint256 earned = farm.earned(alice);
        assertGt(earned, 0, "rewards streamed");
        // The deposit inside the compound harvests the vault, and a harvest pays
        // the treasury its 1% of *pool* fees regardless. Measure that on a
        // snapshot so the compound itself can be shown to take nothing.
        uint256 snap = vm.snapshotState();
        uint256 tBefore = IERC20(WETH).balanceOf(treasury) + treasury.balance;
        vault.harvest();
        uint256 harvestCut = IERC20(WETH).balanceOf(treasury) + treasury.balance - tBefore;
        vm.revertToState(snap);
        uint256 tAll = IERC20(WETH).balanceOf(treasury) + treasury.balance;
        uint256 aEth = alice.balance;

        // The farm pays out exactly what was earned — to the zap, not to Alice.
        vm.expectEmit(true, false, false, true, address(farm));
        emit OrdoStakeFarm.RewardPaid(alice, earned);
        vm.prank(alice);
        uint256 more = farm.compound(0);
        assertGt(more, 0, "new shares");
        assertEq(farm.balanceOf(alice), shares + more, "staked on top of the old ones");
        assertEq(farm.earned(alice), 0, "rewards spent");
        // Treasury saw at most the harvest's cut plus 1% of the fee the compound's own swap paid the pool: nothing from the rewards.
        assertLe(IERC20(WETH).balanceOf(treasury) + treasury.balance - tAll, harvestCut + earned / 100, "nothing taken from the rewards themselves");
        assertGe(alice.balance, aEth, "Alice paid nothing (dust, if any, came back to her)");
        assertEq(IERC20(WETH).balanceOf(address(zap)), 0);
        assertEq(address(zap).balance, 0);
        assertEq(IERC20(USDG).balanceOf(address(zap)), 0);
        assertEq(vault.balanceOf(address(zap)), 0);
        assertEq(farm.GENERATION(), 2);
        assertEq(farm.zap(), address(zap));

        vm.prank(alice);
        vm.expectRevert(OrdoStakeFarm.ZeroAmount.selector);
        farm.compound(0);
    }

    function test_zapOut_unstakesAndRedeemsToBothCoinsInOneCall() public onFork {
        vm.prank(alice);
        uint256 sa = zap.zapETH{value: 2 ether}(address(vault), 0);
        vm.prank(bob);
        uint256 sb = zap.zapETH{value: 2 ether}(address(vault), 0);
        _churn();
        vault.harvest();
        vm.warp(block.timestamp + 1 days);
        uint256 rewards = farm.earned(bob);
        assertGt(rewards, 0);

        uint256 ethBefore = bob.balance;
        uint256 tokBefore = IERC20(USDG).balanceOf(bob);
        uint256 wethBefore = IERC20(WETH).balanceOf(bob);
        vm.prank(bob);
        (uint256 ethOut, uint256 tokOut) = zap.zapOut(address(vault), sb, 0, 0);
        assertTrue(ethOut > 0 && tokOut > 0, "both sides came back");
        assertEq(bob.balance - ethBefore, ethOut, "the ETH side as native ETH");
        assertEq(IERC20(USDG).balanceOf(bob) - tokBefore, tokOut);
        assertEq(IERC20(WETH).balanceOf(bob) - wethBefore, rewards, "pending rewards paid along the way");
        assertEq(farm.balanceOf(bob), 0, "unstaked");
        assertEq(vault.balanceOf(bob), 0, "and redeemed, no shares left in the wallet");
        assertEq(vault.balanceOf(address(zap)), 0);
        assertEq(farm.balanceOf(alice), sa, "Alice untouched");
        assertGt(ethOut, 0.9 ether, "his ETH half");

        // Only the zap may unstake for someone.
        vm.prank(bob);
        vm.expectRevert(OrdoStakeFarm.NotZap.selector);
        farm.withdrawFor(alice, 1);
        // And it only works for the caller's own shares.
        vm.prank(bob);
        vm.expectRevert();
        zap.zapOut(address(vault), 1, 0, 0);
    }

    function test_zapOutToETH_leavesToEthOnlyAndHonoursTheFloor() public onFork {
        vm.prank(alice);
        uint256 sa = zap.zapETH{value: 2 ether}(address(vault), 0);
        uint256 half = sa / 2;
        uint256 ethBefore = alice.balance;
        uint256 tokBefore = IERC20(USDG).balanceOf(alice);

        vm.prank(alice);
        vm.expectRevert();
        zap.zapOutToETH(address(vault), half, 100 ether);

        vm.prank(alice);
        uint256 out = zap.zapOutToETH(address(vault), half, 0.9 ether);
        assertEq(alice.balance - ethBefore, out, "everything came back as ETH");
        assertGt(out, 0.9 ether, "about half of what went in, less the swap's fee");
        assertLt(out, 1.05 ether);
        assertEq(IERC20(USDG).balanceOf(alice), tokBefore, "no token");
        assertEq(farm.balanceOf(alice), sa - half, "the other half is still staked");
        assertEq(vault.balanceOf(address(zap)), 0);
        assertEq(address(zap).balance, 0);
        assertEq(IERC20(USDG).balanceOf(address(zap)), 0);
        assertEq(IERC20(WETH).balanceOf(address(zap)), 0);
    }
}

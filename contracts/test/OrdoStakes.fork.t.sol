// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/OrdoStakes.sol";

/// Runs against Robinhood Chain state: `forge test --fork-url $RPC --match-contract OrdoStakesFork`.
contract OrdoStakesForkTest is Test {
    address constant NPM = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant POOL = 0x62AB521f71431f78ac374CdbadC6cda3c8916b6C; // NVDA/WETH 0.05%

    OrdoStakeFactory factory;
    OrdoStakeVault vault;
    OrdoStakeFarm farm;
    OrdoStakeZap zap;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address whale = makeAddr("whale");

    // Reported as skipped, not passed: a run without the fork must not look green.
    modifier onFork() { vm.skip(block.chainid != 4663); _; }

    function setUp() public {
        if (block.chainid != 4663) return;
        factory = new OrdoStakeFactory(NPM, ROUTER, treasury);
        (address v, address f) = factory.createStake(POOL);
        vault = OrdoStakeVault(payable(v));
        farm = OrdoStakeFarm(f);
        zap = factory.zap();
        vm.deal(alice, 50 ether);
        vm.deal(bob, 50 ether);
        vm.deal(whale, 3_000 ether);
    }

    function _churn() internal {
        vm.startPrank(whale);
        IWETH(WETH).deposit{value: 60 ether}();
        IERC20(WETH).approve(ROUTER, type(uint256).max);
        IERC20(NVDA).approve(ROUTER, type(uint256).max);
        ISwapRouter02(ROUTER).exactInputSingle(ISwapRouter02.ExactInputSingleParams(WETH, NVDA, 500, whale, 30 ether, 0, 0));
        ISwapRouter02(ROUTER).exactInputSingle(ISwapRouter02.ExactInputSingleParams(NVDA, WETH, 500, whale, IERC20(NVDA).balanceOf(whale), 0, 0));
        vm.stopPrank();
    }

    function test_factory_createsOncePerPoolAndOnlyForEthPools() public onFork {
        assertEq(factory.stakeCount(), 1);
        OrdoStakeFactory.Stake memory s = factory.stakeForPool(POOL);
        assertEq(s.token, NVDA);
        assertEq(s.vault, address(vault));
        assertEq(s.farm, address(farm));
        assertEq(vault.farm(), address(farm));
        assertEq(farm.vault(), address(vault));
        assertEq(vault.symbol(), "osNVDA");
        vm.expectRevert(OrdoStakeFactory.StakeExists.selector);
        factory.createStake(POOL);
        vm.expectRevert(OrdoStakeFactory.NotAnEthPool.selector);
        factory.createStake(0xB944cec30Bd4175855215D767ADC81F39e5f7E2B); // NVDA/USDG 0.3%
        vm.expectRevert(OrdoStakeFactory.NotAPool.selector);
        factory.createStake(address(vault));
    }

    function test_zapETH_endsStakedInOneTransaction() public onFork {
        uint256 ethBefore = alice.balance;
        vm.prank(alice);
        uint256 shares = zap.zapETH{value: 1 ether}(address(vault), 0);
        assertGt(shares, 0, "shares minted");
        assertEq(vault.balanceOf(alice), 0, "shares are not in the wallet");
        assertEq(farm.balanceOf(alice), shares, "they are staked in the farm");
        assertEq(vault.balanceOf(address(farm)), shares);
        assertGt(vault.liquidity(), 0, "the vault holds a live position");
        assertEq(vault.balanceOf(address(zap)), 0);
        assertEq(address(zap).balance, 0, "zap keeps nothing");
        assertEq(IERC20(WETH).balanceOf(address(zap)), 0);
        assertEq(IERC20(NVDA).balanceOf(address(zap)), 0);
        // Dust came back: Alice spent less than or equal to 1 ETH.
        assertLe(ethBefore - alice.balance, 1 ether);
        assertGt(ethBefore - alice.balance, 0.9 ether, "most of it went in");
    }

    function test_harvest_streamsWethToFarmAndOnePercentToTreasury() public onFork {
        vm.prank(alice);
        zap.zapETH{value: 5 ether}(address(vault), 0);
        _churn();
        uint256 tBefore = IERC20(WETH).balanceOf(treasury);
        uint256 fBefore = IERC20(WETH).balanceOf(address(farm));
        vault.harvest();
        uint256 toTreasury = IERC20(WETH).balanceOf(treasury) - tBefore;
        uint256 toFarm = IERC20(WETH).balanceOf(address(farm)) - fBefore;
        assertGt(toFarm, 0, "fees were earned and streamed");
        assertEq(toTreasury, (toFarm + toTreasury) / 100, "1% of the WETH");
        assertGt(farm.rewardRate(), 0);
        assertEq(farm.periodFinish(), block.timestamp + 7 days);
        // Rewards accrue to the staker over time and can be claimed as WETH.
        vm.warp(block.timestamp + 1 days);
        uint256 e = farm.earned(alice);
        assertGt(e, 0);
        assertApproxEqRel(e, toFarm / 7, 0.02e18, "a seventh after a day");
        vm.prank(alice);
        farm.getReward();
        assertEq(IERC20(WETH).balanceOf(alice), e);
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

    function test_withdraw_returnsBothTokensProRata() public onFork {
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
        (uint256 a0, uint256 a1) = vault.withdraw(sb, 0, 0, bob);
        vm.stopPrank();
        assertTrue(a0 > 0 && a1 > 0, "both sides came back");
        assertGt(bob.balance - ethBefore, 0.9 ether, "his ETH half as native ETH");
        assertGt(IERC20(NVDA).balanceOf(bob), 0, "his NVDA half");
        assertEq(vault.balanceOf(bob), 0);
        assertEq(vault.totalSupply(), sa + vault.MIN_SHARES(), "Alice's shares and the locked floor are all that is left");
        assertGt(vault.liquidity(), 0);
    }

    function _buyNvda(address who, uint256 ethIn) internal returns (uint256 got) {
        vm.startPrank(who);
        IWETH(WETH).deposit{value: ethIn}();
        IERC20(WETH).approve(ROUTER, type(uint256).max);
        got = ISwapRouter02(ROUTER).exactInputSingle(ISwapRouter02.ExactInputSingleParams(WETH, NVDA, 500, who, ethIn, 0, 0));
        vm.stopPrank();
    }

    /// Uniswap's position manager lets anyone add liquidity to any tokenId. Done to
    /// the vault's position it changes what a share is worth without minting any.
    function _donate(address who, uint256 wethAmt, uint256 nvdaAmt) internal returns (uint128 liq) {
        vm.startPrank(who);
        IWETH(WETH).deposit{value: wethAmt}();
        IERC20(WETH).approve(NPM, type(uint256).max);
        IERC20(NVDA).approve(NPM, type(uint256).max);
        bool weth0 = vault.wethIs0();
        (liq,,) = INonfungiblePositionManager(NPM).increaseLiquidity(
            INonfungiblePositionManager.IncreaseLiquidityParams(vault.tokenId(), weth0 ? wethAmt : nvdaAmt, weth0 ? nvdaAmt : wethAmt, 0, 0, block.timestamp)
        );
        vm.stopPrank();
    }

    /// First-depositor inflation: a dust first deposit, a donation through the
    /// position manager, then a victim whose shares round down. With the locked
    /// floor the supply is never small enough for the rounding to matter.
    function test_firstDepositor_cannotInflateSharesAgainstLaterDepositors() public onFork {
        address attacker = makeAddr("attacker");
        vm.deal(attacker, 100 ether);
        _buyNvda(attacker, 3 ether);
        vm.startPrank(attacker);
        IERC20(NVDA).approve(address(vault), type(uint256).max);
        // A few wei of each side is now refused outright...
        vm.expectRevert(OrdoStakeVault.FirstDepositTooSmall.selector);
        vault.deposit{value: 1}(0, 100, 0, 0, attacker);
        // ...and the smallest deposit that is accepted leaves a supply of at least MIN_SHARES.
        (uint256 attackerShares,,) = vault.deposit{value: 0.0001 ether}(0, IERC20(NVDA).balanceOf(attacker) / 1000, 0, 0, attacker);
        vm.stopPrank();
        assertEq(vault.balanceOf(vault.DEAD()), vault.MIN_SHARES(), "floor locked forever");
        assertGe(vault.totalSupply(), vault.MIN_SHARES());

        uint128 donated = _donate(attacker, 1 ether, IERC20(NVDA).balanceOf(attacker) / 2);
        assertGt(donated, 0);
        uint128 liqBefore = vault.liquidity();

        uint256 victimShares;
        {
            vm.prank(bob);
            victimShares = zap.zapETH{value: 1 ether}(address(vault), 0);
        }
        uint256 victimLiq = uint256(vault.liquidity() - liqBefore);
        uint256 victimClaim = (uint256(vault.liquidity()) * victimShares) / vault.totalSupply();
        uint256 attackerClaim = (uint256(vault.liquidity()) * attackerShares) / vault.totalSupply();
        // The victim's rounding loss is bounded by one share's worth of liquidity: negligible.
        assertGe(victimClaim, victimLiq - victimLiq / 100_000, "victim keeps what they deposited (within 0.001%)");
        assertLe(attackerClaim, attackerShares + donated + donated / 100_000, "the attacker gains nothing from the donation");
    }

    /// Once everyone has left, a dust donation used to make every later deposit
    /// compute zero shares and revert forever. The locked floor means the supply
    /// never returns to zero, so the donation is simply shared out.
    function test_vault_survivesDonationAfterEveryoneLeaves() public onFork {
        vm.prank(alice);
        uint256 s = zap.zapETH{value: 1 ether}(address(vault), 0);
        vm.startPrank(alice);
        farm.withdraw(s);
        vault.withdraw(s, 0, 0, alice);
        vm.stopPrank();
        assertEq(vault.totalSupply(), vault.MIN_SHARES(), "only the floor remains");
        assertTrue(vault.tokenId() != 0);

        address attacker = makeAddr("attacker");
        vm.deal(attacker, 10 ether);
        _buyNvda(attacker, 0.01 ether);
        _donate(attacker, 0.0001 ether, IERC20(NVDA).balanceOf(attacker));

        vm.prank(bob);
        uint256 again = zap.zapETH{value: 1 ether}(address(vault), 0);
        assertGt(again, 0, "deposits still work");
        // Bob can leave with what he put in, up to the tiny dust rounding.
        uint256 ethBefore = bob.balance;
        vm.startPrank(bob);
        farm.withdraw(again);
        vault.withdraw(again, 0, 0, bob);
        vm.stopPrank();
        assertGt(bob.balance - ethBefore, 0.45 ether, "his ETH half came back");
    }

    /// Shares minted to, or coins paid to, the zero address are lost to everyone.
    function test_vault_refusesZeroRecipient() public onFork {
        _buyNvda(alice, 1 ether);
        vm.startPrank(alice);
        IERC20(NVDA).approve(address(vault), type(uint256).max);
        uint256 n = IERC20(NVDA).balanceOf(alice);
        bool weth0 = vault.wethIs0();
        vm.expectRevert(OrdoStakeVault.ZeroAddress.selector);
        vault.deposit{value: 1 ether}(weth0 ? 0 : n, weth0 ? n : 0, 0, 0, address(0));
        vm.stopPrank();

        vm.prank(bob);
        uint256 s = zap.zapETH{value: 1 ether}(address(vault), 0);
        vm.startPrank(bob);
        farm.withdraw(s);
        vm.expectRevert(OrdoStakeVault.ZeroAddress.selector);
        vault.withdraw(s, 0, 0, address(0));
        vm.expectRevert(Shares.ZeroRecipient.selector);
        vault.transfer(address(0), s);
        vm.stopPrank();
        assertEq(vault.balanceOf(bob), s, "nothing moved");
    }

    function test_zapToken_andZapBoth() public onFork {
        // Give Alice NVDA by buying some.
        vm.startPrank(alice);
        IWETH(WETH).deposit{value: 2 ether}();
        IERC20(WETH).approve(ROUTER, type(uint256).max);
        ISwapRouter02(ROUTER).exactInputSingle(ISwapRouter02.ExactInputSingleParams(WETH, NVDA, 500, alice, 1 ether, 0, 0));
        uint256 nvda = IERC20(NVDA).balanceOf(alice);
        IERC20(NVDA).approve(address(zap), type(uint256).max);
        uint256 s1 = zap.zapToken(address(vault), nvda / 2, 0);
        assertGt(s1, 0);
        uint256 s2 = zap.zapBoth{value: 0.5 ether}(address(vault), nvda / 4);
        assertGt(s2, 0);
        vm.stopPrank();
        assertEq(farm.balanceOf(alice), s1 + s2);
        assertEq(IERC20(NVDA).balanceOf(address(zap)), 0);
        assertEq(IERC20(WETH).balanceOf(address(zap)), 0);
    }

    function test_vault_refusesRandomETH() public onFork {
        vm.prank(alice);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertFalse(ok);
    }
}

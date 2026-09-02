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

    modifier onFork() { if (block.chainid != 4663) { emit log("skipped: not a Robinhood Chain fork"); return; } _; }

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
        assertEq(vault.totalSupply(), sa, "Alice's shares are all that is left");
        assertGt(vault.liquidity(), 0);
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

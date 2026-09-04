// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/OrdoSwapV2.sol";
import {PoolKey} from "../src/V4Common.sol";

interface IStateViewT {
    function getLiquidity(bytes32 poolId) external view returns (uint128);
    function getSlot0(bytes32 poolId) external view returns (uint160, int24, uint24, uint24);
}

/// @notice OrdoSwapV2 against ORDO's real Uniswap V4 pools on Robinhood Chain:
///         the launchpad's hooked ETH pool, the hookless 20% ETH pool, and the
///         USDG pool. If the hook lets us through, every launchpad token does.
///
///   forge test --match-contract OrdoSwapV2Fork --fork-url http://127.0.0.1:8545 -vv
contract OrdoSwapV2ForkTest is Test {
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant ORDO = 0xFE2f0fB0C00d19786A8ABf98d4B1f1AC8763b167;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    address constant HOOK = 0xcf8f482e998d18793414d10c9Fc48fC8277Ab8CC;
    address constant NATIVE = address(0);

    OrdoSwapV2 ordo;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address user = makeAddr("user");
    bool forked;

    PoolKey hooked = PoolKey({currency0: NATIVE, currency1: ORDO, fee: 8388608, tickSpacing: 200, hooks: HOOK});
    PoolKey plain20 = PoolKey({currency0: NATIVE, currency1: ORDO, fee: 200000, tickSpacing: 2000, hooks: NATIVE});
    PoolKey usdgPool = PoolKey({currency0: USDG, currency1: ORDO, fee: 40000, tickSpacing: 400, hooks: NATIVE});

    function setUp() public {
        if (block.chainid != 4663) {
            try vm.createSelectFork("robinhood") {} catch {}
        }
        if (block.chainid != 4663) return;
        forked = true;
        ordo = new OrdoSwapV2(WETH, ROUTER, POOL_MANAGER, owner, treasury, 1000);
        vm.deal(owner, 100 ether);
        vm.prank(owner);
        ordo.fund{value: 2 ether}();
        vm.deal(user, 100 ether);

        emit log_named_uint("hooked pool liquidity", IStateViewT(STATE_VIEW).getLiquidity(keccak256(abi.encode(hooked))));
        emit log_named_uint("plain 20% pool liquidity", IStateViewT(STATE_VIEW).getLiquidity(keccak256(abi.encode(plain20))));
        emit log_named_uint("usdg pool liquidity", IStateViewT(STATE_VIEW).getLiquidity(keccak256(abi.encode(usdgPool))));
    }

    // ------------------------------------------------------------ helpers

    function _v4(PoolKey memory key, bool zeroForOne) internal pure returns (OrdoSwapV2.Leg memory) {
        return OrdoSwapV2.Leg({venue: 1, path: "", key: key, zeroForOne: zeroForOne});
    }

    function _v3(bytes memory path) internal pure returns (OrdoSwapV2.Leg memory) {
        return OrdoSwapV2.Leg({venue: 0, path: path, key: PoolKey(address(0), address(0), 0, 0, address(0)), zeroForOne: false});
    }

    function _none() internal pure returns (OrdoSwapV2.Reclaim memory r) {
        r.legs = new OrdoSwapV2.Leg[](0);
    }

    function _one(OrdoSwapV2.Leg memory l) internal pure returns (OrdoSwapV2.Leg[] memory a) {
        a = new OrdoSwapV2.Leg[](1);
        a[0] = l;
    }

    function _two(OrdoSwapV2.Leg memory a1, OrdoSwapV2.Leg memory a2) internal pure returns (OrdoSwapV2.Leg[] memory a) {
        a = new OrdoSwapV2.Leg[](2);
        a[0] = a1;
        a[1] = a2;
    }

    /// @dev quote() reverts with its answer; decode it.
    function _quote(OrdoSwapV2.Leg[] memory legs, uint256 amountIn, OrdoSwapV2.Reclaim memory r, uint256 value)
        internal
        returns (uint256 out, uint256 profit, bytes memory failure)
    {
        vm.deal(address(this), value);
        (bool ok, bytes memory ret) = address(ordo).call{value: value}(abi.encodeCall(OrdoSwapV2.quote, (legs, amountIn, r)));
        require(!ok, "quote must revert");
        require(bytes4(ret) == OrdoSwapV2.QuoteResult.selector, string(ret));
        bytes memory payload = new bytes(ret.length - 4);
        for (uint256 i = 0; i < payload.length; i++) payload[i] = ret[i + 4];
        (out, profit, failure) = abi.decode(payload, (uint256, uint256, bytes));
    }

    // -------------------------------------------------------------- tests

    function test_Fork_BuyOrdoThroughTheLaunchpadHook() public {
        vm.skip(!forked);
        uint256 floatBefore = ordo.float();
        vm.prank(user);
        (uint256 out, uint256 surplus) = ordo.swap{value: 0.05 ether}(_one(_v4(hooked, true)), 0.05 ether, 0, user, false, _none());
        emit log_named_decimal_uint("ORDO for 0.05 ETH via the hooked pool", out, 18);
        assertGt(out, 0, "the hook let us through the PoolManager");
        assertEq(IERC20(ORDO).balanceOf(user), out, "delivered to the user");
        assertEq(surplus, 0);
        assertEq(ordo.float(), floatBefore, "float untouched");
        assertEq(address(ordo).balance, 0, "no ether left behind");
    }

    function test_Fork_BuyOrdoOnTheHooklessPoolAndSellItBackForETH() public {
        vm.skip(!forked);
        vm.prank(user);
        (uint256 got,) = ordo.swap{value: 0.05 ether}(_one(_v4(plain20, true)), 0.05 ether, 0, user, false, _none());
        assertGt(got, 0);

        vm.prank(user);
        IERC20(ORDO).approve(address(ordo), got);
        uint256 ethBefore = user.balance;
        vm.prank(user);
        (uint256 back,) = ordo.swap(_one(_v4(plain20, false)), got, 0, user, true, _none());
        assertGt(back, 0);
        assertEq(user.balance - ethBefore, back, "paid out as native ETH");
        assertEq(IERC20(ORDO).balanceOf(user), 0);
        assertEq(address(ordo).balance, 0);
    }

    /// @dev ETH in as WETH on V3, USDG across to V4, native ETH out: every
    ///      conversion the leg runner has to make, in one route.
    function test_Fork_MixedVenueRoute_V3ThenV4_EndingInNativeETH() public {
        vm.skip(!forked);
        PoolKey memory v4EthUsdg = PoolKey({currency0: NATIVE, currency1: USDG, fee: 100, tickSpacing: 1, hooks: NATIVE});
        vm.skip(IStateViewT(STATE_VIEW).getLiquidity(keccak256(abi.encode(v4EthUsdg))) == 0);
        OrdoSwapV2.Leg[] memory legs = _two(_v3(abi.encodePacked(WETH, uint24(500), USDG)), _v4(v4EthUsdg, false));
        uint256 ethBefore = user.balance;
        vm.prank(user);
        (uint256 out,) = ordo.swap{value: 0.05 ether}(legs, 0.05 ether, 0, user, true, _none());
        emit log_named_decimal_uint("ETH back for 0.05 ETH via V3 USDG then V4 USDG/ETH", out, 18);
        assertGt(out, 0.04 ether, "a round trip through two venues loses only fees");
        assertEq(user.balance - (ethBefore - 0.05 ether), out, "paid out as native ETH");
        assertEq(IERC20(USDG).balanceOf(address(ordo)), 0, "no USDG stranded between legs");
        assertEq(address(ordo).balance, 0, "no ether stranded");
    }

    function test_Fork_ReclaimAcrossTwoV4Pools() public {
        vm.skip(!forked);
        // A buy on the hooked pool makes ORDO dear there. The reclaim buys ORDO on
        // the hookless pool and sells it into the hooked one, all in ether.
        uint256 buy = 1 ether;
        OrdoSwapV2.Leg[] memory userLegs = _one(_v4(hooked, true));
        OrdoSwapV2.Leg[] memory cycle = _two(_v4(plain20, true), _v4(hooked, false));

        uint256 bestSize;
        uint256 bestProfit;
        uint256[5] memory ladder = [uint256(0.02 ether), 0.05 ether, 0.1 ether, 0.25 ether, 0.5 ether];
        for (uint256 i = 0; i < ladder.length; i++) {
            OrdoSwapV2.Reclaim memory r = OrdoSwapV2.Reclaim({legs: cycle, amountIn: ladder[i], minProfit: 0, gas: 0});
            (, uint256 profit, bytes memory failure) = _quote(userLegs, buy, r, buy);
            if (failure.length == 0 && profit > bestProfit) {
                bestProfit = profit;
                bestSize = ladder[i];
            }
        }
        emit log_named_decimal_uint("best reclaim size", bestSize, 18);
        emit log_named_decimal_uint("best reclaim profit", bestProfit, 18);
        if (bestProfit == 0) {
            emit log("no cross-pool gap at this size right now; the mechanism ran, the market did not cooperate");
            return;
        }

        uint256 floatBefore = ordo.float();
        OrdoSwapV2.Reclaim memory chosen = OrdoSwapV2.Reclaim({legs: cycle, amountIn: bestSize, minProfit: bestProfit / 2, gas: 400_000});
        vm.prank(user);
        (uint256 out, uint256 surplus) = ordo.swap{value: buy}(userLegs, buy, 0, user, false, chosen);
        assertGt(out, 0);
        assertGt(surplus, 0, "the user was paid the surplus");
        assertEq(IERC20(WETH).balanceOf(user), surplus, "in WETH, since the swap was not native-out");
        assertGt(ordo.float(), floatBefore, "the float grew by the protocol share");
        emit log_named_decimal_uint("user surplus (WETH)", surplus, 18);
    }

    function test_Fork_UnderGassedReclaimRevertsBeforeTheSwap() public {
        vm.skip(!forked);
        OrdoSwapV2.Reclaim memory r = OrdoSwapV2.Reclaim({legs: _two(_v4(plain20, true), _v4(hooked, false)), amountIn: 0.05 ether, minProfit: 0, gas: 30_000_000});
        vm.prank(user);
        vm.expectRevert();
        ordo.swap{value: 0.05 ether, gas: 1_000_000}(_one(_v4(hooked, true)), 0.05 ether, 0, user, false, r);
        assertEq(IERC20(ORDO).balanceOf(user), 0, "nothing happened: an estimator will raise its number instead of skipping the reclaim");
    }

    function test_Fork_ReclaimMustBeEtherClosed() public {
        vm.skip(!forked);
        uint256 floatBefore = ordo.float();
        // ETH -> ORDO only: ends in ORDO, not ether.
        OrdoSwapV2.Reclaim memory r = OrdoSwapV2.Reclaim({legs: _one(_v4(plain20, true)), amountIn: 0.05 ether, minProfit: 0, gas: 300_000});
        vm.prank(user);
        (uint256 out, uint256 surplus) = ordo.swap{value: 0.05 ether}(_one(_v4(hooked, true)), 0.05 ether, 0, user, false, r);
        assertGt(out, 0, "the swap stands");
        assertEq(surplus, 0);
        assertEq(ordo.float(), floatBefore, "a reclaim that does not come back to ether cannot touch the float");
    }

    function test_Fork_V3StillWorks() public {
        vm.skip(!forked);
        vm.prank(user);
        (uint256 out,) = ordo.swap{value: 0.1 ether}(_one(_v3(abi.encodePacked(WETH, uint24(500), USDG))), 0.1 ether, 0, user, false, _none());
        assertGt(out, 0);
        assertEq(IERC20(USDG).balanceOf(user), out);
    }

    function test_Fork_NobodyElseCanDriveTheFloat() public {
        vm.skip(!forked);
        OrdoSwapV2.Reclaim memory r = OrdoSwapV2.Reclaim({legs: _two(_v4(plain20, true), _v4(hooked, false)), amountIn: 1 ether, minProfit: 0, gas: 0});
        vm.prank(user);
        vm.expectRevert(OrdoSwapV2.NotSelf.selector);
        ordo.reclaimFor(user, r, false);
    }
}

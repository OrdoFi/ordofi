// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/OrdoBundler.sol";

interface IAgenRouter {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    function swap(PoolKey calldata key, bool zeroForOne, uint128 amountIn, uint128 minAmountOut, bytes calldata extra)
        external
        payable
        returns (uint256 amountOut);
}

interface IInstantBurner {
    function burn(uint128 minTokensOut) external returns (uint256 spent, uint256 bought, uint256 sunk);
    function slippageFloor(uint128 amountIn) external view returns (uint256);
    function burnCount() external view returns (uint32);
    function tokensSunk() external view returns (uint256);
    function ready() external view returns (bool);
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// @notice Proves the bundler against real Robinhood Chain state by unsticking a
///         buyback that is genuinely stuck on mainnet right now.
///
/// @dev The SCL market's `InstantBurner` holds ~1.26 ETH and has never burned.
///      It spends its entire balance in one swap and refuses any fill worse
///      than 5% below spot, but 1.26 ETH is roughly a 10% move against that
///      pool — so `burn()` reverts, every fee it earns raises the bar, and no
///      keeper can ever call it. There is no owner, no withdrawal and no
///      partial spend.
///
///      One transaction fixes it: buy first so the pool is deep enough, then
///      burn, then sell back. Every leg has to succeed together — a searcher
///      who buys and then fails to burn is left holding the bag — which is
///      exactly the guarantee `OrdoExecutor` provides and which a best-effort
///      "fire them in the same tick" bundle does not.
///
///      forge test --match-contract OrdoBundlerFork --fork-url robinhood -vv
contract OrdoBundlerForkTest is Test {
    address constant ROUTER = 0xFaf5734973329797fCD032fa80a8277E906c187A;
    address constant BURNER = 0xa410cDb8150572C7062709659d2b46Db0286e3f9;
    address constant SCL = 0xBe92b334E045Bbfd292a28e54f8C75aF2FC07bBE;
    address constant HOOK = 0xcf8f482e998d18793414d10c9Fc48fC8277Ab8CC;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    OrdoBundler bundler;
    OrdoExecutor executor;
    address searcher = makeAddr("searcher");
    bool forked;

    function setUp() public {
        // `--fork-url` already put us on the chain, in which case do not fork
        // again — re-forking would drop back to the `robinhood` alias, whose
        // public endpoint refuses Foundry's user agent. Run these through
        // `scripts/fork-proxy.mjs` or your own node.
        if (block.chainid != 4663) {
            try vm.createSelectFork("robinhood") {} catch {}
        }
        if (block.chainid != 4663) return;
        forked = true;

        bundler = new OrdoBundler();
        executor = OrdoExecutor(payable(bundler.deploy(searcher)));
        vm.deal(searcher, 100 ether);
    }

    function _key() internal pure returns (IAgenRouter.PoolKey memory) {
        return IAgenRouter.PoolKey({
            currency0: address(0),
            currency1: SCL,
            fee: 8388608, // DYNAMIC_FEE_FLAG
            tickSpacing: 200,
            hooks: HOOK
        });
    }

    function _buy(uint128 amountIn) internal pure returns (Call memory) {
        return Call({
            target: ROUTER,
            value: amountIn,
            data: abi.encodeCall(IAgenRouter.swap, (_key(), true, amountIn, 1, "")),
            allowFailure: false
        });
    }

    function _sell(uint128 amountIn) internal pure returns (Call memory) {
        return Call({
            target: ROUTER,
            value: 0,
            data: abi.encodeCall(IAgenRouter.swap, (_key(), false, amountIn, 1, "")),
            allowFailure: false
        });
    }

    function test_Fork_BurnIsStuckOnItsOwn() public {
        if (!forked) return;
        assertEq(block.chainid, 4663, "forked Robinhood Chain");

        IInstantBurner burner = IInstantBurner(BURNER);
        uint128 budget = uint128(BURNER.balance);
        emit log_named_decimal_uint("burner balance", budget, 18);
        emit log_named_uint("burnCount", burner.burnCount());

        assertTrue(burner.ready(), "the burner reports ready: balance and interval both pass");
        assertEq(burner.burnCount(), 0, "and yet it has never burned");

        // The floor it computes for itself is unreachable at this depth.
        uint128 floor = uint128(burner.slippageFloor(budget));
        vm.expectRevert();
        burner.burn(floor);
    }

    /// @dev The first three legs of the bundle, for a candidate deepening size.
    ///      The burn's floor is read *after* the buy, because the burn computes
    ///      its own floor from the price the buy leaves behind and will only
    ///      accept a `minTokensOut` at or above it.
    function _legs(uint128 deepen) internal view returns (Call[] memory calls, uint128 floorAfterBuy) {
        floorAfterBuy = uint128(IInstantBurner(BURNER).slippageFloor(uint128(BURNER.balance)));
        calls = new Call[](3);
        calls[0] = _buy(deepen);
        calls[1] = Call(SCL, 0, abi.encodeCall(IERC20.approve, (ROUTER, type(uint256).max)), false);
        calls[2] = Call(BURNER, 0, abi.encodeCall(IInstantBurner.burn, (floorAfterBuy)), false);
    }

    /// @dev Search for a deepening size that makes the burn clear its own 5%
    ///      floor. This is not test scaffolding standing in for something
    ///      simpler — it is exactly the off-chain simulation loop a searcher
    ///      runs before committing, and the reason simulation has to happen
    ///      against real state rather than against a model of it.
    function _findDeepening() internal returns (uint128) {
        for (uint128 deepen = 12 ether; deepen <= 26 ether; deepen += 2 ether) {
            uint256 snap = vm.snapshotState();

            Call[] memory probe = new Call[](1);
            probe[0] = _buy(deepen);
            vm.prank(searcher);
            executor.execute{value: deepen}(probe, new Check[](0), 0, 0);

            (Call[] memory legs,) = _legs(deepen);
            Call[] memory burnOnly = new Call[](1);
            burnOnly[0] = legs[2];

            vm.prank(searcher);
            try executor.execute(burnOnly, new Check[](0), 0, 0) {
                vm.revertToState(snap);
                return deepen;
            } catch {
                vm.revertToState(snap);
            }
        }
        revert("no deepening in range unsticks the burn");
    }

    function test_Fork_AtomicBundleUnsticksTheBurn() public {
        if (!forked) return;

        IInstantBurner burner = IInstantBurner(BURNER);
        uint128 deepen = _findDeepening();

        // Now the amounts, measured against the same state the bundle will see.
        uint256 snap = vm.snapshotState();
        Call[] memory probe = new Call[](1);
        probe[0] = _buy(deepen);
        vm.prank(searcher);
        executor.execute{value: deepen}(probe, new Check[](0), 0, 0);
        (, uint128 floorAfterBuy) = _legs(deepen);
        uint256 sclHeld = IERC20(SCL).balanceOf(address(executor));
        vm.revertToState(snap);

        emit log_named_decimal_uint("deepening buy", deepen, 18);
        emit log_named_uint("SCL the buy returns", sclHeld / 1e18);

        // --- the bundle, atomic -------------------------------------------
        Call[] memory calls = new Call[](4);
        (Call[] memory head,) = _legs(deepen);
        calls[0] = head[0];
        calls[1] = head[1];
        calls[2] = Call(BURNER, 0, abi.encodeCall(IInstantBurner.burn, (floorAfterBuy)), false);
        calls[3] = _sell(uint128(sclHeld));

        uint256 deadBefore = IERC20(SCL).balanceOf(DEAD);

        vm.prank(searcher);
        executor.execute{value: deepen}(calls, new Check[](0), 0, 0);

        // --- the burn happened ---------------------------------------------
        assertEq(burner.burnCount(), 1, "the stuck burn executed");
        assertGt(burner.tokensSunk(), 0, "tokens were bought and sunk");
        assertGt(IERC20(SCL).balanceOf(DEAD), deadBefore, "supply left circulation");
        assertEq(BURNER.balance, 0, "the burner spent its whole budget");

        emit log_named_uint("SCL burned", burner.tokensSunk() / 1e18);

        // --- what it cost the searcher --------------------------------------
        uint256 recovered = address(executor).balance;
        if (recovered >= deepen) {
            emit log_named_decimal_uint("searcher profit (wei)", recovered - deepen, 18);
        } else {
            emit log_named_decimal_uint("searcher cost (wei)", deepen - recovered, 18);
        }
    }

    function test_Fork_TheSameBundleWithoutTheDeepeningLegReverts() public {
        if (!forked) return;

        IInstantBurner burner = IInstantBurner(BURNER);
        uint128 budget = uint128(BURNER.balance);
        uint128 floorNow = uint128(burner.slippageFloor(budget));

        Call[] memory calls = new Call[](1);
        calls[0] = Call(BURNER, 0, abi.encodeCall(IInstantBurner.burn, (floorNow)), false);

        vm.prank(searcher);
        vm.expectRevert();
        executor.execute(calls, new Check[](0), 0, 0);

        assertEq(burner.burnCount(), 0, "still stuck without the buy in front of it");
    }

    /// @notice The conditional-execution story, against a live pool: a bundle
    ///         that refuses to run unless the pool has already moved.
    function test_Fork_PreconditionRefusesToTradeOnStaleState() public {
        if (!forked) return;

        IInstantBurner burner = IInstantBurner(BURNER);

        // "Only run if the burner's floor has already fallen below this" — the
        // shape of assertion a backrunner uses to check its target landed.
        uint128 budget = uint128(BURNER.balance);
        uint256 floorNow = burner.slippageFloor(budget);

        Check[] memory checks = new Check[](1);
        checks[0] = Check({
            target: BURNER,
            data: abi.encodeCall(IInstantBurner.slippageFloor, (budget)),
            mask: bytes32(type(uint256).max),
            expected: bytes32(floorNow / 2),
            op: Op.Lte
        });

        assertFalse(executor.checksPass(checks), "the pool has not moved, so the bundle must not run");

        Call[] memory calls = new Call[](1);
        calls[0] = _buy(1 ether);
        vm.prank(searcher);
        vm.expectRevert(abi.encodeWithSelector(OrdoExecutor.CheckFailed.selector, 0, bytes32(floorNow), bytes32(floorNow / 2)));
        executor.execute{value: 1 ether}(calls, checks, 0, 0);
    }
}

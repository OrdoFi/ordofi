// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/OrdoBatch.sol";
import {PoolKey} from "../src/V4Common.sol";
import {V4TestSwapper} from "./V4TestSwapper.sol";

interface IStateViewT {
    function getLiquidity(bytes32 poolId) external view returns (uint128);
}

/// @notice OrdoBatch against ORDO's real hookless ETH pool on Robinhood Chain.
///
///   forge test --match-contract OrdoBatchFork --fork-url http://127.0.0.1:18547 -vv
contract OrdoBatchForkTest is Test {
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant ORDO = 0xFE2f0fB0C00d19786A8ABf98d4B1f1AC8763b167;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    address constant NATIVE = address(0);

    PoolKey plain20 = PoolKey({currency0: NATIVE, currency1: ORDO, fee: 200000, tickSpacing: 2000, hooks: NATIVE});

    OrdoBatch batch;
    V4TestSwapper swapper;
    address owner = makeAddr("owner");
    address solver = makeAddr("solver");
    address treasury = makeAddr("treasury");
    address alice;
    uint256 aliceKey;
    address bob;
    uint256 bobKey;
    address carol;
    uint256 carolKey;
    bool forked;

    uint16 constant FEE_BPS = 30;

    function setUp() public {
        if (block.chainid != 4663) {
            try vm.createSelectFork("robinhood") {} catch {}
        }
        if (block.chainid != 4663) return;
        if (IStateViewT(STATE_VIEW).getLiquidity(keccak256(abi.encode(plain20))) == 0) return;
        forked = true;

        (alice, aliceKey) = makeAddrAndKey("alice");
        (bob, bobKey) = makeAddrAndKey("bob");
        (carol, carolKey) = makeAddrAndKey("carol");

        batch = new OrdoBatch(WETH, ROUTER, POOL_MANAGER, owner, solver, treasury, FEE_BPS);
        swapper = new V4TestSwapper(POOL_MANAGER);

        // Alice and Carol hold WETH; Bob holds ORDO he bought on the pool.
        vm.deal(alice, 10 ether);
        vm.deal(carol, 10 ether);
        vm.deal(bob, 10 ether);
        vm.prank(alice);
        IWETH9(WETH).deposit{value: 5 ether}();
        vm.prank(carol);
        IWETH9(WETH).deposit{value: 5 ether}();
        vm.prank(bob);
        swapper.swapExactIn{value: 2 ether}(plain20, true, 2 ether);
        assertGt(IERC20(ORDO).balanceOf(bob), 0, "bob holds ORDO");

        vm.prank(alice);
        IERC20(WETH).approve(address(batch), type(uint256).max);
        vm.prank(carol);
        IERC20(WETH).approve(address(batch), type(uint256).max);
        vm.prank(bob);
        IERC20(ORDO).approve(address(batch), type(uint256).max);
    }

    // ------------------------------------------------------------ helpers

    function _order(address who, address sellT, address buyT, uint256 sell, uint256 minBuy, uint256 nonce)
        internal
        view
        returns (OrdoBatch.Order memory o)
    {
        o = OrdoBatch.Order({
            owner: who,
            receiver: address(0),
            sellToken: sellT,
            buyToken: buyT,
            sellAmount: sell,
            minBuyAmount: minBuy,
            validTo: uint32(block.timestamp + 60),
            nonce: nonce,
            appData: bytes32("fomo")
        });
    }

    function _sign(uint256 key, OrdoBatch.Order memory o) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, batch.orderHash(o));
        return abi.encodePacked(r, s, v);
    }

    function _prices(uint256 pWeth, uint256 pOrdo) internal pure returns (OrdoBatch.Price[] memory p) {
        p = new OrdoBatch.Price[](2);
        p[0] = OrdoBatch.Price(WETH, pWeth);
        p[1] = OrdoBatch.Price(ORDO, pOrdo);
    }

    function _v4(PoolKey memory key, bool zeroForOne) internal pure returns (OrdoBatch.Leg memory) {
        return OrdoBatch.Leg({venue: 1, path: "", key: key, zeroForOne: zeroForOne});
    }

    function _buyOrdoWith(uint256 weth) internal view returns (OrdoBatch.Interaction[] memory xs) {
        xs = new OrdoBatch.Interaction[](1);
        OrdoBatch.Leg[] memory legs = new OrdoBatch.Leg[](1);
        legs[0] = _v4(plain20, true);
        xs[0] = OrdoBatch.Interaction({legs: legs, amountIn: weth});
    }

    function _noInteractions() internal pure returns (OrdoBatch.Interaction[] memory xs) {
        xs = new OrdoBatch.Interaction[](0);
    }

    /// @dev What the pool gives for `ethIn` right now, without changing state.
    function _ammOrdoFor(uint256 ethIn) internal returns (uint256 out) {
        uint256 snap = vm.snapshotState();
        address probe = makeAddr("probe");
        vm.deal(probe, ethIn);
        vm.prank(probe);
        swapper.swapExactIn{value: ethIn}(plain20, true, ethIn);
        out = IERC20(ORDO).balanceOf(probe);
        vm.revertToState(snap);
    }

    function _settle(OrdoBatch.Order[] memory os, bytes[] memory sigs, OrdoBatch.Price[] memory p, OrdoBatch.Interaction[] memory xs) internal {
        vm.prank(solver);
        batch.settle(os, sigs, p, xs);
    }

    function _one(OrdoBatch.Order memory o, bytes memory s) internal pure returns (OrdoBatch.Order[] memory os, bytes[] memory sigs) {
        os = new OrdoBatch.Order[](1);
        sigs = new bytes[](1);
        os[0] = o;
        sigs[0] = s;
    }

    function _two(OrdoBatch.Order memory a, bytes memory sa, OrdoBatch.Order memory b, bytes memory sb)
        internal
        pure
        returns (OrdoBatch.Order[] memory os, bytes[] memory sigs)
    {
        os = new OrdoBatch.Order[](2);
        sigs = new bytes[](2);
        os[0] = a;
        sigs[0] = sa;
        os[1] = b;
        sigs[1] = sb;
    }

    // -------------------------------------------------------------- tests

    /// A buyer and a seller of the same size meet; the pool is never touched.
    function test_Fork_FullNet_PoolUntouched() public {
        vm.skip(!forked);
        uint256 ethIn = 0.1 ether;
        uint256 rate = _ammOrdoFor(ethIn); // ORDO per 0.1 ETH at the AMM
        // Clearing: price[WETH] = rate, price[ORDO] = ethIn  =>  alice's buy = rate.
        OrdoBatch.Order memory a = _order(alice, WETH, ORDO, ethIn, rate, 1);
        OrdoBatch.Order memory b = _order(bob, ORDO, WETH, rate, ethIn, 1);
        (OrdoBatch.Order[] memory os, bytes[] memory sigs) = _two(a, _sign(aliceKey, a), b, _sign(bobKey, b));

        uint256 poolLiqBefore = IStateViewT(STATE_VIEW).getLiquidity(keccak256(abi.encode(plain20)));
        uint256 aOrdo = IERC20(ORDO).balanceOf(alice);
        uint256 bWeth = IERC20(WETH).balanceOf(bob);

        _settle(os, sigs, _prices(rate, ethIn), _noInteractions());

        assertEq(IERC20(ORDO).balanceOf(alice) - aOrdo, rate, "alice got exactly the clearing amount");
        assertEq(IERC20(WETH).balanceOf(bob) - bWeth, ethIn, "bob got exactly the clearing amount");
        assertEq(IStateViewT(STATE_VIEW).getLiquidity(keccak256(abi.encode(plain20))), poolLiqBefore, "pool untouched");
        assertEq(IERC20(WETH).balanceOf(address(batch)), 0, "nothing stranded");
        assertEq(IERC20(ORDO).balanceOf(address(batch)), 0, "nothing stranded");
        assertEq(IERC20(ORDO).balanceOf(treasury), 0, "a perfect net leaves no fee");
        assertEq(IERC20(WETH).balanceOf(treasury), 0);
    }

    /// One buyer, no counterparty: the residual is the whole order and goes to the AMM.
    function test_Fork_OneSided_ResidualToAMM_FeeWithinCap() public {
        vm.skip(!forked);
        uint256 ethIn = 0.1 ether;
        uint256 ammOut = _ammOrdoFor(ethIn);
        // The solver keeps 10 bps of the AMM output as fee; users still get the uniform rate.
        uint256 userOut = ammOut - (ammOut * 10) / 10_000;
        OrdoBatch.Order memory a = _order(alice, WETH, ORDO, ethIn, userOut, 2);
        (OrdoBatch.Order[] memory os, bytes[] memory sigs) = _one(a, _sign(aliceKey, a));

        uint256 aOrdo = IERC20(ORDO).balanceOf(alice);
        _settle(os, sigs, _prices(userOut, ethIn), _buyOrdoWith(ethIn));

        assertEq(IERC20(ORDO).balanceOf(alice) - aOrdo, userOut, "alice paid at the clearing price");
        uint256 fee = IERC20(ORDO).balanceOf(treasury);
        assertGt(fee, 0, "the difference is the protocol fee");
        assertLe(fee, (userOut * FEE_BPS) / 10_000, "and it is inside the cap");
        assertEq(IERC20(ORDO).balanceOf(address(batch)), 0);
        assertEq(IERC20(WETH).balanceOf(address(batch)), 0);
        assertEq(address(batch).balance, 0);
    }

    /// Bob sells less than Alice buys: they net, and only the difference meets the pool.
    function test_Fork_PartialNet_OnlyResidualHitsPool() public {
        vm.skip(!forked);
        uint256 aliceEth = 0.1 ether;
        uint256 bobEth = 0.04 ether; // what bob wants back
        uint256 residual = aliceEth - bobEth; // 0.06 goes to the pool
        uint256 ammOut = _ammOrdoFor(residual);
        // Uniform rate is the residual's AMM rate less a 10 bps haircut.
        uint256 q = ammOut - (ammOut * 10) / 10_000;
        // price[WETH] = q, price[ORDO] = residual  =>  ORDO per WETH-wei = q / residual
        uint256 aliceBuy = (aliceEth * q) / residual;
        uint256 bobSell = (bobEth * q) / residual;
        uint256 bobBuy = (bobSell * residual) / q;

        OrdoBatch.Order memory a = _order(alice, WETH, ORDO, aliceEth, aliceBuy, 3);
        OrdoBatch.Order memory b = _order(bob, ORDO, WETH, bobSell, bobBuy, 3);
        (OrdoBatch.Order[] memory os, bytes[] memory sigs) = _two(a, _sign(aliceKey, a), b, _sign(bobKey, b));

        uint256 aOrdo = IERC20(ORDO).balanceOf(alice);
        uint256 bWeth = IERC20(WETH).balanceOf(bob);
        uint256 bOrdo = IERC20(ORDO).balanceOf(bob);

        _settle(os, sigs, _prices(q, residual), _buyOrdoWith(residual));

        assertEq(IERC20(ORDO).balanceOf(alice) - aOrdo, aliceBuy, "alice filled at the uniform rate");
        assertEq(IERC20(WETH).balanceOf(bob) - bWeth, bobBuy, "bob filled at the same rate");
        assertEq(bOrdo - IERC20(ORDO).balanceOf(bob), bobSell, "bob sold exactly his order");
        // Same rate both ways, up to rounding.
        assertApproxEqRel(aliceBuy * bobBuy, aliceEth * bobSell, 1e12, "uniform clearing price");
        assertGt(IERC20(ORDO).balanceOf(treasury), 0, "fee collected");
        assertEq(IERC20(ORDO).balanceOf(address(batch)), 0);
        assertEq(IERC20(WETH).balanceOf(address(batch)), 0);
        emit log_named_decimal_uint("alice ORDO via batch", aliceBuy, 18);
        emit log_named_decimal_uint("alice ORDO if alone at AMM", _ammOrdoFor(aliceEth), 18);
    }

    /// Two buyers of different sizes in one batch get the same rate.
    function test_Fork_UniformPrice_TwoBuyers() public {
        vm.skip(!forked);
        uint256 total = 0.15 ether;
        uint256 ammOut = _ammOrdoFor(total);
        uint256 q = ammOut - (ammOut * 10) / 10_000;
        OrdoBatch.Order memory a = _order(alice, WETH, ORDO, 0.1 ether, 0, 4);
        OrdoBatch.Order memory c = _order(carol, WETH, ORDO, 0.05 ether, 0, 4);
        (OrdoBatch.Order[] memory os, bytes[] memory sigs) = _two(a, _sign(aliceKey, a), c, _sign(carolKey, c));

        uint256 aOrdo = IERC20(ORDO).balanceOf(alice);
        uint256 cOrdo = IERC20(ORDO).balanceOf(carol);
        _settle(os, sigs, _prices(q, total), _buyOrdoWith(total));
        uint256 aGot = IERC20(ORDO).balanceOf(alice) - aOrdo;
        uint256 cGot = IERC20(ORDO).balanceOf(carol) - cOrdo;
        assertApproxEqRel(aGot * 0.05 ether, cGot * 0.1 ether, 1e12, "same ORDO per ETH for both");
        // Carol alone would have paid the full-size price impact of her own order
        // only; together they pay the impact of the sum, but split at one rate.
        assertGt(aGot, 0);
        assertGt(cGot, 0);
    }

    function test_Fork_RevertsWhenLimitNotMet() public {
        vm.skip(!forked);
        uint256 ethIn = 0.1 ether;
        uint256 ammOut = _ammOrdoFor(ethIn);
        OrdoBatch.Order memory a = _order(alice, WETH, ORDO, ethIn, ammOut + 1, 5);
        (OrdoBatch.Order[] memory os, bytes[] memory sigs) = _one(a, _sign(aliceKey, a));
        bytes32 h = batch.orderHash(a);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(OrdoBatch.LimitNotMet.selector, h, ammOut, ammOut + 1));
        batch.settle(os, sigs, _prices(ammOut, ethIn), _buyOrdoWith(ethIn));
    }

    function test_Fork_RevertsOnReplay() public {
        vm.skip(!forked);
        uint256 ethIn = 0.05 ether;
        uint256 ammOut = _ammOrdoFor(ethIn);
        uint256 q = ammOut - (ammOut * 10) / 10_000;
        OrdoBatch.Order memory a = _order(alice, WETH, ORDO, ethIn, 0, 6);
        (OrdoBatch.Order[] memory os, bytes[] memory sigs) = _one(a, _sign(aliceKey, a));
        _settle(os, sigs, _prices(q, ethIn), _buyOrdoWith(ethIn));

        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(OrdoBatch.NonceUsed.selector, alice, 6));
        batch.settle(os, sigs, _prices(q, ethIn), _buyOrdoWith(ethIn));
    }

    function test_Fork_RevertsOnCancelledNonce() public {
        vm.skip(!forked);
        OrdoBatch.Order memory a = _order(alice, WETH, ORDO, 0.05 ether, 0, 7);
        (OrdoBatch.Order[] memory os, bytes[] memory sigs) = _one(a, _sign(aliceKey, a));
        vm.prank(alice);
        batch.cancel(7);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(OrdoBatch.NonceUsed.selector, alice, 7));
        batch.settle(os, sigs, _prices(1, 1), _noInteractions());
    }

    function test_Fork_RevertsExpired() public {
        vm.skip(!forked);
        OrdoBatch.Order memory a = _order(alice, WETH, ORDO, 0.05 ether, 0, 8);
        a.validTo = uint32(block.timestamp - 1);
        (OrdoBatch.Order[] memory os, bytes[] memory sigs) = _one(a, _sign(aliceKey, a));
        bytes32 h = batch.orderHash(a);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(OrdoBatch.Expired.selector, h));
        batch.settle(os, sigs, _prices(1, 1), _noInteractions());
    }

    function test_Fork_RevertsBadSignature() public {
        vm.skip(!forked);
        OrdoBatch.Order memory a = _order(alice, WETH, ORDO, 0.05 ether, 0, 9);
        (OrdoBatch.Order[] memory os, bytes[] memory sigs) = _one(a, _sign(bobKey, a)); // wrong key
        bytes32 h = batch.orderHash(a);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(OrdoBatch.BadSignature.selector, h));
        batch.settle(os, sigs, _prices(1, 1), _noInteractions());
    }

    function test_Fork_OnlySolverSettles() public {
        vm.skip(!forked);
        OrdoBatch.Order memory a = _order(alice, WETH, ORDO, 0.05 ether, 0, 10);
        (OrdoBatch.Order[] memory os, bytes[] memory sigs) = _one(a, _sign(aliceKey, a));
        vm.prank(bob);
        vm.expectRevert(OrdoBatch.NotSolver.selector);
        batch.settle(os, sigs, _prices(1, 1), _noInteractions());
    }

    /// The solver cannot keep more than the cap.
    function test_Fork_RevertsFeeAboveCap() public {
        vm.skip(!forked);
        uint256 ethIn = 0.1 ether;
        uint256 ammOut = _ammOrdoFor(ethIn);
        uint256 userOut = ammOut - (ammOut * 200) / 10_000; // tries to keep 2%
        OrdoBatch.Order memory a = _order(alice, WETH, ORDO, ethIn, 0, 11);
        (OrdoBatch.Order[] memory os, bytes[] memory sigs) = _one(a, _sign(aliceKey, a));
        vm.prank(solver);
        vm.expectPartialRevert(OrdoBatch.FeeAboveCap.selector);
        batch.settle(os, sigs, _prices(userOut, ethIn), _buyOrdoWith(ethIn));
    }

    /// The solver cannot promise more than the pool delivers.
    function test_Fork_RevertsWhenContractWouldLoseFunds() public {
        vm.skip(!forked);
        uint256 ethIn = 0.1 ether;
        uint256 ammOut = _ammOrdoFor(ethIn);
        OrdoBatch.Order memory a = _order(alice, WETH, ORDO, ethIn, 0, 12);
        (OrdoBatch.Order[] memory os, bytes[] memory sigs) = _one(a, _sign(aliceKey, a));
        vm.prank(solver);
        // Paying alice more ORDO than the AMM returns fails at the transfer,
        // before the balance check can name the token.
        vm.expectRevert();
        batch.settle(os, sigs, _prices(ammOut + ammOut / 100, ethIn), _buyOrdoWith(ethIn));
    }

    /// Ether in: deposit, no signature, filled from escrow. Ether out: unwrapped.
    function test_Fork_DepositedEtherOrder_AndNativeEtherOut() public {
        vm.skip(!forked);
        uint256 ethIn = 0.1 ether;
        uint256 rate = _ammOrdoFor(ethIn);
        // Alice pays ETH by deposit; Bob sells ORDO and wants native ETH back.
        OrdoBatch.Order memory a = _order(alice, WETH, ORDO, ethIn, rate, 13);
        OrdoBatch.Order memory b = _order(bob, ORDO, address(0), rate, ethIn, 13);
        vm.prank(alice);
        batch.depositOrder{value: ethIn}(a);
        assertEq(batch.escrowTotal(), ethIn);
        assertEq(batch.escrowed(batch.orderHash(a)), ethIn);

        (OrdoBatch.Order[] memory os, bytes[] memory sigs) = _two(a, "", b, _sign(bobKey, b));
        uint256 aOrdo = IERC20(ORDO).balanceOf(alice);
        uint256 bEth = bob.balance;
        _settle(os, sigs, _prices(rate, ethIn), _noInteractions());

        assertEq(IERC20(ORDO).balanceOf(alice) - aOrdo, rate, "alice filled from escrow");
        assertEq(bob.balance - bEth, ethIn, "bob paid in native ether");
        assertEq(batch.escrowTotal(), 0);
        assertEq(batch.escrowed(batch.orderHash(a)), 0);
        assertEq(IERC20(WETH).balanceOf(address(batch)), 0);
        assertEq(address(batch).balance, 0);
    }

    function test_Fork_DepositRefundAfterExpiry() public {
        vm.skip(!forked);
        OrdoBatch.Order memory a = _order(alice, WETH, ORDO, 0.1 ether, 0, 14);
        vm.prank(alice);
        batch.depositOrder{value: 0.1 ether}(a);

        bytes32 ha = batch.orderHash(a);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OrdoBatch.NotYetExpired.selector, ha));
        batch.refund(a);

        vm.warp(block.timestamp + 61);
        uint256 before = alice.balance;
        batch.refund(a);
        assertEq(alice.balance - before, 0.1 ether, "ether back");
        assertEq(batch.escrowTotal(), 0);

        // A refunded order cannot be settled: no escrow, no signature.
        (OrdoBatch.Order[] memory os, bytes[] memory sigs) = _one(a, "");
        vm.warp(block.timestamp - 61);
        bytes32 h = batch.orderHash(a);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(OrdoBatch.BadSignature.selector, h));
        batch.settle(os, sigs, _prices(1, 1), _noInteractions());
    }

    function test_Fork_DepositRejectsMismatch() public {
        vm.skip(!forked);
        OrdoBatch.Order memory a = _order(alice, WETH, ORDO, 0.1 ether, 0, 15);
        vm.prank(alice);
        vm.expectRevert(OrdoBatch.DepositMismatch.selector);
        batch.depositOrder{value: 0.05 ether}(a);

        OrdoBatch.Order memory t = _order(alice, ORDO, WETH, 0.1 ether, 0, 16);
        vm.prank(alice);
        vm.expectRevert(OrdoBatch.DepositMismatch.selector);
        batch.depositOrder{value: 0.1 ether}(t);
    }

    /// An EIP-7702 delegated wallet still signs with its key; the code at the
    /// address must not turn a good signature into a bad one.
    function test_Fork_Signature_FromDelegatedEOA() public {
        vm.skip(!forked);
        // Give alice a 7702-style delegation designator as her code.
        vm.etch(alice, hex"ef01008a5b10eb2faf57665f63709ec4b3943a3b005df6");
        assertGt(alice.code.length, 0);
        uint256 ethIn = 0.05 ether;
        uint256 ammOut = _ammOrdoFor(ethIn);
        uint256 q = ammOut - (ammOut * 10) / 10_000;
        OrdoBatch.Order memory a = _order(alice, WETH, ORDO, ethIn, 0, 19);
        (OrdoBatch.Order[] memory os, bytes[] memory sigs) = _one(a, _sign(aliceKey, a));
        uint256 aOrdo = IERC20(ORDO).balanceOf(alice);
        _settle(os, sigs, _prices(q, ethIn), _buyOrdoWith(ethIn));
        assertGt(IERC20(ORDO).balanceOf(alice) - aOrdo, 0, "filled on her ECDSA signature");
    }

    /// `simulate` tells the solver exactly what the AMM gives and what is owed, without signatures.
    function test_Fork_SimulateReportsDeltaAndOwed() public {
        vm.skip(!forked);
        uint256 ethIn = 0.1 ether;
        uint256 ammOut = _ammOrdoFor(ethIn);
        // Deliberately generous price: owes more ORDO than the AMM will give.
        uint256 generous = ammOut + ammOut / 10;
        OrdoBatch.Order memory a = _order(alice, WETH, ORDO, ethIn, 0, 18);
        OrdoBatch.Order[] memory os = new OrdoBatch.Order[](1);
        os[0] = a;

        (bool ok, bytes memory ret) = address(batch).call(abi.encodeCall(OrdoBatch.simulate, (os, _prices(generous, ethIn), _buyOrdoWith(ethIn))));
        require(!ok, "simulate must revert");
        require(bytes4(ret) == OrdoBatch.SimResult.selector, string(ret));
        bytes memory payload = new bytes(ret.length - 4);
        for (uint256 i = 0; i < payload.length; i++) payload[i] = ret[i + 4];
        (address[] memory tokens, int256[] memory delta, uint256[] memory owed, uint256[] memory buys) =
            abi.decode(payload, (address[], int256[], uint256[], uint256[]));

        assertEq(tokens[0], WETH);
        assertEq(tokens[1], ORDO);
        assertEq(delta[0], 0, "all the WETH went to the pool");
        assertEq(uint256(delta[1]), ammOut, "the pool's ORDO is what arrived");
        assertEq(owed[1], generous, "and this is what the prices promise");
        assertEq(buys[0], generous);
        assertGt(owed[1], uint256(delta[1]), "so the solver knows it must lower the price");
        // Nothing moved: simulate is an eth_call.
        assertEq(IERC20(WETH).balanceOf(alice), 5 ether);
        assertEq(batch.nonceUsed(alice, 18), false);
    }

    /// The whole point, in numbers: netting beats the pool for both sides.
    function test_Fork_NettingBeatsThePool() public {
        vm.skip(!forked);
        uint256 ethIn = 0.5 ether;
        // Alone at the AMM, alice would get this much ORDO, and bob selling the
        // same ORDO right after would get back less than 0.5 ETH.
        uint256 aloneOut = _ammOrdoFor(ethIn);
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        IWETH9(WETH).withdraw(ethIn);
        vm.prank(alice);
        swapper.swapExactIn{value: ethIn}(plain20, true, ethIn);
        vm.prank(bob);
        IERC20(ORDO).approve(address(swapper), aloneOut);
        // bob sells aloneOut ORDO into the moved pool
        uint256 bobEthBefore = bob.balance;
        vm.prank(bob);
        IERC20(ORDO).transfer(address(swapper), aloneOut);
        vm.prank(bob);
        swapper.swapExactIn(plain20, false, aloneOut);
        uint256 bobBackAlone = bob.balance - bobEthBefore;
        vm.revertToState(snap);

        // In a batch they meet at the mid: alice gets aloneOut ORDO, bob gets 0.5 ETH, nobody pays impact.
        OrdoBatch.Order memory a = _order(alice, WETH, ORDO, ethIn, aloneOut, 17);
        OrdoBatch.Order memory b = _order(bob, ORDO, WETH, aloneOut, ethIn, 17);
        (OrdoBatch.Order[] memory os, bytes[] memory sigs) = _two(a, _sign(aliceKey, a), b, _sign(bobKey, b));
        uint256 bWeth = IERC20(WETH).balanceOf(bob);
        _settle(os, sigs, _prices(aloneOut, ethIn), _noInteractions());
        uint256 bobBackBatch = IERC20(WETH).balanceOf(bob) - bWeth;

        emit log_named_decimal_uint("bob gets back selling alone at the AMM (ETH)", bobBackAlone, 18);
        emit log_named_decimal_uint("bob gets back in the batch (ETH)", bobBackBatch, 18);
        assertGt(bobBackBatch, bobBackAlone, "the round trip through the pool cost real money; the batch did not");
    }
}

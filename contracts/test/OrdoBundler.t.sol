// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/OrdoBundler.sol";

contract Target {
    uint256 public value;
    uint256 public callCount;

    function set(uint256 v) external {
        value = v;
        callCount++;
    }

    function boom() external pure {
        revert("boom");
    }

    /// @dev Pays back more than it was sent, standing in for a profitable leg.
    function profit(uint256 extra) external payable {
        payable(msg.sender).transfer(msg.value + extra);
    }

    function packed() external pure returns (bytes32) {
        // A word with a value in the low 160 bits and noise above it, like a
        // Uniswap v4 slot0 packing sqrtPriceX96 under a tick.
        return bytes32((uint256(0xabcd) << 160) | uint256(1_000_000));
    }

    receive() external payable {}
}

contract OrdoBundlerTest is Test {
    OrdoBundler bundler;
    Target target;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        bundler = new OrdoBundler();
        target = new Target();
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(address(target), 100 ether);
    }

    function _exec(address owner) internal returns (OrdoExecutor) {
        return OrdoExecutor(payable(bundler.deploy(owner)));
    }

    function _setCall(uint256 v) internal view returns (Call memory) {
        return Call(address(target), 0, abi.encodeCall(Target.set, (v)), false);
    }

    // --- addressing -----------------------------------------------------

    function test_ExecutorAddressIsDerivableBeforeDeployment() public {
        address predicted = bundler.executorOf(alice);
        assertFalse(bundler.isDeployed(alice), "not deployed yet");
        assertEq(address(_exec(alice)), predicted, "CREATE2 address matches prediction");
        assertTrue(bundler.isDeployed(alice));
    }

    function test_DeployIsIdempotent() public {
        assertEq(address(_exec(alice)), address(_exec(alice)), "second deploy returns the same executor");
    }

    function test_EachOwnerGetsADistinctExecutor() public {
        assertTrue(bundler.executorOf(alice) != bundler.executorOf(bob));
        assertEq(_exec(alice).owner(), alice);
        assertEq(_exec(bob).owner(), bob);
    }

    function test_DeployingAnothersExecutorStillMakesThemTheOwner() public {
        // The salt is the owner, so a griefer can pay to deploy your executor
        // but cannot make themselves its owner.
        vm.prank(bob);
        OrdoExecutor e = OrdoExecutor(payable(bundler.deploy(alice)));
        assertEq(e.owner(), alice);
    }

    // --- authorisation --------------------------------------------------

    function test_OnlyOwnerCanExecute() public {
        OrdoExecutor e = _exec(alice);
        Call[] memory calls = new Call[](1);
        calls[0] = _setCall(1);

        vm.prank(bob);
        vm.expectRevert(OrdoExecutor.NotOwner.selector);
        e.execute(calls, new Check[](0), 0, 0);
    }

    function test_OnlyOwnerCanWithdraw() public {
        OrdoExecutor e = _exec(alice);
        vm.deal(address(e), 1 ether);
        vm.prank(bob);
        vm.expectRevert(OrdoExecutor.NotOwner.selector);
        e.withdraw(bob, 1 ether);

        vm.prank(alice);
        e.withdraw(alice, 1 ether);
        assertEq(alice.balance, 101 ether);
    }

    // --- atomicity ------------------------------------------------------

    function test_AllLegsRunWhenNoneRevert() public {
        OrdoExecutor e = _exec(alice);
        Call[] memory calls = new Call[](3);
        calls[0] = _setCall(1);
        calls[1] = _setCall(2);
        calls[2] = _setCall(3);

        vm.prank(alice);
        e.execute(calls, new Check[](0), 0, 0);

        assertEq(target.value(), 3);
        assertEq(target.callCount(), 3);
    }

    function test_OneRevertingLegUnwindsTheWholeBundle() public {
        OrdoExecutor e = _exec(alice);
        Call[] memory calls = new Call[](3);
        calls[0] = _setCall(7);
        calls[1] = Call(address(target), 0, abi.encodeCall(Target.boom, ()), false);
        calls[2] = _setCall(9);

        vm.prank(alice);
        vm.expectRevert();
        e.execute(calls, new Check[](0), 0, 0);

        assertEq(target.value(), 0, "the first leg was rolled back");
        assertEq(target.callCount(), 0, "nothing persisted");
    }

    function test_AllowFailureLetsAnOptionalLegFail() public {
        OrdoExecutor e = _exec(alice);
        Call[] memory calls = new Call[](2);
        calls[0] = Call(address(target), 0, abi.encodeCall(Target.boom, ()), true);
        calls[1] = _setCall(5);

        vm.prank(alice);
        e.execute(calls, new Check[](0), 0, 0);
        assertEq(target.value(), 5, "the bundle continued past the tolerated failure");
    }

    // --- conditional execution ------------------------------------------

    function test_FailedPreconditionRevertsBeforeAnyCallRuns() public {
        OrdoExecutor e = _exec(alice);
        Call[] memory calls = new Call[](1);
        calls[0] = _setCall(42);

        Check[] memory checks = new Check[](1);
        checks[0] = Check({
            target: address(target),
            data: abi.encodeWithSignature("value()"),
            mask: bytes32(type(uint256).max),
            expected: bytes32(uint256(999)),
            op: Op.Eq
        });

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OrdoExecutor.CheckFailed.selector, 0, bytes32(0), bytes32(uint256(999))));
        e.execute(calls, checks, 0, 0);

        assertEq(target.callCount(), 0, "the bundle refused to trade");
    }

    function test_GteAndLteComparisons() public {
        OrdoExecutor e = _exec(alice);
        target.set(500);

        Check[] memory gte = new Check[](1);
        gte[0] = Check(address(target), abi.encodeWithSignature("value()"), bytes32(type(uint256).max), bytes32(uint256(400)), Op.Gte);
        assertTrue(e.checksPass(gte), "500 >= 400");

        Check[] memory lte = new Check[](1);
        lte[0] = Check(address(target), abi.encodeWithSignature("value()"), bytes32(type(uint256).max), bytes32(uint256(400)), Op.Lte);
        assertFalse(e.checksPass(lte), "500 is not <= 400");
    }

    function test_MaskIsolatesAPackedField() public {
        OrdoExecutor e = _exec(alice);
        Check[] memory checks = new Check[](1);
        checks[0] = Check({
            target: address(target),
            data: abi.encodeCall(Target.packed, ()),
            mask: bytes32(uint256(type(uint160).max)),
            expected: bytes32(uint256(1_000_000)),
            op: Op.Eq
        });
        assertTrue(e.checksPass(checks), "the low 160 bits compare cleanly through the mask");
    }

    function test_ACheckAgainstARevertingViewIsAFailure() public {
        OrdoExecutor e = _exec(alice);
        Check[] memory checks = new Check[](1);
        checks[0] = Check(address(target), abi.encodeCall(Target.boom, ()), bytes32(type(uint256).max), bytes32(0), Op.Eq);

        assertFalse(e.checksPass(checks));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OrdoExecutor.CheckReverted.selector, 0));
        e.execute(new Call[](0), checks, 0, 0);
    }

    // --- bounds ---------------------------------------------------------

    function test_MaxBlockBoundsTheBundle() public {
        OrdoExecutor e = _exec(alice);
        vm.roll(100);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OrdoExecutor.DeadlinePassed.selector, uint64(99), uint256(100)));
        e.execute(new Call[](0), new Check[](0), 99, 0);

        vm.prank(alice);
        e.execute(new Call[](0), new Check[](0), 100, 0); // inclusive, and zero disables
    }

    function test_MinGainRevertsAnUnprofitableBundle() public {
        OrdoExecutor e = _exec(alice);
        Call[] memory calls = new Call[](1);
        calls[0] = Call(address(target), 1 ether, abi.encodeCall(Target.profit, (0.001 ether)), false);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                OrdoExecutor.GainTooLow.selector, uint256(1 ether), uint256(1.001 ether), uint256(1.5 ether)
            )
        );
        e.execute{value: 1 ether}(calls, new Check[](0), 0, 0.5 ether);
    }

    function test_MinGainPassesAProfitableBundle() public {
        OrdoExecutor e = _exec(alice);
        Call[] memory calls = new Call[](1);
        calls[0] = Call(address(target), 1 ether, abi.encodeCall(Target.profit, (0.6 ether)), false);

        vm.prank(alice);
        e.execute{value: 1 ether}(calls, new Check[](0), 0, 0.5 ether);
        assertEq(address(e).balance, 1.6 ether, "capital returned plus profit");
    }

    function testFuzz_MinGainIsExactlyTheBoundary(uint96 gain, uint96 required) public {
        OrdoExecutor e = _exec(alice);
        vm.assume(gain < 10 ether && required < 10 ether);

        Call[] memory calls = new Call[](1);
        calls[0] = Call(address(target), 1 ether, abi.encodeCall(Target.profit, (gain)), false);

        vm.prank(alice);
        if (uint256(gain) >= uint256(required)) {
            e.execute{value: 1 ether}(calls, new Check[](0), 0, required);
        } else {
            vm.expectRevert();
            e.execute{value: 1 ether}(calls, new Check[](0), 0, required);
        }
    }
}

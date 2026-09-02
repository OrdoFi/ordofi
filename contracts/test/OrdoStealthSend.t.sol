// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/OrdoStealthSend.sol";

/// Stand-in for the canonical announcer, etched at its well-known address so
/// the contract under test is byte-for-byte what ships.
contract MockAnnouncer {
    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed caller,
        bytes ephemeralPubKey,
        bytes metadata
    );

    uint256 public count;

    function announce(uint256 schemeId, address stealthAddress, bytes memory ephemeralPubKey, bytes memory metadata)
        external
    {
        count++;
        emit Announcement(schemeId, stealthAddress, msg.sender, ephemeralPubKey, metadata);
    }
}

contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (allowance[from][msg.sender] < amount || balanceOf[from] < amount) return false;
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// Something at the receiving address that refuses ETH: must fail the whole call.
contract Refuses {
    receive() external payable {
        revert("no");
    }
}

contract OrdoStealthSendTest is Test {
    address constant ANNOUNCER = 0x55649E01B5Df198D18D95b5cc5051630cfD45564;

    OrdoStealthSend send;
    MockAnnouncer announcer;
    MockToken token;
    address alice = makeAddr("alice");
    address stealth = makeAddr("stealth");
    address treasury = makeAddr("treasury");
    bytes ephemeral = hex"02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    bytes metadata = hex"2a";

    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed caller,
        bytes ephemeralPubKey,
        bytes metadata
    );

    function setUp() public {
        vm.etch(ANNOUNCER, address(new MockAnnouncer()).code);
        announcer = MockAnnouncer(ANNOUNCER);
        send = new OrdoStealthSend(treasury);
        token = new MockToken();
        vm.deal(alice, 10 ether);
    }

    function test_sendETH_announcesAndDeliversInOneCall() public {
        vm.expectEmit(true, true, true, true, ANNOUNCER);
        emit Announcement(1, stealth, address(send), ephemeral, metadata);

        vm.prank(alice);
        send.sendETH{value: 1 ether}(stealth, ephemeral, metadata);

        assertEq(stealth.balance, 0.9975 ether, "ETH delivered less 0.25%");
        assertEq(treasury.balance, 0.0025 ether, "fee to treasury");
        assertEq(announcer.count(), 1, "exactly one announcement");
        assertEq(address(send).balance, 0, "contract keeps nothing");
    }

    function test_split_isExactAndNeverLosesWei() public view {
        (uint256 fee, uint256 net) = send.split(1 ether);
        assertEq(fee, 0.0025 ether);
        assertEq(net + fee, 1 ether);
        (fee, net) = send.split(1);
        assertEq(fee, 0, "sub-wei fee rounds to zero, never up");
        assertEq(net, 1);
    }

    function test_constructor_refusesZeroTreasury() public {
        vm.expectRevert(OrdoStealthSend.ZeroAddress.selector);
        new OrdoStealthSend(address(0));
    }

    function test_sendETH_refusesZero() public {
        vm.prank(alice);
        vm.expectRevert(OrdoStealthSend.NothingToSend.selector);
        send.sendETH{value: 0}(stealth, ephemeral, metadata);
        assertEq(announcer.count(), 0, "no announcement without money");
    }

    function test_sendETH_failedDeliveryRevertsTheAnnouncementToo() public {
        address refuses = address(new Refuses());
        vm.prank(alice);
        vm.expectRevert(OrdoStealthSend.DeliveryFailed.selector);
        send.sendETH{value: 1 ether}(refuses, ephemeral, metadata);
        assertEq(announcer.count(), 0, "an announcement must never stand without the funds");
        assertEq(alice.balance, 10 ether, "sender keeps their ETH");
        assertEq(treasury.balance, 0, "no fee on a failed payment");
    }

    function test_sendToken_movesTokensAndGasTogether() public {
        token.mint(alice, 1_000e6);
        vm.startPrank(alice);
        token.approve(address(send), type(uint256).max);
        send.sendToken{value: 0.00006 ether}(address(token), 250e6, stealth, ephemeral, metadata);
        vm.stopPrank();

        assertEq(token.balanceOf(stealth), 249_375_000, "tokens delivered less 0.25%");
        assertEq(token.balanceOf(treasury), 625_000, "fee to treasury");
        assertEq(token.balanceOf(alice), 750e6, "taken from the sender");
        assertEq(stealth.balance, 0.00006 ether, "gas stipend delivered in full, uncharged");
        assertEq(treasury.balance, 0, "no fee on the gas stipend");
        assertEq(announcer.count(), 1);
        assertEq(address(send).balance, 0, "contract keeps nothing");
    }

    function test_sendToken_worksWithoutGasStipend() public {
        token.mint(alice, 100e6);
        vm.startPrank(alice);
        token.approve(address(send), 100e6);
        send.sendToken(address(token), 100e6, stealth, ephemeral, metadata);
        vm.stopPrank();
        assertEq(token.balanceOf(stealth), 99_750_000);
        assertEq(token.balanceOf(treasury), 250_000);
        assertEq(stealth.balance, 0);
    }

    function test_sendToken_insufficientAllowanceRevertsEverything() public {
        token.mint(alice, 100e6);
        vm.startPrank(alice);
        token.approve(address(send), 1e6);
        vm.expectRevert(OrdoStealthSend.DeliveryFailed.selector);
        send.sendToken{value: 0.00006 ether}(address(token), 100e6, stealth, ephemeral, metadata);
        vm.stopPrank();
        assertEq(announcer.count(), 0, "no announcement without the tokens");
        assertEq(stealth.balance, 0, "no gas delivered without the tokens");
        assertEq(alice.balance, 10 ether);
    }

    function test_sendToken_refusesZero() public {
        vm.prank(alice);
        vm.expectRevert(OrdoStealthSend.NothingToSend.selector);
        send.sendToken(address(token), 0, stealth, ephemeral, metadata);
    }

    function test_hasNoWayToHoldFunds() public {
        // No receive/fallback: stray ETH sent directly is refused.
        vm.prank(alice);
        (bool ok,) = address(send).call{value: 1 ether}("");
        assertFalse(ok, "must not accept ETH outside a send");
        assertEq(address(send).balance, 0);
    }
}

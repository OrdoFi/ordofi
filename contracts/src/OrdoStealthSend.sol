// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC5564Announcer {
    function announce(uint256 schemeId, address stealthAddress, bytes memory ephemeralPubKey, bytes memory metadata)
        external;
}

interface IERC20Minimal {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title OrdoStealthSend
/// @notice One transaction to pay a stealth address: announce it, then deliver.
///
/// Without this a private payment is two wallet confirmations for ETH and three
/// for a token (announce, transfer, gas for the recipient), and if the sender
/// closes the tab between them the money can be stranded at an address nobody
/// knows to look at. Here the announcement and the delivery are one atomic
/// call: either the recipient can find the funds, or nothing moved.
///
/// The contract holds nothing, owns nothing and has no admin. It forwards
/// `msg.value` in the same call it receives it, and moves tokens straight from
/// the sender to the stealth address with the sender's own allowance. There is
/// no state to upgrade and no key that could drain it.
///
/// It is deliberately a thin wrapper over the canonical ERC-5564 announcer at
/// its well-known address, so payments made through it are indistinguishable
/// from any other ERC-5564 payment on the chain and any compliant scanner can
/// find them.
contract OrdoStealthSend {
    IERC5564Announcer public constant ANNOUNCER = IERC5564Announcer(0x55649E01B5Df198D18D95b5cc5051630cfD45564);

    /// @notice ERC-5564 scheme 1: secp256k1 with view tags.
    uint256 public constant SCHEME_ID = 1;

    error NothingToSend();
    error DeliveryFailed();

    /// @notice Pay `stealthAddress` the ETH attached to this call.
    /// @param ephemeralPubKey The sender's one-time public key the recipient needs to derive their key.
    /// @param metadata View tag plus what was sent, per the app's ERC-5564 metadata layout.
    function sendETH(address stealthAddress, bytes calldata ephemeralPubKey, bytes calldata metadata)
        external
        payable
    {
        if (msg.value == 0) revert NothingToSend();
        ANNOUNCER.announce(SCHEME_ID, stealthAddress, ephemeralPubKey, metadata);
        _deliver(stealthAddress, msg.value);
    }

    /// @notice Pay `stealthAddress` `amount` of `token` from the caller's allowance.
    /// @dev Any ETH attached is forwarded too. A token at a brand new address
    ///      cannot pay for its own withdrawal, so the sender includes the gas.
    function sendToken(
        address token,
        uint256 amount,
        address stealthAddress,
        bytes calldata ephemeralPubKey,
        bytes calldata metadata
    ) external payable {
        if (amount == 0) revert NothingToSend();
        ANNOUNCER.announce(SCHEME_ID, stealthAddress, ephemeralPubKey, metadata);
        if (!IERC20Minimal(token).transferFrom(msg.sender, stealthAddress, amount)) revert DeliveryFailed();
        if (msg.value > 0) _deliver(stealthAddress, msg.value);
    }

    function _deliver(address to, uint256 value) private {
        // A stealth address is a fresh externally-owned account, so a plain
        // transfer is all that is needed. If someone somehow points this at a
        // contract that refuses ETH, the whole payment reverts rather than the
        // announcement standing without the money.
        (bool ok,) = to.call{value: value}("");
        if (!ok) revert DeliveryFailed();
    }
}

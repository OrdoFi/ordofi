// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/OrdoSettlement.sol";
import "../src/OrdoBundler.sol";

/// @notice Deploys OrdoFi's two on-chain pieces in one broadcast: the auction's
///         settlement contract and the atomic bundle factory.
///
/// @dev They are deployed together because a deployment that has one and not
///      the other is a half-configured gateway — the auction cannot settle, or
///      `ordo_sendBundle` cannot offer atomicity — and finding that out later
///      costs a second broadcast and a second set of addresses to distribute.
///
///      `OrdoBundler` takes no constructor arguments and holds no funds or
///      privileges: it is a factory whose only job is CREATE2, so it needs no
///      owner and there is nothing about it to configure.
///
///      Run through `deploy.sh`, which does the preflight this cannot.
contract Deploy is Script {
    function run(address auctioneer, address treasury, uint16 appBps, uint16 protocolBps)
        external
        returns (OrdoSettlement settlement, OrdoBundler bundler)
    {
        vm.startBroadcast();
        settlement = new OrdoSettlement(auctioneer, treasury, appBps, protocolBps);
        bundler = new OrdoBundler();
        vm.stopBroadcast();

        console2.log("ORDO_SETTLEMENT_ADDRESS=%s", address(settlement));
        console2.log("ORDO_BUNDLER_ADDRESS=%s", address(bundler));
    }
}

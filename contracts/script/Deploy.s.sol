// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/OrdoSettlement.sol";

/// @notice Deploys OrdoSettlement.
/// Usage:
///   forge script script/Deploy.s.sol \
///     --rpc-url robinhood --broadcast \
///     --private-key $DEPLOYER_KEY \
///     --sig "run(address,address,uint16,uint16)" \
///     $AUCTIONEER $TREASURY 500 500
contract Deploy is Script {
    function run(address auctioneer, address treasury, uint16 appBps, uint16 protocolBps)
        external
        returns (OrdoSettlement settlement)
    {
        vm.startBroadcast();
        settlement = new OrdoSettlement(auctioneer, treasury, appBps, protocolBps);
        vm.stopBroadcast();
        console2.log("OrdoSettlement deployed at:", address(settlement));
    }
}

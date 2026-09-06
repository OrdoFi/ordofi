// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/OrdoSettlement.sol";

/// @notice Redeploys OrdoSettlement alone, with the withdrawal delay. The
///         bundler and everything else stay where they are.
///
///   forge script script/DeploySettlementV2.s.sol --rpc-url $RPC --account ordo-deployer --broadcast \
///     --sig "run(address,address,uint16,uint16,uint64)" $AUCTIONEER $TREASURY 500 500 120
contract DeploySettlementV2 is Script {
    function run(address auctioneer, address treasury, uint16 appBps, uint16 protocolBps, uint64 withdrawDelay)
        external
        returns (OrdoSettlement settlement)
    {
        require(block.chainid == 4663, "Robinhood Chain only");
        vm.startBroadcast();
        settlement = new OrdoSettlement(auctioneer, treasury, appBps, protocolBps, withdrawDelay);
        vm.stopBroadcast();
        console2.log("ORDO_SETTLEMENT_ADDRESS=%s", address(settlement));
    }
}

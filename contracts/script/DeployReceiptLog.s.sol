// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/OrdoReceiptLog.sol";

/// @notice Deploys the receipt anchor. Separate from Deploy.s.sol because the
///         settlement contract is already live; this one takes its address
///         rather than deploying a fresh stack.
///
///   forge script script/DeployReceiptLog.s.sol \
///     --rpc-url https://rpc.mainnet.chain.robinhood.com \
///     --account ordo-deployer --broadcast \
///     --sig "run(address)" $ORDO_SETTLEMENT_ADDRESS
contract DeployReceiptLog is Script {
    function run(address settlement) external returns (OrdoReceiptLog log) {
        require(settlement != address(0), "settlement address required");
        require(settlement.code.length > 0, "no contract at the settlement address");

        vm.startBroadcast();
        log = new OrdoReceiptLog(settlement);
        vm.stopBroadcast();

        console2.log("ORDO_RECEIPT_LOG_ADDRESS=%s", address(log));
    }
}

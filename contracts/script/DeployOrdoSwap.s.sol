// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/OrdoSwap.sol";

/// @notice Deploys OrdoSwap, the swap that keeps its own MEV.
///
///   forge script script/DeployOrdoSwap.s.sol \
///     --rpc-url $RPC --account ordo-deployer --broadcast \
///     --sig "run(address,address,uint16)" $OWNER $TREASURY 1000
///
/// The float is funded separately (`fund()` is open to anyone; only the
/// owner can withdraw), so the deployer key never has to hold the capital.
contract DeployOrdoSwap is Script {
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;

    function run(address owner, address treasury, uint16 protocolBps) external returns (OrdoSwap ordo) {
        require(block.chainid == 4663, "Robinhood Chain only");
        require(WETH.code.length > 0 && ROUTER.code.length > 0, "WETH/router missing on this chain");

        vm.startBroadcast();
        ordo = new OrdoSwap(WETH, ROUTER, owner, treasury, protocolBps);
        vm.stopBroadcast();

        console2.log("ORDO_SWAP_ADDRESS=%s", address(ordo));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/OrdoSwapV2.sol";

/// @notice Deploys OrdoSwapV2: the swap that keeps its own MEV, on V3 and V4.
///
///   forge script script/DeployOrdoSwapV2.s.sol --rpc-url $RPC --private-key $KEY --broadcast \
///     --sig "run(address,address,uint16)" $OWNER $TREASURY 1000
contract DeployOrdoSwapV2 is Script {
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    function run(address owner, address treasury, uint16 protocolBps) external returns (OrdoSwapV2 ordo) {
        require(block.chainid == 4663, "Robinhood Chain only");
        require(WETH.code.length > 0 && ROUTER.code.length > 0 && POOL_MANAGER.code.length > 0, "venues missing on this chain");
        vm.startBroadcast();
        ordo = new OrdoSwapV2(WETH, ROUTER, POOL_MANAGER, owner, treasury, protocolBps);
        vm.stopBroadcast();
        console2.log("ORDO_SWAP_ADDRESS=%s", address(ordo));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {OrdoLadderManager} from "../src/OrdoLadderManager.sol";
import {OrdoLadderManagerV4} from "../src/OrdoLadderManagerV4.sol";
import {OrdoStakeFactory} from "../src/OrdoStakes.sol";
import {OrdoStakeFactoryV4} from "../src/OrdoStakesV4.sol";

/// @notice The second generation of the liquidity contracts, in one broadcast:
///         both ladder managers (compound, collectMany) and both stake
///         factories (farms that compound in one call, zaps that exit in one).
///
/// @dev Same constructor arguments as the first generation, read from the
///      deployed contracts, so fees keep going to the same treasury. Nothing
///      about the first generation changes; positions and stakes stay where
///      they are and the UI reads both.
///
///      forge script script/DeployGen2.s.sol --rpc-url robinhood --broadcast \
///        --sig "run(address,address,address,address,address)" $NPM $ROUTER $POSM $STATE_VIEW $TREASURY
contract DeployGen2 is Script {
    function run(address npm, address router, address posm, address stateView, address treasury)
        external
        returns (OrdoLadderManager mgr3, OrdoLadderManagerV4 mgr4, OrdoStakeFactory factory3, OrdoStakeFactoryV4 factory4)
    {
        vm.startBroadcast();
        mgr3 = new OrdoLadderManager(npm, treasury);
        mgr4 = new OrdoLadderManagerV4(posm, stateView, treasury);
        factory3 = new OrdoStakeFactory(npm, router, treasury);
        factory4 = new OrdoStakeFactoryV4(posm, stateView, treasury);
        vm.stopBroadcast();

        console2.log("LADDER_MANAGER_GEN2=%s", address(mgr3));
        console2.log("LADDER_MANAGER_V4_GEN2=%s", address(mgr4));
        console2.log("STAKE_FACTORY_GEN2=%s zap=%s", address(factory3), address(factory3.zap()));
        console2.log("STAKE_FACTORY_V4_GEN2=%s zap=%s", address(factory4), address(factory4.zap()));
    }
}

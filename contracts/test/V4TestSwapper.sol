// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoolKey, IPoolManagerV4, IERC20Minimal} from "../src/V4Common.sol";

/// A whale's hands for fork tests: pays exact-in swaps from its own balance and
/// sends the output to the caller. V4 has no router of record on this chain, so
/// the tests drive the PoolManager directly through unlock/swap/settle.
contract V4TestSwapper {
    IPoolManagerV4 immutable pm;
    uint160 constant MIN_SQRT_PRICE = 4295128739;
    uint160 constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    constructor(address pm_) {
        pm = IPoolManagerV4(pm_);
    }

    receive() external payable {}

    function swapExactIn(PoolKey calldata key, bool zeroForOne, uint256 amountIn) external payable {
        pm.unlock(abi.encode(msg.sender, key, zeroForOne, amountIn));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (address to, PoolKey memory key, bool zeroForOne, uint256 amountIn) = abi.decode(data, (address, PoolKey, bool, uint256));
        int256 delta = pm.swap(key, IPoolManagerV4.SwapParams(zeroForOne, -int256(amountIn), zeroForOne ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1), "");
        _settle(key.currency0, int128(delta >> 128), to);
        _settle(key.currency1, int128(delta), to);
        return "";
    }

    function _settle(address currency, int128 d, address to) private {
        if (d < 0) {
            uint256 owed = uint256(uint128(-d));
            if (currency == address(0)) {
                pm.settle{value: owed}();
            } else {
                pm.sync(currency);
                IERC20Minimal(currency).transfer(address(pm), owed);
                pm.settle();
            }
        } else if (d > 0) {
            pm.take(currency, to, uint256(uint128(d)));
        }
    }
}

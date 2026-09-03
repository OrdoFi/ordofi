// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TickMath} from "./vendor/v4/TickMath.sol";
import {SqrtPriceMath} from "./vendor/v4/SqrtPriceMath.sol";
import {LiquidityAmounts} from "./vendor/v4/LiquidityAmounts.sol";
import {FullMath} from "./vendor/v4/FullMath.sol";
import {FixedPoint96} from "./vendor/v4/FixedPoint96.sol";

/// What Ordo's V4 contracts share: the pool key, the surfaces of the
/// PoolManager, PositionManager, StateView and Permit2 they call, the
/// PositionManager's action codes, the liquidity arithmetic that has to agree
/// with the pool's own, and a swap that settles itself.

/// The pool key V4 hashes into a PoolId. Sorted: currency0 < currency1, and
/// native ETH is address zero, so an ETH pool always has ETH as currency0.
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

interface IERC20Minimal {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// The singleton every V4 pool lives in. Swaps run inside `unlock`, which
/// calls back into the caller; every currency delta must be settled or taken
/// before the callback returns.
interface IPoolManagerV4 {
    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified; // negative: exact input
        uint160 sqrtPriceLimitX96;
    }
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256 delta);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

/// Uniswap V4 PositionManager: every position is an ERC-721 minted, topped
/// up, decreased and burned through one batched `modifyLiquidities` call.
interface IPositionManagerV4 {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128);
    function getPoolAndPositionInfo(uint256 tokenId) external view returns (PoolKey memory, uint256 info);
    function poolManager() external view returns (address);
    function permit2() external view returns (address);
    function WETH9() external view returns (address);
    function nextTokenId() external view returns (uint256);
}

/// V4's read lens: pool state lives inside the PoolManager and is only
/// exposed through extsload; StateView decodes it.
interface IStateView {
    function getSlot0(bytes32 poolId) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
    function getLiquidity(bytes32 poolId) external view returns (uint128);
}

/// Permit2's allowance-transfer surface: the PositionManager pulls ERC-20s from
/// whoever called it through this, never through a plain ERC-20 allowance.
interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
    function allowance(address user, address token, address spender) external view returns (uint160 amount, uint48 expiration, uint48 nonce);
}

/// PositionManager action codes (v4-periphery Actions).
library V4Actions {
    uint8 internal constant INCREASE_LIQUIDITY = 0x00;
    uint8 internal constant DECREASE_LIQUIDITY = 0x01;
    uint8 internal constant MINT_POSITION = 0x02;
    uint8 internal constant BURN_POSITION = 0x03;
    uint8 internal constant SETTLE_PAIR = 0x0d;
    uint8 internal constant TAKE_PAIR = 0x11;
    uint8 internal constant SWEEP = 0x14;

    address internal constant NATIVE = address(0);
}

library V4Pool {
    /// PoolId of a key, as the PoolManager computes it.
    function id(PoolKey memory key) internal pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }
}

/// Liquidity for a budget, and what the pool charges for it, with the
/// PoolManager's own arithmetic so the two never disagree.
library V4Liquidity {
    /// Liquidity that `amount0`/`amount1` buy in [tickLower, tickUpper) at the
    /// live price, and the exact amounts the pool will take for it. Never more
    /// than the budget: rounding up twice can ask for one wei over, and one wei
    /// less budget makes the liquidity fit.
    function size(int24 tickLower, int24 tickUpper, uint256 amount0, uint256 amount1, uint160 sqrtP, int24 tick)
        internal
        pure
        returns (uint128 liq, uint256 need0, uint256 need1)
    {
        uint160 sqrtL = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtU = TickMath.getSqrtPriceAtTick(tickUpper);
        liq = LiquidityAmounts.getLiquidityForAmounts(sqrtP, sqrtL, sqrtU, amount0, amount1);
        (need0, need1) = amountsIn(liq, sqrtP, tick, tickLower, tickUpper, sqrtL, sqrtU);
        if (need0 > amount0 || need1 > amount1) {
            liq = LiquidityAmounts.getLiquidityForAmounts(
                sqrtP, sqrtL, sqrtU, need0 > amount0 ? amount0 - 1 : amount0, need1 > amount1 ? amount1 - 1 : amount1
            );
            (need0, need1) = amountsIn(liq, sqrtP, tick, tickLower, tickUpper, sqrtL, sqrtU);
        }
    }

    /// Token amounts the PoolManager charges to add `liq` — Pool.modifyLiquidity's
    /// branching on the tick, rounding up, exactly.
    function amountsIn(uint128 liq, uint160 sqrtP, int24 tick, int24 tickLower, int24 tickUpper, uint160 sqrtL, uint160 sqrtU)
        internal
        pure
        returns (uint256 a0, uint256 a1)
    {
        if (liq == 0) return (0, 0);
        if (tick < tickLower) {
            a0 = SqrtPriceMath.getAmount0Delta(sqrtL, sqrtU, liq, true);
        } else if (tick < tickUpper) {
            a0 = SqrtPriceMath.getAmount0Delta(sqrtP, sqrtU, liq, true);
            a1 = SqrtPriceMath.getAmount1Delta(sqrtL, sqrtP, liq, true);
        } else {
            a1 = SqrtPriceMath.getAmount1Delta(sqrtL, sqrtU, liq, true);
        }
    }

    /// What `amount1` of currency1 is worth in currency0 at `tick`.
    function quote1To0(uint256 amount1, int24 tick) internal pure returns (uint256) {
        uint160 sqrtP = TickMath.getSqrtPriceAtTick(tick);
        return FullMath.mulDiv(FullMath.mulDiv(amount1, FixedPoint96.Q96, sqrtP), FixedPoint96.Q96, sqrtP);
    }

    /// What `amount0` of currency0 is worth in currency1 at `tick`.
    function quote0To1(uint256 amount0, int24 tick) internal pure returns (uint256) {
        uint160 sqrtP = TickMath.getSqrtPriceAtTick(tick);
        return FullMath.mulDiv(FullMath.mulDiv(amount0, sqrtP, FixedPoint96.Q96), sqrtP, FixedPoint96.Q96);
    }
}

/// An exact-input swap through the PoolManager that pays for itself from this
/// contract's balance and takes the output to this contract. Native ETH is
/// paid from balance too: the caller must already hold it.
abstract contract V4Swap {
    IPoolManagerV4 internal immutable _poolManager;

    error NotPoolManager();
    error SwapMinOut(uint256 out, uint256 min);

    constructor(address poolManager_) {
        _poolManager = IPoolManagerV4(poolManager_);
    }

    /// Swap `amountIn` of one side for the other; reverts unless `minOut` comes back.
    function _swapExactIn(PoolKey memory key, bool zeroForOne, uint256 amountIn, uint256 minOut) internal returns (uint256 out) {
        if (amountIn == 0) return 0;
        bytes memory r = _poolManager.unlock(abi.encode(key, zeroForOne, amountIn, minOut));
        out = abi.decode(r, (uint256));
    }

    /// Same, but a swap that cannot reach `minOut` is skipped rather than reverted.
    function _trySwapExactIn(PoolKey memory key, bool zeroForOne, uint256 amountIn, uint256 minOut) internal returns (uint256 out) {
        if (amountIn == 0) return 0;
        try _poolManager.unlock(abi.encode(key, zeroForOne, amountIn, minOut)) returns (bytes memory r) {
            out = abi.decode(r, (uint256));
        } catch {}
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(_poolManager)) revert NotPoolManager();
        (PoolKey memory key, bool zeroForOne, uint256 amountIn, uint256 minOut) = abi.decode(data, (PoolKey, bool, uint256, uint256));
        int256 delta = _poolManager.swap(
            key,
            IPoolManagerV4.SwapParams(zeroForOne, -int256(amountIn), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            ""
        );
        // Positive: the pool owes us. Negative: we owe the pool.
        int128 d0 = int128(delta >> 128);
        int128 d1 = int128(delta);
        (address currencyIn, int128 dIn, address currencyOut, int128 dOut) = zeroForOne ? (key.currency0, d0, key.currency1, d1) : (key.currency1, d1, key.currency0, d0);
        uint256 out = dOut > 0 ? uint256(uint128(dOut)) : 0;
        if (out < minOut) revert SwapMinOut(out, minOut);
        if (dIn < 0) _pay(currencyIn, uint256(uint128(-dIn)));
        if (out > 0) _poolManager.take(currencyOut, address(this), out);
        return abi.encode(out);
    }

    function _pay(address currency, uint256 amount) private {
        if (currency == V4Actions.NATIVE) {
            _poolManager.settle{value: amount}();
        } else {
            _poolManager.sync(currency);
            IERC20Minimal(currency).transfer(address(_poolManager), amount);
            _poolManager.settle();
        }
    }
}

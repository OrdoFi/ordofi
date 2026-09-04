// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoolKey, V4Swap, V4Actions} from "./V4Common.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IWETH9 is IERC20 {
    function deposit() external payable;
    function withdraw(uint256) external;
}

interface ISwapRouter02 {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @title OrdoSwapV2
/// @notice The swap that keeps its own MEV — on Uniswap V3 and V4.
///
/// @dev ## What changed from v1
///
/// v1 swapped and back-ran through Uniswap V3 only. Most of the tokens people
/// actually trade on Robinhood Chain — every launchpad coin, including ORDO —
/// live in V4 pools inside the PoolManager singleton, many behind hooks. v2
/// executes a swap as a chain of *legs*, each on either venue, and runs the
/// back-run the same way. A leg is one V3 path (any number of hops) or one V4
/// pool; the output asset of a leg is the input of the next.
///
/// Ether exists in two forms here: WETH on V3 and native ETH (currency zero)
/// on V4. Between legs the contract converts whichever way the next leg needs,
/// and the float is kept as WETH so that "did the reclaim make money" is one
/// balance comparison.
///
/// ## Guarantees, unchanged from v1
///
///   1. The user's swap never fails because of the reclaim (self-call in
///      try/catch). If the reclaim cannot get the gas it needs, the whole
///      transaction reverts *before* the swap — so a wallet's gas estimate
///      lands on the path where the reclaim runs, never the one where it
///      starves and is silently skipped.
///   2. Exactly the user's input is pulled and approved per leg; the float is
///      never an input to the user's legs.
///   3. The float cannot shrink: a reclaim starts and ends in ether and must
///      return `amountIn + minProfit` or it reverts alone.
///   4. `protocolBps` of the surplus stays; the rest is paid to the recipient.
contract OrdoSwapV2 is V4Swap {
    IWETH9 public immutable WETH;
    ISwapRouter02 public immutable ROUTER;

    address public owner;
    address public treasury;
    uint16 public protocolBps;
    uint16 public constant MAX_PROTOCOL_BPS = 5000;

    uint256 private _locked = 1;

    /// @notice A hop on one venue.
    /// @dev venue 0: Uniswap V3, `path` is the packed V3 path (may be multi-hop).
    ///      venue 1: Uniswap V4, `key` names the pool and `zeroForOne` the direction.
    struct Leg {
        uint8 venue;
        bytes path;
        PoolKey key;
        bool zeroForOne;
    }

    /// @notice The back-run to run behind the user's swap. Empty `legs` means none.
    struct Reclaim {
        Leg[] legs;
        /// WETH taken from the float.
        uint256 amountIn;
        /// The round trip must return at least `amountIn + minProfit`.
        uint256 minProfit;
        /// Gas the reclaim needs to run. If less is left when the reclaim would
        /// start, the transaction reverts before the swap; see `swap`.
        uint256 gas;
    }

    event Swapped(
        address indexed sender,
        address indexed recipient,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );
    event Reclaimed(address indexed recipient, uint256 profit, uint256 toUser, uint256 toProtocol);
    event ReclaimSkipped(address indexed recipient, bytes reason);
    event Funded(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event OwnershipTransferred(address indexed from, address indexed to);
    event TreasurySet(address indexed treasury);
    event ProtocolBpsSet(uint16 bps);

    error NotOwner();
    error NotSelf();
    error Reentrancy();
    error BadPath();
    error BadLegs();
    error ValueMismatch(uint256 amountIn, uint256 msgValue);
    error NativeInMustBeEther();
    error TooLittleReceived(uint256 amountOut, uint256 minimum);
    error InsufficientGasForReclaim(uint256 left, uint256 needed);
    error ReclaimNotEtherClosed();
    error TransferFailed();
    error BpsTooHigh(uint16 bps);
    error ZeroAddress();
    error QuoteResult(uint256 amountOut, uint256 reclaimProfit, bytes reclaimFailure);

    constructor(address weth, address router, address poolManager, address owner_, address treasury_, uint16 protocolBps_)
        V4Swap(poolManager)
    {
        if (weth == address(0) || router == address(0) || poolManager == address(0) || owner_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        if (protocolBps_ > MAX_PROTOCOL_BPS) revert BpsTooHigh(protocolBps_);
        WETH = IWETH9(weth);
        ROUTER = ISwapRouter02(router);
        owner = owner_;
        treasury = treasury_;
        protocolBps = protocolBps_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    // ------------------------------------------------------------------ swap

    /// @notice Swap along `legs`, then run `reclaim` behind it, in one transaction.
    ///
    /// @param legs             The user's route, one or more legs. Native ETH in
    ///                         is `msg.value` with the first leg taking ether.
    /// @param amountIn         Exact input; equals `msg.value` when paying in ETH.
    /// @param amountOutMinimum The user's slippage floor on the final output.
    /// @param recipient        Receives the output and the reclaimed surplus.
    /// @param nativeOut        Pay ether out as ETH rather than WETH. Requires the
    ///                         route to end in ether.
    /// @param reclaim          The back-run; empty `legs` for none.
    function swap(
        Leg[] calldata legs,
        uint256 amountIn,
        uint256 amountOutMinimum,
        address recipient,
        bool nativeOut,
        Reclaim calldata reclaim
    ) external payable nonReentrant returns (uint256 amountOut, uint256 surplus) {
        if (recipient == address(0)) revert ZeroAddress();
        if (legs.length == 0) revert BadLegs();

        // The reclaim's gas is checked up front, so that a transaction which
        // cannot afford the reclaim reverts instead of quietly skipping it.
        // This is what makes eth_estimateGas land on the right answer.
        if (reclaim.legs.length != 0 && gasleft() < reclaim.gas) revert InsufficientGasForReclaim(gasleft(), reclaim.gas);

        (address tokenIn, bool nativeIn) = _inputOf(legs[0]);
        address tokenOut = _outputOf(legs[legs.length - 1]);
        bool etherOut = tokenOut == address(WETH) || tokenOut == V4Actions.NATIVE;
        if (nativeOut && !etherOut) revert BadPath();

        // Take exactly the user's input and nothing from the float.
        if (msg.value != 0) {
            if (!(tokenIn == address(WETH) || nativeIn)) revert NativeInMustBeEther();
            if (amountIn != msg.value) revert ValueMismatch(amountIn, msg.value);
            // Held as native ETH; _run converts to WETH if the first leg is V3.
        } else {
            _pull(nativeIn ? address(WETH) : tokenIn, msg.sender, amountIn);
        }

        bool haveNative = msg.value != 0;
        (amountOut, haveNative) = _run(legs, amountIn, haveNative);
        if (amountOut < amountOutMinimum) revert TooLittleReceived(amountOut, amountOutMinimum);
        _deliver(tokenOut, etherOut, nativeOut, haveNative, recipient, amountOut);
        emit Swapped(msg.sender, recipient, nativeIn ? address(WETH) : tokenIn, etherOut ? address(WETH) : tokenOut, amountIn, amountOut);

        if (reclaim.legs.length != 0) {
            try this.reclaimFor(recipient, reclaim, nativeOut && etherOut) returns (uint256 toUser) {
                surplus = toUser;
            } catch (bytes memory reason) {
                emit ReclaimSkipped(recipient, reason);
            }
        }
    }

    /// @notice The reclaim leg. Only this contract may call it, from `swap` or `quote`.
    function reclaimFor(address recipient, Reclaim calldata r, bool nativeOut) external returns (uint256 toUser) {
        if (msg.sender != address(this)) revert NotSelf();
        (address first, bool firstNative) = _inputOf(r.legs[0]);
        address last = _outputOf(r.legs[r.legs.length - 1]);
        bool startsEther = first == address(WETH) || firstNative;
        bool endsEther = last == address(WETH) || last == V4Actions.NATIVE;
        if (!startsEther || !endsEther) revert ReclaimNotEtherClosed();

        // Everything the contract holds is the float, as WETH. Any native ETH
        // present at this point is a leftover of a V4 leg and belongs to it too.
        uint256 before = WETH.balanceOf(address(this)) + address(this).balance;
        (uint256 out, bool haveNative) = _run(r.legs, r.amountIn, false);
        if (haveNative) WETH.deposit{value: out}();
        uint256 after_ = WETH.balanceOf(address(this)) + address(this).balance;
        if (after_ < before + r.minProfit) revert TooLittleReceived(after_ > before ? after_ - before : 0, r.minProfit);
        uint256 profit = after_ - before;

        uint256 toProtocol = (profit * protocolBps) / 10_000;
        toUser = profit - toProtocol;
        if (nativeOut) {
            WETH.withdraw(toUser);
            _send(recipient, toUser);
        } else if (!WETH.transfer(recipient, toUser)) {
            revert TransferFailed();
        }
        emit Reclaimed(recipient, profit, toUser, toProtocol);
    }

    // ----------------------------------------------------------------- quote

    /// @notice What `swap` would return right now, for an ether-in route (the
    ///         value stands in for the user's input) or a token-in route when
    ///         the contract happens to hold the token. Always reverts with
    ///         `QuoteResult`; call with `eth_call` and decode.
    function quote(Leg[] calldata legs, uint256 amountIn, Reclaim calldata reclaim) external payable {
        if (legs.length == 0) revert BadLegs();
        (uint256 amountOut, bool haveNative) = _run(legs, amountIn, msg.value != 0);
        // Park the output as it would be delivered, so the reclaim sees the same state.
        if (haveNative) WETH.deposit{value: amountOut}();
        uint256 profit;
        bytes memory failure;
        if (reclaim.legs.length != 0) {
            uint256 before = WETH.balanceOf(address(this)) + address(this).balance;
            try this.reclaimFor(address(this), reclaim, false) {
                profit = WETH.balanceOf(address(this)) + address(this).balance - before;
            } catch (bytes memory reason) {
                failure = reason;
            }
        }
        revert QuoteResult(amountOut, profit, failure);
    }

    /// @notice What `reclaim` alone would make against the current state.
    ///         Always reverts with `QuoteResult(0, profit, failure)`. Meant to be
    ///         simulated right after a swap, so the search sees the state that
    ///         swap left behind.
    function quoteReclaim(Reclaim calldata reclaim) external {
        uint256 profit;
        bytes memory failure;
        uint256 before = WETH.balanceOf(address(this)) + address(this).balance;
        try this.reclaimFor(address(this), reclaim, false) {
            profit = WETH.balanceOf(address(this)) + address(this).balance - before;
        } catch (bytes memory reason) {
            failure = reason;
        }
        revert QuoteResult(0, profit, failure);
    }

    // ----------------------------------------------------------------- legs

    /// @dev Run legs in order. `haveNative` says whether the current amount is
    ///      held as native ETH (true) or as an ERC-20 / WETH (false). Returns the
    ///      final amount and how it is held.
    function _run(Leg[] calldata legs, uint256 amount, bool haveNative) private returns (uint256, bool) {
        for (uint256 i = 0; i < legs.length; i++) {
            Leg calldata l = legs[i];
            if (l.venue == 0) {
                // V3 wants ERC-20 in. Ether must be WETH.
                address tokenIn = _first(l.path);
                if (haveNative) {
                    if (tokenIn != address(WETH)) revert BadLegs();
                    WETH.deposit{value: amount}();
                    haveNative = false;
                }
                _approve(tokenIn, amount);
                amount = ROUTER.exactInput(
                    ISwapRouter02.ExactInputParams({path: l.path, recipient: address(this), amountIn: amount, amountOutMinimum: 0})
                );
                // Output is the path's last token, an ERC-20 (WETH if ether).
            } else if (l.venue == 1) {
                address cIn = l.zeroForOne ? l.key.currency0 : l.key.currency1;
                address cOut = l.zeroForOne ? l.key.currency1 : l.key.currency0;
                if (cIn == V4Actions.NATIVE) {
                    if (!haveNative) {
                        // Holding WETH; the pool wants ether.
                        WETH.withdraw(amount);
                    }
                } else if (haveNative) {
                    // Holding ETH but the pool wants a token: only WETH can be made from it.
                    if (cIn != address(WETH)) revert BadLegs();
                    WETH.deposit{value: amount}();
                }
                amount = _swapExactIn(l.key, l.zeroForOne, amount, 0);
                haveNative = cOut == V4Actions.NATIVE;
            } else {
                revert BadLegs();
            }
        }
        return (amount, haveNative);
    }

    function _deliver(address tokenOut, bool etherOut, bool nativeOut, bool haveNative, address to, uint256 amount) private {
        if (etherOut) {
            if (nativeOut) {
                if (!haveNative) WETH.withdraw(amount);
                _send(to, amount);
            } else {
                if (haveNative) WETH.deposit{value: amount}();
                if (!WETH.transfer(to, amount)) revert TransferFailed();
            }
        } else {
            if (haveNative) revert BadLegs();
            if (!IERC20(tokenOut).transfer(to, amount)) revert TransferFailed();
        }
    }

    /// @dev The asset a leg consumes: (token, isNativeEther).
    function _inputOf(Leg calldata l) private pure returns (address, bool) {
        if (l.venue == 0) return (_first(l.path), false);
        if (l.venue == 1) {
            address c = l.zeroForOne ? l.key.currency0 : l.key.currency1;
            return (c, c == V4Actions.NATIVE);
        }
        revert BadLegs();
    }

    /// @dev The asset a leg produces; address(0) for native ether.
    function _outputOf(Leg calldata l) private pure returns (address) {
        if (l.venue == 0) return _last(l.path);
        if (l.venue == 1) return l.zeroForOne ? l.key.currency1 : l.key.currency0;
        revert BadLegs();
    }

    // ----------------------------------------------------------------- admin

    function fund() external payable {
        WETH.deposit{value: msg.value}();
        emit Funded(msg.sender, msg.value);
    }

    function withdraw(address to, uint256 amount) external onlyOwner {
        WETH.withdraw(amount);
        _send(to, amount);
        emit Withdrawn(to, amount);
    }

    function withdrawToken(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(WETH)) revert BadPath();
        if (!IERC20(token).transfer(to, amount)) revert TransferFailed();
    }

    function setProtocolBps(uint16 bps) external onlyOwner {
        if (bps > MAX_PROTOCOL_BPS) revert BpsTooHigh(bps);
        protocolBps = bps;
        emit ProtocolBpsSet(bps);
    }

    function setTreasury(address t) external onlyOwner {
        if (t == address(0)) revert ZeroAddress();
        treasury = t;
        emit TreasurySet(t);
    }

    function transferOwnership(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, to);
        owner = to;
    }

    /// @notice The float, as WETH plus any ether momentarily held between legs.
    function float() external view returns (uint256) {
        return WETH.balanceOf(address(this)) + address(this).balance;
    }

    // -------------------------------------------------------------- internal

    function _first(bytes calldata path) private pure returns (address) {
        if (path.length < 43) revert BadPath();
        return address(bytes20(path[0:20]));
    }

    function _last(bytes calldata path) private pure returns (address) {
        if (path.length < 43 || (path.length - 20) % 23 != 0) revert BadPath();
        return address(bytes20(path[path.length - 20:]));
    }

    function _pull(address token, address from, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, address(this), amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _approve(address token, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.approve.selector, address(ROUTER), amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @dev Ether arrives from WETH.withdraw and from the PoolManager paying out a V4 swap.
    receive() external payable {
        if (msg.sender != address(WETH) && msg.sender != address(_poolManager)) revert BadPath();
    }
}

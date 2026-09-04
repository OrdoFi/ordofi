// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

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

/// @dev SwapRouter02. `ExactInputParams` carries no deadline; the caller's
///      transaction deadline is the router's `multicall(deadline, …)`, which we
///      do not go through.
interface ISwapRouter02 {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @title OrdoSwap
/// @notice A swap that keeps its own MEV.
///
/// @dev ## The problem, measured
///
/// Robinhood Chain sequences first-come-first-served with no mempool, so nobody
/// can front-run a swap — but anyone can land right behind it. A swap pushes
/// one fee tier of a pair away from the others; the transaction that follows
/// buys on the cheap tier and sells on the dear one and pockets the gap. That
/// follow-up is roughly $40,000 a day on this chain (sampled hourly over 24 h,
/// September 2026), taken from the people whose swaps created it.
///
/// ## What this contract does about it
///
/// It performs the user's swap and then, *in the same transaction*, executes
/// the arbitrage that swap just opened, and hands the proceeds to the user.
/// There is no second transaction for a bot to beat, because there is no gap
/// between the two legs at all. Nobody has to be fast; the reclaim is inside.
///
/// ## Guarantees, in order of importance
///
///   1. **The user's swap never fails because of the reclaim.** The reclaim
///      leg runs in a self-call wrapped in try/catch. If the edge is gone by
///      the time the transaction lands, or the caller's reclaim parameters are
///      wrong, the reclaim reverts alone, an event says so, and the swap stands.
///
///   2. **The user's funds are only ever the user's funds.** Exactly `amountIn`
///      is pulled from the caller and exactly `amountIn` is approved to the
///      router for that one swap. The contract's own capital (below) is never
///      an input to the user's leg.
///
///   3. **The float cannot shrink.** The reclaim trades the contract's WETH
///      float around a path that must start and end at WETH, with the router's
///      `amountOutMinimum` set to `amountIn + minProfit`. A reclaim that would
///      return less than it put in cannot execute. The only way capital leaves
///      is `withdraw`, owner-only.
///
///   4. **The split is fixed on-chain.** `protocolBps` of the reclaimed surplus
///      stays in the float (the protocol's share, withdrawable by the owner);
///      the rest is paid to the recipient in the same transaction. Default
///      1000 = 10%, so 90% to the user, matching Ordo VIA's split.
///
/// ## What it does not do
///
/// It does not choose the reclaim path or size — that is computed off-chain by
/// the gateway (`ordo_quoteSwap`), which simulates the user's swap and searches
/// the cycles it opens. This contract only checks the answer: the path is
/// WETH-closed and the round trip made at least `minProfit`. It also does not
/// promise a reclaim exists; most small swaps open nothing worth the gas, and
/// for those `reclaim.amountIn` is simply zero.
contract OrdoSwap {
    IWETH9 public immutable WETH;
    ISwapRouter02 public immutable ROUTER;

    address public owner;
    address public treasury;
    /// @notice Share of reclaimed surplus retained for the protocol, in basis points.
    uint16 public protocolBps;
    uint16 public constant MAX_PROTOCOL_BPS = 5000;

    uint256 private _locked = 1;

    /// @notice The arbitrage to run behind the user's swap. Zero `amountIn` means none.
    struct Reclaim {
        /// V3 packed path that starts and ends at WETH.
        bytes path;
        /// WETH taken from the float for the round trip.
        uint256 amountIn;
        /// The round trip must return at least `amountIn + minProfit` or it does not run.
        uint256 minProfit;
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
    error ValueMismatch(uint256 amountIn, uint256 msgValue);
    error NativeInMustBeWETH();
    error TransferFailed();
    error BpsTooHigh(uint16 bps);
    error ZeroAddress();
    /// @dev Carries the answer out of `quote`, which always reverts.
    error QuoteResult(uint256 amountOut, uint256 reclaimProfit, bytes reclaimFailure);

    constructor(address weth, address router, address owner_, address treasury_, uint16 protocolBps_) {
        if (weth == address(0) || router == address(0) || owner_ == address(0) || treasury_ == address(0)) {
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

    /// @notice Swap, then reclaim the arbitrage the swap opened, in one transaction.
    ///
    /// @param path             V3 packed path for the user's swap.
    /// @param amountIn         Exact input. With native ETH: must equal `msg.value`
    ///                         and the path must start at WETH.
    /// @param amountOutMinimum The user's slippage floor, enforced by the router.
    /// @param recipient        Who receives the output and the reclaimed surplus.
    /// @param nativeOut        Pay `recipient` in ETH rather than WETH (path must end at WETH).
    /// @param reclaim          The arbitrage to run behind the swap; `amountIn == 0` for none.
    ///
    /// @return amountOut       What the user's swap returned.
    /// @return surplus         What the reclaim paid the recipient on top, in WETH/ETH. Zero if skipped.
    function swap(
        bytes calldata path,
        uint256 amountIn,
        uint256 amountOutMinimum,
        address recipient,
        bool nativeOut,
        Reclaim calldata reclaim
    ) external payable nonReentrant returns (uint256 amountOut, uint256 surplus) {
        if (recipient == address(0)) revert ZeroAddress();
        address tokenIn = _first(path);
        address tokenOut = _last(path);

        // Take exactly the user's input, and nothing from the float.
        if (msg.value != 0) {
            if (tokenIn != address(WETH)) revert NativeInMustBeWETH();
            if (amountIn != msg.value) revert ValueMismatch(amountIn, msg.value);
            WETH.deposit{value: msg.value}();
        } else {
            _pull(tokenIn, msg.sender, amountIn);
        }

        bool unwrap = nativeOut && tokenOut == address(WETH);
        if (nativeOut && !unwrap) revert BadPath();

        _approve(tokenIn, amountIn);
        amountOut = ROUTER.exactInput(
            ISwapRouter02.ExactInputParams({
                path: path,
                recipient: unwrap ? address(this) : recipient,
                amountIn: amountIn,
                amountOutMinimum: amountOutMinimum
            })
        );
        if (unwrap) {
            // Exactly amountOut: the float is WETH too and must not be touched.
            WETH.withdraw(amountOut);
            _send(recipient, amountOut);
        }
        emit Swapped(msg.sender, recipient, tokenIn, tokenOut, amountIn, amountOut);

        // The reclaim, isolated: its failure is information, not a revert.
        if (reclaim.amountIn != 0) {
            try this.reclaimFor(recipient, reclaim, nativeOut) returns (uint256 toUser) {
                surplus = toUser;
            } catch (bytes memory reason) {
                emit ReclaimSkipped(recipient, reason);
            }
        }
    }

    /// @notice The reclaim leg. Only this contract may call it, from `swap`.
    /// @dev External so that `swap` can try/catch it. Not reentrancy-guarded
    ///      itself, because it runs inside `swap`'s guard; `NotSelf` is what
    ///      keeps anyone else from driving the float.
    function reclaimFor(address recipient, Reclaim calldata r, bool nativeOut) external returns (uint256 toUser) {
        if (msg.sender != address(this)) revert NotSelf();
        if (_first(r.path) != address(WETH) || _last(r.path) != address(WETH)) revert BadPath();

        uint256 before = WETH.balanceOf(address(this));
        _approve(address(WETH), r.amountIn);
        ROUTER.exactInput(
            ISwapRouter02.ExactInputParams({
                path: r.path,
                recipient: address(this),
                amountIn: r.amountIn,
                amountOutMinimum: r.amountIn + r.minProfit
            })
        );
        uint256 profit = WETH.balanceOf(address(this)) - before; // router enforced >= minProfit

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

    /// @notice What `swap` would return right now for a WETH-in swap. Always
    ///         reverts with `QuoteResult`; call it with `eth_call` and decode
    ///         the revert. Nothing is ever kept.
    /// @dev The user's input is stood in for by `msg.value` (wrapped), or by
    ///      the float when the call carries no value and `amountIn` fits in it.
    ///      An `eth_call` can attach value from any address the node lets it
    ///      spend from — a balance override, or simply the WETH contract, which
    ///      holds every wrapped ether — so a quote of any size costs nothing.
    ///      Token-in swaps are quoted by the gateway with `eth_simulateV1`
    ///      from the user's own address instead.
    function quote(bytes calldata path, uint256 amountIn, Reclaim calldata reclaim) external payable {
        if (_first(path) != address(WETH)) revert BadPath();
        if (msg.value != 0) WETH.deposit{value: msg.value}();
        _approve(address(WETH), amountIn);
        uint256 amountOut = ROUTER.exactInput(
            ISwapRouter02.ExactInputParams({
                path: path,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: 0
            })
        );
        uint256 profit;
        bytes memory failure;
        if (reclaim.amountIn != 0) {
            uint256 before = WETH.balanceOf(address(this));
            try this.reclaimFor(address(this), reclaim, false) {
                // The user share came back to us, so the balance delta is the whole profit.
                profit = WETH.balanceOf(address(this)) - before;
            } catch (bytes memory reason) {
                failure = reason;
            }
        }
        revert QuoteResult(amountOut, profit, failure);
    }

    // ----------------------------------------------------------------- admin

    /// @notice Add WETH to the float. ETH is wrapped; WETH can also be sent directly.
    function fund() external payable {
        WETH.deposit{value: msg.value}();
        emit Funded(msg.sender, msg.value);
    }

    /// @notice Take WETH out of the float, paid as ETH.
    function withdraw(address to, uint256 amount) external onlyOwner {
        WETH.withdraw(amount);
        _send(to, amount);
        emit Withdrawn(to, amount);
    }

    /// @notice Move a token that is not WETH (nothing should ever be here, but tokens get sent to addresses).
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

    /// @notice The float: WETH available to reclaim with.
    function float() external view returns (uint256) {
        return WETH.balanceOf(address(this));
    }

    // -------------------------------------------------------------- internal

    function _first(bytes calldata path) private pure returns (address) {
        if (path.length < 43) revert BadPath(); // token(20) fee(3) token(20)
        return address(bytes20(path[0:20]));
    }

    function _last(bytes calldata path) private pure returns (address) {
        if (path.length < 43 || (path.length - 20) % 23 != 0) revert BadPath();
        return address(bytes20(path[path.length - 20:]));
    }

    /// @dev Raw calls so non-standard tokens that return nothing still work.
    function _pull(address token, address from, uint256 amount) private {
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, address(this), amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _approve(address token, uint256 amount) private {
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSelector(IERC20.approve.selector, address(ROUTER), amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @dev WETH.withdraw pays us in ETH; nothing else should.
    receive() external payable {
        if (msg.sender != address(WETH)) revert BadPath();
    }
}

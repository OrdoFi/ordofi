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

interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

/// @title OrdoBatch
/// @notice Batch settlement for Robinhood Chain: opposite orders on the same
///         pair are matched against each other and only the residual is sent
///         through the AMM. Everyone in a batch clears at one price per token.
///
/// @dev ## Why
///
/// On a thin pool a $500 buy can move the price 38%, and the seller one block
/// later moves it back. Both paid for the round trip. If the two had met first,
/// neither would have touched the pool. The chain produces a block every 100 ms;
/// a 300 ms batch is three blocks of flow netted before anything hits the AMM.
///
/// ## The model (CoW-style, one solver)
///
/// Users sign an `Order`: sell exactly `sellAmount` of `sellToken` for at least
/// `minBuyAmount` of `buyToken`, valid until `validTo`. No transaction, no gas.
/// The solver collects orders, picks a *clearing price per token*, and calls
/// `settle`. Each order executes at
///
///     buyAmount = sellAmount * price[sellToken] / price[buyToken]
///
/// so every order on a pair sees the same rate — there is no way to favour one
/// order over another. The contract pulls every sell, runs the solver's AMM
/// `interactions` on the residual, pays every buy, and then checks, per token,
/// that it neither lost money nor kept more than `maxFeeBps` of the volume that
/// passed through. Whatever is inside that cap is the protocol's fee and goes to
/// the treasury in the same transaction. A user is protected by their limit;
/// the protocol is protected by the balance check; the solver can be wrong
/// about prices only in ways that make the settlement revert.
///
/// ## Ether
///
/// Intents need a `transferFrom`, and ether has none. A user paying in ETH
/// sends `depositOrder{value}` with an order whose `sellToken` is WETH; the
/// contract wraps and escrows it and the order needs no signature. If it is not
/// filled by `validTo`, `refund` returns the ether. Output in ETH is
/// `buyToken == address(0)`: WETH unwrapped on the way out.
///
/// ## Not in v1
///
/// Partial fills, ring trades across three tokens, more than one solver.
contract OrdoBatch is V4Swap {
    // ------------------------------------------------------------------ types

    struct Order {
        address owner;
        /// Receives `buyToken`. Zero means `owner`.
        address receiver;
        address sellToken;
        /// ERC-20, or address(0) for native ether out.
        address buyToken;
        uint256 sellAmount;
        uint256 minBuyAmount;
        uint32 validTo;
        /// Any value the owner has not used before; consumed on fill or cancel.
        uint256 nonce;
        /// Free for the integrator: an app id, a referral, a hash of anything.
        bytes32 appData;
    }

    /// @notice A hop on one venue, as in OrdoSwapV2.
    struct Leg {
        uint8 venue; // 0 = Uniswap V3 (`path`), 1 = Uniswap V4 (`key`, `zeroForOne`)
        bytes path;
        PoolKey key;
        bool zeroForOne;
    }

    /// @notice One AMM route the solver runs on the residual, funded from the
    ///         contract's balance after all sells were pulled.
    struct Interaction {
        Leg[] legs;
        uint256 amountIn;
    }

    /// @notice `price[i]` is the clearing price of `token[i]`, in any common unit.
    struct Price {
        address token;
        uint256 price;
    }

    // ---------------------------------------------------------------- storage

    IWETH9 public immutable WETH;
    ISwapRouter02 public immutable ROUTER;
    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address owner,address receiver,address sellToken,address buyToken,uint256 sellAmount,uint256 minBuyAmount,uint32 validTo,uint256 nonce,bytes32 appData)"
    );

    address public owner;
    address public solver;
    address public treasury;
    /// @notice Most the contract may keep of the volume in any token, per settlement.
    uint16 public maxFeeBps;
    uint16 public constant MAX_FEE_BPS_CEILING = 100; // 1%

    mapping(address => mapping(uint256 => bool)) public nonceUsed;
    /// @notice Ether-funded orders waiting to be settled: order hash => escrowed WETH.
    mapping(bytes32 => uint256) public escrowed;
    uint256 public escrowTotal;

    uint256 private _locked = 1;

    // ----------------------------------------------------------------- events

    event Trade(
        bytes32 indexed orderHash,
        address indexed owner,
        address sellToken,
        address buyToken,
        uint256 sellAmount,
        uint256 buyAmount,
        bytes32 appData
    );
    event Settled(address indexed solver, uint256 orders, uint256 interactions);
    event Fee(address indexed token, uint256 amount);
    event Deposited(bytes32 indexed orderHash, address indexed owner, uint256 amount);
    event Refunded(bytes32 indexed orderHash, address indexed owner, uint256 amount);
    event Cancelled(address indexed owner, uint256 nonce);
    event SolverSet(address indexed solver);
    event TreasurySet(address indexed treasury);
    event MaxFeeBpsSet(uint16 bps);
    event OwnershipTransferred(address indexed from, address indexed to);

    // ----------------------------------------------------------------- errors

    error NotOwner();
    error NotSolver();
    error Reentrancy();
    error ZeroAddress();
    error BpsTooHigh(uint16 bps);
    error Expired(bytes32 orderHash);
    error NonceUsed(address owner, uint256 nonce);
    error BadSignature(bytes32 orderHash);
    error SameToken();
    error ZeroAmount();
    error NoPrice(address token);
    error LimitNotMet(bytes32 orderHash, uint256 buyAmount, uint256 minBuyAmount);
    error ContractLostFunds(address token, uint256 before, uint256 after_);
    error FeeAboveCap(address token, uint256 fee, uint256 cap);
    error BadLegs();
    error BadPath();
    error NotEscrowed(bytes32 orderHash);
    error NotYetExpired(bytes32 orderHash);
    error DepositMismatch();
    error TransferFailed();
    /// @notice The answer `simulate` reverts with: per token, how the contract's
    ///         balance moved after pulling every sell and running the
    ///         interactions, and how much it would owe the buyers at the
    ///         given prices. Positive `delta` minus `owed` is what the
    ///         solver has to give back through better prices.
    error SimResult(address[] tokens, int256[] delta, uint256[] owed, uint256[] buyAmounts);

    // ------------------------------------------------------------ constructor

    constructor(address weth, address router, address poolManager, address owner_, address solver_, address treasury_, uint16 maxFeeBps_)
        V4Swap(poolManager)
    {
        if (weth == address(0) || router == address(0) || poolManager == address(0) || owner_ == address(0) || solver_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        if (maxFeeBps_ > MAX_FEE_BPS_CEILING) revert BpsTooHigh(maxFeeBps_);
        WETH = IWETH9(weth);
        ROUTER = ISwapRouter02(router);
        owner = owner_;
        solver = solver_;
        treasury = treasury_;
        maxFeeBps = maxFeeBps_;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("OrdoBatch")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
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

    // ----------------------------------------------------------------- orders

    /// @notice EIP-712 hash of an order; what the owner signs.
    function orderHash(Order calldata o) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(ORDER_TYPEHASH, o.owner, o.receiver, o.sellToken, o.buyToken, o.sellAmount, o.minBuyAmount, o.validTo, o.nonce, o.appData)
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    /// @notice Fund an order with ether. `sellToken` must be WETH and
    ///         `sellAmount` must equal the value sent; the ether is wrapped and
    ///         held for the solver. No signature is needed for a deposited
    ///         order: sending the ether is the authorisation.
    function depositOrder(Order calldata o) external payable nonReentrant {
        if (o.owner != msg.sender || o.sellToken != address(WETH) || o.sellAmount != msg.value || msg.value == 0) revert DepositMismatch();
        if (o.validTo < block.timestamp) revert Expired(orderHash(o));
        if (nonceUsed[o.owner][o.nonce]) revert NonceUsed(o.owner, o.nonce);
        bytes32 h = orderHash(o);
        if (escrowed[h] != 0) revert DepositMismatch();
        WETH.deposit{value: msg.value}();
        escrowed[h] = msg.value;
        escrowTotal += msg.value;
        emit Deposited(h, msg.sender, msg.value);
    }

    /// @notice Take back the ether of a deposited order that was never filled.
    function refund(Order calldata o) external nonReentrant {
        bytes32 h = orderHash(o);
        uint256 amount = escrowed[h];
        if (amount == 0) revert NotEscrowed(h);
        if (o.validTo >= block.timestamp) revert NotYetExpired(h);
        escrowed[h] = 0;
        escrowTotal -= amount;
        WETH.withdraw(amount);
        _send(o.owner, amount);
        emit Refunded(h, o.owner, amount);
    }

    /// @notice Burn a nonce so an order signed with it can never fill.
    function cancel(uint256 nonce) external {
        nonceUsed[msg.sender][nonce] = true;
        emit Cancelled(msg.sender, nonce);
    }

    // ------------------------------------------------------------- settlement

    /// @dev What a settlement works with, shared by `settle` and `simulate`.
    struct Batch {
        address[] tokens;
        uint256[] px;
        uint256[] before;
        uint256[] volume;
        uint256[] buyAmounts;
        uint256 escrowConsumed;
    }

    /// @notice Settle a batch. Solver only.
    /// @param orders       The orders, each fully filled or the call reverts.
    /// @param signatures   One per order; empty for a deposited order.
    /// @param prices       Clearing price per token that appears in `orders`.
    /// @param interactions AMM routes run on the residual, in order.
    function settle(Order[] calldata orders, bytes[] calldata signatures, Price[] calldata prices, Interaction[] calldata interactions)
        external
        nonReentrant
    {
        if (msg.sender != solver) revert NotSolver();
        if (orders.length != signatures.length) revert BadSignature(bytes32(0));

        // 1. Pull every sell and work out every buy at the clearing prices.
        Batch memory b = _prepare(orders, signatures, prices, true);
        escrowTotal -= b.escrowConsumed;

        // 2. The residual meets the AMM.
        _interact(interactions);

        // 3. Pay every buy.
        _pay(orders, b);
        _checkAndTakeFee(b);
        emit Settled(msg.sender, orders.length, interactions.length);
    }

    /// @notice What `settle` would do with these prices and interactions, as a
    ///         revert. Signatures, nonces, expiry and limits are not checked —
    ///         this answers "what does the AMM give and what would we owe", so
    ///         the solver can set prices that are exact rather than guessed.
    ///         Call with `eth_call`; it always reverts, so it can never move
    ///         funds even if someone sends it as a transaction.
    function simulate(Order[] calldata orders, Price[] calldata prices, Interaction[] calldata interactions) external {
        bytes[] memory none = new bytes[](orders.length);
        Batch memory b = _prepareMem(orders, none, prices);
        _interact(interactions);
        int256[] memory delta = new int256[](b.tokens.length);
        uint256[] memory owed = new uint256[](b.tokens.length);
        for (uint256 i = 0; i < b.tokens.length; i++) {
            uint256 expected = b.before[i];
            if (b.tokens[i] == address(WETH)) expected -= b.escrowConsumed;
            delta[i] = int256(IERC20(b.tokens[i]).balanceOf(address(this))) - int256(expected);
        }
        for (uint256 i = 0; i < orders.length; i++) {
            address buyTok = orders[i].buyToken == address(0) ? address(WETH) : orders[i].buyToken;
            for (uint256 j = 0; j < b.tokens.length; j++) {
                if (b.tokens[j] == buyTok) {
                    owed[j] += b.buyAmounts[i];
                    break;
                }
            }
        }
        revert SimResult(b.tokens, delta, owed, b.buyAmounts);
    }

    function _prepare(Order[] calldata orders, bytes[] calldata signatures, Price[] calldata prices, bool strict) private returns (Batch memory b) {
        bytes[] memory sigs = new bytes[](signatures.length);
        for (uint256 i = 0; i < signatures.length; i++) sigs[i] = signatures[i];
        return _prepareInner(orders, sigs, prices, strict);
    }

    function _prepareMem(Order[] calldata orders, bytes[] memory signatures, Price[] calldata prices) private returns (Batch memory) {
        return _prepareInner(orders, signatures, prices, false);
    }

    function _prepareInner(Order[] calldata orders, bytes[] memory signatures, Price[] calldata prices, bool strict) private returns (Batch memory b) {
        b.tokens = new address[](prices.length);
        b.px = new uint256[](prices.length);
        b.before = new uint256[](prices.length);
        b.volume = new uint256[](prices.length);
        for (uint256 i = 0; i < prices.length; i++) {
            if (prices[i].price == 0) revert NoPrice(prices[i].token);
            b.tokens[i] = prices[i].token == address(0) ? address(WETH) : prices[i].token;
            b.px[i] = prices[i].price;
            b.before[i] = IERC20(b.tokens[i]).balanceOf(address(this));
        }

        b.buyAmounts = new uint256[](orders.length);
        for (uint256 i = 0; i < orders.length; i++) {
            Order calldata o = orders[i];
            bytes32 h = orderHash(o);
            if (o.sellAmount == 0) revert ZeroAmount();
            address buyTok = o.buyToken == address(0) ? address(WETH) : o.buyToken;
            if (o.sellToken == buyTok) revert SameToken();
            if (strict) {
                if (o.validTo < block.timestamp) revert Expired(h);
                if (nonceUsed[o.owner][o.nonce]) revert NonceUsed(o.owner, o.nonce);
                nonceUsed[o.owner][o.nonce] = true;
            }

            uint256 esc = escrowed[h];
            if (esc != 0) {
                // Funded by deposit; the ether is already here as WETH.
                escrowed[h] = 0;
                b.escrowConsumed += esc;
            } else {
                if (strict && !_validSignature(o.owner, h, signatures[i])) revert BadSignature(h);
                _pull(o.sellToken, o.owner, o.sellAmount);
            }

            uint256 buyAmount = (o.sellAmount * _priceOf(b.tokens, b.px, o.sellToken)) / _priceOf(b.tokens, b.px, buyTok);
            if (strict && buyAmount < o.minBuyAmount) revert LimitNotMet(h, buyAmount, o.minBuyAmount);
            b.buyAmounts[i] = buyAmount;

            _addVolume(b.tokens, b.volume, o.sellToken, o.sellAmount);
            _addVolume(b.tokens, b.volume, buyTok, buyAmount);
        }
    }

    function _interact(Interaction[] calldata interactions) private {
        for (uint256 i = 0; i < interactions.length; i++) {
            Interaction calldata x = interactions[i];
            if (x.legs.length == 0) revert BadLegs();
            (uint256 out, bool haveNative) = _run(x.legs, x.amountIn, false);
            if (haveNative) WETH.deposit{value: out}();
        }
    }

    function _pay(Order[] calldata orders, Batch memory b) private {
        uint256[] memory buyAmounts = b.buyAmounts;
        for (uint256 i = 0; i < orders.length; i++) {
            Order calldata o = orders[i];
            address to = o.receiver == address(0) ? o.owner : o.receiver;
            if (o.buyToken == address(0)) {
                WETH.withdraw(buyAmounts[i]);
                _send(to, buyAmounts[i]);
            } else if (!IERC20(o.buyToken).transfer(to, buyAmounts[i])) {
                revert TransferFailed();
            }
            emit Trade(orderHash(o), o.owner, o.sellToken, o.buyToken, o.sellAmount, buyAmounts[i], o.appData);
        }
    }

    /// @dev Per token: nothing lost, and no more kept than the cap. What is
    ///      kept is the fee and leaves now, so the contract only ever holds
    ///      escrowed ether between settlements.
    function _checkAndTakeFee(Batch memory b) private {
        for (uint256 i = 0; i < b.tokens.length; i++) {
            uint256 expected = b.before[i];
            if (b.tokens[i] == address(WETH)) expected -= b.escrowConsumed;
            uint256 after_ = IERC20(b.tokens[i]).balanceOf(address(this));
            if (after_ < expected) revert ContractLostFunds(b.tokens[i], expected, after_);
            uint256 fee = after_ - expected;
            uint256 cap = (b.volume[i] * maxFeeBps) / 10_000;
            if (fee > cap) revert FeeAboveCap(b.tokens[i], fee, cap);
            if (fee != 0) {
                if (!IERC20(b.tokens[i]).transfer(treasury, fee)) revert TransferFailed();
                emit Fee(b.tokens[i], fee);
            }
        }
        if (address(this).balance != 0) revert BadLegs();
    }

    // ------------------------------------------------------------------ legs

    /// @dev Run legs in order, funded from this contract's balance. Same
    ///      semantics as OrdoSwapV2: `haveNative` says whether the running
    ///      amount is native ether.
    function _run(Leg[] calldata legs, uint256 amount, bool haveNative) private returns (uint256, bool) {
        for (uint256 i = 0; i < legs.length; i++) {
            Leg calldata l = legs[i];
            if (l.venue == 0) {
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
            } else if (l.venue == 1) {
                address cIn = l.zeroForOne ? l.key.currency0 : l.key.currency1;
                address cOut = l.zeroForOne ? l.key.currency1 : l.key.currency0;
                if (cIn == V4Actions.NATIVE) {
                    if (!haveNative) WETH.withdraw(amount);
                } else if (haveNative) {
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

    // ----------------------------------------------------------------- admin

    function setSolver(address s) external onlyOwner {
        if (s == address(0)) revert ZeroAddress();
        solver = s;
        emit SolverSet(s);
    }

    function setTreasury(address t) external onlyOwner {
        if (t == address(0)) revert ZeroAddress();
        treasury = t;
        emit TreasurySet(t);
    }

    function setMaxFeeBps(uint16 bps) external onlyOwner {
        if (bps > MAX_FEE_BPS_CEILING) revert BpsTooHigh(bps);
        maxFeeBps = bps;
        emit MaxFeeBpsSet(bps);
    }

    function transferOwnership(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, to);
        owner = to;
    }

    /// @notice Anything that is not escrowed ether does not belong here.
    function sweep(address token, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (token == address(WETH)) bal -= escrowTotal;
        if (bal != 0 && !IERC20(token).transfer(to, bal)) revert TransferFailed();
    }

    // -------------------------------------------------------------- internal

    function _priceOf(address[] memory tokens, uint256[] memory px, address token) private pure returns (uint256) {
        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i] == token) return px[i];
        }
        revert NoPrice(token);
    }

    function _addVolume(address[] memory tokens, uint256[] memory volume, address token, uint256 amount) private pure {
        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i] == token) {
                volume[i] += amount;
                return;
            }
        }
        revert NoPrice(token);
    }

    /// @dev A plain ECDSA signature is accepted from any account, code or not:
    ///      an EIP-7702 delegated wallet still holds its key, and on this chain
    ///      many do. Only when ECDSA does not match is the account asked
    ///      through ERC-1271, which is what a smart wallet answers.
    function _validSignature(address signer, bytes32 digest, bytes memory sig) private view returns (bool) {
        if (sig.length == 65) {
            bytes32 r;
            bytes32 s;
            uint8 v;
            assembly {
                r := mload(add(sig, 32))
                s := mload(add(sig, 64))
                v := byte(0, mload(add(sig, 96)))
            }
            if (uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0 && (v == 27 || v == 28)) {
                address rec = ecrecover(digest, v, r, s);
                if (rec != address(0) && rec == signer) return true;
            }
        }
        if (signer.code.length == 0) return false;
        (bool ok, bytes memory ret) = signer.staticcall(abi.encodeWithSelector(IERC1271.isValidSignature.selector, digest, sig));
        return ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == IERC1271.isValidSignature.selector;
    }

    function _first(bytes calldata path) private pure returns (address) {
        if (path.length < 43) revert BadPath();
        return address(bytes20(path[0:20]));
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

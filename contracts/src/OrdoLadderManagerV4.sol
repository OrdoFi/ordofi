// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TickMath} from "./vendor/v4/TickMath.sol";
import {PoolKey, IPositionManagerV4, IStateView, IPermit2, V4Actions, V4Pool, V4Liquidity} from "./V4Common.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

/// EIP-2612: an allowance granted by signature, consumed inside the same call.
interface IERC20Permit {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
}

/// @title OrdoLadderManagerV4
/// @notice Shaped concentrated liquidity on Uniswap V4: a price range cut into
/// bins, every bin an ordinary V4 position, all of them minted, topped up,
/// partially withdrawn or closed in single transactions. The V4 counterpart of
/// OrdoLadderManager, with the same ladder model, the same custody, the same
/// 1% of collected fees and nothing else.
///
/// Custody model: the position NFTs sit in this contract, mapped to the ladder
/// owner. Only the owner can touch a ladder. There is no admin, no pause, no
/// upgrade, no key that can reach a position. The fee is a constant 1% of
/// *fees collected*, never of principal, and goes to an immutable treasury.
///
/// V4 specifics: pools are PoolKeys, not addresses; native ETH is a currency
/// in its own right (address zero, always currency0), paid in as msg.value
/// and paid out as ETH; the token side is pulled from the depositor by
/// allowance or EIP-2612 permit, then handed to the PositionManager through
/// Permit2 for exactly the amount the mint needs. Liquidity for every rung is
/// computed here from the pool's live price with the PoolManager's own
/// arithmetic, so the PositionManager's maximum-amount checks are exact and
/// nothing is ever pulled that is not placed.
contract OrdoLadderManagerV4 {
    uint256 private _locked = 1;

    error Reentrancy();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    IPositionManagerV4 public immutable positionManager;
    IStateView public immutable stateView;
    IPermit2 public immutable permit2;
    address public immutable poolManager;
    address public immutable treasury;

    /// @notice Protocol fee on collected swap fees, in basis points.
    uint256 public constant FEE_BPS = 100;
    uint256 public constant MAX_RUNGS = 40;
    /// @notice Second generation: adds `compound` and `collectMany`. Ladders in
    ///         the first manager stay there; the UI reads both.
    uint8 public constant GENERATION = 2;

    address private constant NATIVE = V4Actions.NATIVE;
    uint8 private constant INCREASE_LIQUIDITY = V4Actions.INCREASE_LIQUIDITY;
    uint8 private constant DECREASE_LIQUIDITY = V4Actions.DECREASE_LIQUIDITY;
    uint8 private constant MINT_POSITION = V4Actions.MINT_POSITION;
    uint8 private constant BURN_POSITION = V4Actions.BURN_POSITION;
    uint8 private constant SETTLE_PAIR = V4Actions.SETTLE_PAIR;
    uint8 private constant TAKE_PAIR = V4Actions.TAKE_PAIR;
    uint8 private constant SWEEP = V4Actions.SWEEP;

    /// A rung is a bin's budget: what the depositor is willing to put into
    /// [tickLower, tickUpper). Liquidity is derived from the budget at the
    /// live price; `amount0Min`/`amount1Min` guard against the price having
    /// moved so far that the bin would take much less than planned.
    struct Rung {
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0;
        uint256 amount1;
        uint256 amount0Min;
        uint256 amount1Min;
    }

    /// An EIP-2612 signature over the token side of a deposit, so no separate
    /// approve transaction is needed. `token` zero means none was provided.
    struct Permit {
        address token;
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// One bin of a ladder. `open` flips off when its liquidity is withdrawn.
    struct Bin {
        uint256 tokenId;
        int24 tickLower;
        int24 tickUpper;
        bool open;
    }

    struct Ladder {
        address owner;
        bytes32 poolId;
        PoolKey key;
        uint8 shape; // 0 spot, 1 curve, 2 bid-ask — informational, chosen off-chain
        uint64 openedAt;
        uint64 closedAt; // 0 while any bin is open
        uint32 openBins;
        uint256 deposited0; // principal put in, over the ladder's life
        uint256 deposited1;
        uint256 withdrawn0; // principal taken out
        uint256 withdrawn1;
        uint256 collected0; // fees paid to the owner, net of the 1%
        uint256 collected1;
        Bin[] bins;
    }

    Ladder[] private _ladders;
    mapping(address => uint256[]) private _byOwner;

    event LadderOpened(uint256 indexed ladderId, address indexed owner, bytes32 indexed poolId, uint8 shape, uint256 bins, uint256 deposited0, uint256 deposited1);
    event LiquidityAdded(uint256 indexed ladderId, address indexed owner, uint256 added0, uint256 added1, uint256 newBins);
    event FeesCollected(uint256 indexed ladderId, address indexed owner, uint256 toOwner0, uint256 toOwner1, uint256 toTreasury0, uint256 toTreasury1);
    event BinsClosed(uint256 indexed ladderId, address indexed owner, uint256 count, uint256 principal0, uint256 principal1, uint256 remaining);
    event LadderClosed(uint256 indexed ladderId, address indexed owner);

    error ZeroAddress();
    error Expired();
    error NoRungs();
    error TooManyRungs();
    error NotAPool(bytes32 poolId);
    error PriceOutOfBounds(int24 tick, int24 minTick, int24 maxTick);
    error BadRange(int24 tickLower, int24 tickUpper);
    error RangeNotAligned(int24 tick, int24 spacing);
    error RungsOutOfOrder(uint256 index);
    error EmptyRung(uint256 index);
    error NothingMinted(uint256 index);
    error TokenIdMismatch();
    error Slippage(uint256 index, uint256 amount0, uint256 amount1);
    error ETHNotAccepted();
    error InsufficientETH(uint256 sent, uint256 needed);
    error NotOwner();
    error AlreadyClosed();
    error BinNotOpen(uint256 index);
    error DuplicateBin(uint256 index);
    error NoBins();
    error TransferFailed();
    error PermitFailed(address token);

    constructor(address positionManager_, address stateView_, address treasury_) {
        if (positionManager_ == address(0) || stateView_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        positionManager = IPositionManagerV4(positionManager_);
        stateView = IStateView(stateView_);
        poolManager = positionManager.poolManager();
        permit2 = IPermit2(positionManager.permit2());
        treasury = treasury_;
    }

    receive() external payable {
        // Only the pool paying out (take) and the PositionManager returning
        // what a mint did not use (sweep) may push ETH here.
        if (msg.sender != poolManager && msg.sender != address(positionManager)) revert ETHNotAccepted();
    }

    /// The PositionManager mints with a plain _mint today; should it ever
    /// switch to safeMint, positions must still land here.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    // ---------------------------------------------------------------- open

    /// @notice Mint every bin of a new ladder in one call.
    /// @dev For an ETH pool, send the ETH side as msg.value; the other token
    ///      is pulled by allowance. Whatever the pool does not take is refunded
    ///      in the same transaction. Reverts if the pool's current tick has left
    ///      [minTick, maxTick] — the shape was computed for a price, and a
    ///      moved price would mint something the user did not ask for.
    function openLadder(PoolKey calldata key, Rung[] calldata rungs, uint8 shape, int24 minTick, int24 maxTick, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 ladderId)
    {
        return _openLadder(key, rungs, shape, minTick, maxTick, deadline);
    }

    /// @notice `openLadder` with the token side allowed by an EIP-2612 signature
    ///         instead of a prior approve transaction.
    function openLadderWithPermit(PoolKey calldata key, Rung[] calldata rungs, uint8 shape, int24 minTick, int24 maxTick, uint256 deadline, Permit calldata permit)
        external
        payable
        nonReentrant
        returns (uint256 ladderId)
    {
        _permit(permit);
        return _openLadder(key, rungs, shape, minTick, maxTick, deadline);
    }

    function _openLadder(PoolKey calldata key, Rung[] calldata rungs, uint8 shape, int24 minTick, int24 maxTick, uint256 deadline)
        private
        returns (uint256 ladderId)
    {
        if (block.timestamp > deadline) revert Expired();
        if (rungs.length == 0) revert NoRungs();
        if (rungs.length > MAX_RUNGS) revert TooManyRungs();

        bytes32 poolId = toId(key);
        (uint160 sqrtP, int24 tick,,) = stateView.getSlot0(poolId);
        if (sqrtP == 0) revert NotAPool(poolId);
        if (tick < minTick || tick > maxTick) revert PriceOutOfBounds(tick, minTick, maxTick);

        (uint256 total0, uint256 total1) = _validate(rungs, key.tickSpacing);
        _fund(key, total0, total1);

        ladderId = _ladders.length;
        _ladders.push();
        Ladder storage l = _ladders[ladderId];
        l.owner = msg.sender;
        l.poolId = poolId;
        l.key = key;
        l.shape = shape;
        l.openedAt = uint64(block.timestamp);
        _byOwner[msg.sender].push(ladderId);

        (uint256 used0, uint256 used1) = _place(l, rungs, sqrtP, tick, deadline);
        l.deposited0 = used0;
        l.deposited1 = used1;

        _refund(key);
        emit LadderOpened(ladderId, msg.sender, poolId, shape, rungs.length, used0, used1);
    }

    /// @notice Put more into an open ladder. A rung whose ticks match an open
    ///         bin tops that bin up; any other rung becomes a new bin.
    function addLiquidity(uint256 ladderId, Rung[] calldata rungs, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 added0, uint256 added1)
    {
        return _addLiquidity(ladderId, rungs, deadline);
    }

    /// @notice `addLiquidity` with the token side allowed by an EIP-2612 signature.
    function addLiquidityWithPermit(uint256 ladderId, Rung[] calldata rungs, uint256 deadline, Permit calldata permit)
        external
        payable
        nonReentrant
        returns (uint256 added0, uint256 added1)
    {
        _permit(permit);
        return _addLiquidity(ladderId, rungs, deadline);
    }

    /// Consume a permit for msg.sender. A permit that was already used — by a
    /// front-runner replaying the public signature, or by a wallet that sent an
    /// approve as well — is not a failure: only the resulting allowance matters.
    function _permit(Permit calldata pm) private {
        if (pm.token == address(0)) return;
        try IERC20Permit(pm.token).permit(msg.sender, address(this), pm.value, pm.deadline, pm.v, pm.r, pm.s) {} catch {}
        if (IERC20(pm.token).allowance(msg.sender, address(this)) < pm.value) revert PermitFailed(pm.token);
    }

    function _addLiquidity(uint256 ladderId, Rung[] calldata rungs, uint256 deadline)
        private
        returns (uint256 added0, uint256 added1)
    {
        if (block.timestamp > deadline) revert Expired();
        if (rungs.length == 0) revert NoRungs();
        Ladder storage l = _ladder(ladderId);
        if (l.closedAt != 0) revert AlreadyClosed();

        PoolKey memory key = l.key;
        (uint160 sqrtP, int24 tick,,) = stateView.getSlot0(l.poolId);
        (uint256 total0, uint256 total1) = _validate(rungs, key.tickSpacing);
        uint256 newBins = _countNew(l, rungs);
        if (l.openBins + newBins > MAX_RUNGS) revert TooManyRungs();
        _fund(key, total0, total1);

        (added0, added1) = _place(l, rungs, sqrtP, tick, deadline);
        l.deposited0 += added0;
        l.deposited1 += added1;

        _refund(key);
        emit LiquidityAdded(ladderId, msg.sender, added0, added1, newBins);
    }

    // ------------------------------------------------------------- collect

    /// @notice Collect accrued swap fees across every open bin. 1% to treasury, rest to owner.
    function collect(uint256 ladderId) external nonReentrant returns (uint256 owner0, uint256 owner1) {
        Ladder storage l = _ladder(ladderId);
        if (l.closedAt != 0) revert AlreadyClosed();
        (uint256 fees0, uint256 fees1) = _collectFees(l, _openIndices(l));
        (owner0, owner1) = _splitFees(l, ladderId, fees0, fees1);
    }

    /// @notice Collect the fees of several ladders in one transaction. Every one
    ///         must be the caller's and open. Returns the totals paid to the owner,
    ///         summed across pools — informational, as each ladder pays in its own coins.
    function collectMany(uint256[] calldata ladderIds) external nonReentrant returns (uint256 owner0, uint256 owner1) {
        for (uint256 i = 0; i < ladderIds.length; i++) {
            Ladder storage l = _ladder(ladderIds[i]);
            if (l.closedAt != 0) revert AlreadyClosed();
            (uint256 f0, uint256 f1) = _collectFees(l, _openIndices(l));
            (uint256 o0, uint256 o1) = _splitFees(l, ladderIds[i], f0, f1);
            owner0 += o0;
            owner1 += o1;
        }
    }

    // ------------------------------------------------------------ compound

    /// @notice Collect this ladder's fees and put them straight back in, in one
    ///         transaction, together with whatever else is sent. The 1% applies
    ///         to the fees as on any collect; the owner's share stays here and
    ///         funds the rungs, so only the difference is taken from the caller
    ///         (ETH as value for an ETH pool's currency0, tokens by allowance).
    ///         Rungs are the same as for `addLiquidity`: matching ticks top a bin
    ///         up, others become new bins. Whatever the pool does not take, fees
    ///         included, is refunded.
    function compound(uint256 ladderId, Rung[] calldata rungs, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 added0, uint256 added1)
    {
        return _compound(ladderId, rungs, deadline);
    }

    /// @notice `compound` with the token side allowed by an EIP-2612 signature.
    function compoundWithPermit(uint256 ladderId, Rung[] calldata rungs, uint256 deadline, Permit calldata permit)
        external
        payable
        nonReentrant
        returns (uint256 added0, uint256 added1)
    {
        _permit(permit);
        return _compound(ladderId, rungs, deadline);
    }

    function _compound(uint256 ladderId, Rung[] calldata rungs, uint256 deadline) private returns (uint256 added0, uint256 added1) {
        if (block.timestamp > deadline) revert Expired();
        if (rungs.length == 0) revert NoRungs();
        Ladder storage l = _ladder(ladderId);
        if (l.closedAt != 0) revert AlreadyClosed();

        PoolKey memory key = l.key;
        (uint160 sqrtP, int24 tick,,) = stateView.getSlot0(l.poolId);
        (uint256 total0, uint256 total1) = _validate(rungs, key.tickSpacing);
        uint256 newBins = _countNew(l, rungs);
        if (l.openBins + newBins > MAX_RUNGS) revert TooManyRungs();

        // Fees first: the treasury's cut leaves, the owner's share stays as funding.
        (uint256 fees0, uint256 fees1) = _collectFees(l, _openIndices(l));
        (uint256 have0, uint256 have1) = _keepFees(l, ladderId, fees0, fees1);
        _fund(key, total0 > have0 ? total0 - have0 : 0, total1 > have1 ? total1 - have1 : 0);

        (added0, added1) = _place(l, rungs, sqrtP, tick, deadline);
        l.deposited0 += added0;
        l.deposited1 += added1;

        _refund(key);
        emit LiquidityAdded(ladderId, msg.sender, added0, added1, newBins);
    }

    // --------------------------------------------------------------- close

    /// @notice Withdraw chosen bins: their fees (1% to treasury) and their
    ///         principal (no fee). The bins left behind keep earning.
    function closeBins(uint256 ladderId, uint256[] calldata indices) external nonReentrant returns (uint256 principal0, uint256 principal1) {
        Ladder storage l = _ladder(ladderId);
        if (l.closedAt != 0) revert AlreadyClosed();
        if (indices.length == 0) revert NoBins();
        (principal0, principal1) = _closeBins(l, ladderId, indices);
    }

    /// @notice Withdraw everything that is still open in a ladder.
    function close(uint256 ladderId) external nonReentrant returns (uint256 principal0, uint256 principal1) {
        Ladder storage l = _ladder(ladderId);
        if (l.closedAt != 0) revert AlreadyClosed();
        (principal0, principal1) = _closeBins(l, ladderId, _openIndices(l));
    }

    /// @notice Close several ladders at once. Every one must be the caller's and open.
    function closeMany(uint256[] calldata ladderIds) external nonReentrant {
        for (uint256 i = 0; i < ladderIds.length; i++) {
            Ladder storage l = _ladder(ladderIds[i]);
            if (l.closedAt != 0) revert AlreadyClosed();
            _closeBins(l, ladderIds[i], _openIndices(l));
        }
    }

    // --------------------------------------------------------------- views

    function ladderCount() external view returns (uint256) {
        return _ladders.length;
    }

    function ladder(uint256 ladderId) external view returns (Ladder memory) {
        return _ladders[ladderId];
    }

    function laddersOf(address owner) external view returns (uint256[] memory) {
        return _byOwner[owner];
    }

    /// @notice PoolId of a key, as the PoolManager computes it.
    function toId(PoolKey memory key) public pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }

    /// @notice What a set of rungs would mint right now: liquidity and the
    ///         exact amounts each bin would take at the current price. The
    ///         planner's dry run, so a quote and the transaction agree.
    function preview(PoolKey calldata key, Rung[] calldata rungs)
        external
        view
        returns (int24 tick, uint128[] memory liquidity, uint256[] memory amount0, uint256[] memory amount1)
    {
        uint160 sqrtP;
        (sqrtP, tick,,) = stateView.getSlot0(toId(key));
        liquidity = new uint128[](rungs.length);
        amount0 = new uint256[](rungs.length);
        amount1 = new uint256[](rungs.length);
        for (uint256 i = 0; i < rungs.length; i++) {
            (liquidity[i], amount0[i], amount1[i]) = _size(rungs[i], sqrtP, tick);
        }
    }

    // ------------------------------------------------------------ internal

    function _ladder(uint256 ladderId) private view returns (Ladder storage l) {
        l = _ladders[ladderId];
        if (l.owner != msg.sender) revert NotOwner();
    }

    /// Liquidity for a rung's budget at the live price, and what the pool will
    /// take for it — the PoolManager's own rounding, so the two never disagree.
    function _size(Rung calldata r, uint160 sqrtP, int24 tick) private pure returns (uint128 liq, uint256 need0, uint256 need1) {
        return V4Liquidity.size(r.tickLower, r.tickUpper, r.amount0, r.amount1, sqrtP, tick);
    }

    /// Mint or top up every rung in one PositionManager call. Returns what the pool took.
    function _place(Ladder storage l, Rung[] calldata rungs, uint160 sqrtP, int24 tick, uint256 deadline)
        private
        returns (uint256 used0, uint256 used1)
    {
        PoolKey memory key = l.key;
        bool native = key.currency0 == NATIVE;
        bytes memory actions = new bytes(0);
        bytes[] memory params = new bytes[](rungs.length + (native ? 2 : 1));
        uint256 firstId = positionManager.nextTokenId();
        uint256 minted;
        for (uint256 i = 0; i < rungs.length; i++) {
            Rung calldata r = rungs[i];
            (uint128 liq, uint256 a0, uint256 a1) = _size(r, sqrtP, tick);
            if (liq == 0) revert NothingMinted(i);
            if (a0 < r.amount0Min || a1 < r.amount1Min) revert Slippage(i, a0, a1);
            uint256 at = _findOpen(l, r.tickLower, r.tickUpper);
            if (at != type(uint256).max) {
                actions = bytes.concat(actions, bytes1(INCREASE_LIQUIDITY));
                params[i] = abi.encode(l.bins[at].tokenId, uint256(liq), uint128(a0), uint128(a1), bytes(""));
            } else {
                actions = bytes.concat(actions, bytes1(MINT_POSITION));
                params[i] = abi.encode(key, r.tickLower, r.tickUpper, uint256(liq), uint128(a0), uint128(a1), address(this), bytes(""));
                l.bins.push(Bin({tokenId: firstId + minted, tickLower: r.tickLower, tickUpper: r.tickUpper, open: true}));
                l.openBins += 1;
                minted++;
            }
            used0 += a0;
            used1 += a1;
        }
        actions = bytes.concat(actions, bytes1(SETTLE_PAIR));
        params[rungs.length] = abi.encode(key.currency0, key.currency1);
        if (native) {
            actions = bytes.concat(actions, bytes1(SWEEP));
            params[rungs.length + 1] = abi.encode(NATIVE, address(this));
        }

        // The PositionManager settles the token side from us through Permit2:
        // allow it exactly what the mints need, for this block only.
        if (!native) _allowPermit2(key.currency0, used0);
        _allowPermit2(key.currency1, used1);
        positionManager.modifyLiquidities{value: native ? used0 : 0}(abi.encode(actions, params), deadline);
        if (!native) _allowPermit2(key.currency0, 0);
        _allowPermit2(key.currency1, 0);

        // Token ids are assigned in order from nextTokenId; confirm the assumption
        // rather than trust it — a mismatch means the ladder would point at
        // someone else's positions.
        if (positionManager.nextTokenId() != firstId + minted) revert TokenIdMismatch();
    }

    /// What bounds the PositionManager is the Permit2 allowance: exactly `amount`,
    /// expiring with this block, cleared again afterwards. The ERC-20 allowance to
    /// Permit2 itself is unbounded, as every wallet grants it — Solady tokens even
    /// fix it at infinity and revert on any other figure — and nothing sits in this
    /// contract between transactions for it to reach.
    function _allowPermit2(address token, uint256 amount) private {
        if (token == NATIVE) return;
        if (amount != 0 && IERC20(token).allowance(address(this), address(permit2)) < amount) {
            IERC20(token).approve(address(permit2), type(uint256).max);
        }
        permit2.approve(token, address(positionManager), uint160(amount), uint48(block.timestamp));
    }

    function _findOpen(Ladder storage l, int24 tickLower, int24 tickUpper) private view returns (uint256) {
        for (uint256 i = 0; i < l.bins.length; i++) {
            Bin storage b = l.bins[i];
            if (b.open && b.tickLower == tickLower && b.tickUpper == tickUpper) return i;
        }
        return type(uint256).max;
    }

    function _countNew(Ladder storage l, Rung[] calldata rungs) private view returns (uint256 n) {
        for (uint256 i = 0; i < rungs.length; i++) {
            if (_findOpen(l, rungs[i].tickLower, rungs[i].tickUpper) == type(uint256).max) n++;
        }
    }

    function _openIndices(Ladder storage l) private view returns (uint256[] memory idx) {
        idx = new uint256[](l.openBins);
        uint256 k;
        for (uint256 i = 0; i < l.bins.length; i++) {
            if (l.bins[i].open) idx[k++] = i;
        }
    }

    /// Pull the accrued fees of the given bins into this contract: a zero
    /// liquidity decrease credits each position's fees, one take pays them out.
    function _collectFees(Ladder storage l, uint256[] memory indices) private returns (uint256 fees0, uint256 fees1) {
        if (indices.length == 0) return (0, 0);
        PoolKey memory key = l.key;
        bytes memory actions = new bytes(0);
        bytes[] memory params = new bytes[](indices.length + 1);
        for (uint256 i = 0; i < indices.length; i++) {
            uint256 at = indices[i];
            if (at >= l.bins.length || !l.bins[at].open) revert BinNotOpen(at);
            for (uint256 j = 0; j < i; j++) {
                if (indices[j] == at) revert DuplicateBin(at);
            }
            actions = bytes.concat(actions, bytes1(DECREASE_LIQUIDITY));
            params[i] = abi.encode(l.bins[at].tokenId, uint256(0), uint128(0), uint128(0), bytes(""));
        }
        actions = bytes.concat(actions, bytes1(TAKE_PAIR));
        params[indices.length] = abi.encode(key.currency0, key.currency1, address(this));
        (uint256 b0, uint256 b1) = _balances(key);
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);
        (uint256 c0, uint256 c1) = _balances(key);
        (fees0, fees1) = (c0 - b0, c1 - b1);
    }

    function _closeBins(Ladder storage l, uint256 ladderId, uint256[] memory indices) private returns (uint256 principal0, uint256 principal1) {
        PoolKey memory key = l.key;
        // Fees first, so the fee is only ever charged on fees.
        (uint256 fees0, uint256 fees1) = _collectFees(l, indices);
        _splitFees(l, ladderId, fees0, fees1);

        bytes memory actions = new bytes(0);
        bytes[] memory params = new bytes[](indices.length + 1);
        for (uint256 i = 0; i < indices.length; i++) {
            Bin storage b = l.bins[indices[i]];
            actions = bytes.concat(actions, bytes1(BURN_POSITION));
            params[i] = abi.encode(b.tokenId, uint128(0), uint128(0), bytes(""));
            b.open = false;
        }
        actions = bytes.concat(actions, bytes1(TAKE_PAIR));
        params[indices.length] = abi.encode(key.currency0, key.currency1, address(this));
        (uint256 b0, uint256 b1) = _balances(key);
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);
        (uint256 c0, uint256 c1) = _balances(key);
        (principal0, principal1) = (c0 - b0, c1 - b1);

        l.openBins -= uint32(indices.length);
        l.withdrawn0 += principal0;
        l.withdrawn1 += principal1;
        _pay(l.owner, key.currency0, principal0);
        _pay(l.owner, key.currency1, principal1);
        emit BinsClosed(ladderId, l.owner, indices.length, principal0, principal1, l.openBins);
        if (l.openBins == 0) {
            l.closedAt = uint64(block.timestamp);
            emit LadderClosed(ladderId, l.owner);
        }
    }

    /// `_splitFees` for a compound: same cut, same event, same accounting, but
    /// the owner's share is kept here to fund the rungs instead of being paid out.
    function _keepFees(Ladder storage l, uint256 ladderId, uint256 fees0, uint256 fees1) private returns (uint256 owner0, uint256 owner1) {
        if (fees0 == 0 && fees1 == 0) return (0, 0);
        PoolKey memory key = l.key;
        uint256 cut0 = (fees0 * FEE_BPS) / 10_000;
        uint256 cut1 = (fees1 * FEE_BPS) / 10_000;
        owner0 = fees0 - cut0;
        owner1 = fees1 - cut1;
        l.collected0 += owner0;
        l.collected1 += owner1;
        _pay(treasury, key.currency0, cut0);
        _pay(treasury, key.currency1, cut1);
        emit FeesCollected(ladderId, l.owner, owner0, owner1, cut0, cut1);
    }

    function _splitFees(Ladder storage l, uint256 ladderId, uint256 fees0, uint256 fees1) private returns (uint256 owner0, uint256 owner1) {
        if (fees0 == 0 && fees1 == 0) return (0, 0);
        PoolKey memory key = l.key;
        uint256 cut0 = (fees0 * FEE_BPS) / 10_000;
        uint256 cut1 = (fees1 * FEE_BPS) / 10_000;
        owner0 = fees0 - cut0;
        owner1 = fees1 - cut1;
        l.collected0 += owner0;
        l.collected1 += owner1;
        _pay(treasury, key.currency0, cut0);
        _pay(treasury, key.currency1, cut1);
        _pay(l.owner, key.currency0, owner0);
        _pay(l.owner, key.currency1, owner1);
        emit FeesCollected(ladderId, l.owner, owner0, owner1, cut0, cut1);
    }

    function _validate(Rung[] calldata rungs, int24 spacing) private pure returns (uint256 total0, uint256 total1) {
        int24 previousUpper = type(int24).min;
        for (uint256 i = 0; i < rungs.length; i++) {
            Rung calldata r = rungs[i];
            if (r.tickLower >= r.tickUpper) revert BadRange(r.tickLower, r.tickUpper);
            if (r.tickLower < TickMath.MIN_TICK || r.tickUpper > TickMath.MAX_TICK) revert BadRange(r.tickLower, r.tickUpper);
            if (r.tickLower % spacing != 0) revert RangeNotAligned(r.tickLower, spacing);
            if (r.tickUpper % spacing != 0) revert RangeNotAligned(r.tickUpper, spacing);
            if (r.tickLower < previousUpper) revert RungsOutOfOrder(i);
            if (r.amount0 == 0 && r.amount1 == 0) revert EmptyRung(i);
            previousUpper = r.tickUpper;
            total0 += r.amount0;
            total1 += r.amount1;
        }
    }

    /// Pull the deposit. ETH is a currency here, so it funds currency0 directly
    /// when the pool is an ETH pool; anything else comes by allowance.
    function _fund(PoolKey memory key, uint256 total0, uint256 total1) private {
        if (key.currency0 == NATIVE) {
            if (msg.value < total0) revert InsufficientETH(msg.value, total0);
        } else {
            if (msg.value > 0) revert ETHNotAccepted();
            _pull(key.currency0, total0);
        }
        _pull(key.currency1, total1);
    }

    /// Whatever the pool did not take goes straight back.
    function _refund(PoolKey memory key) private {
        (uint256 b0, uint256 b1) = _balances(key);
        _pay(msg.sender, key.currency0, b0);
        _pay(msg.sender, key.currency1, b1);
    }

    function _balances(PoolKey memory key) private view returns (uint256 b0, uint256 b1) {
        b0 = key.currency0 == NATIVE ? address(this).balance : IERC20(key.currency0).balanceOf(address(this));
        b1 = IERC20(key.currency1).balanceOf(address(this));
    }

    function _pull(address token, uint256 amount) private {
        if (amount == 0) return;
        if (!IERC20(token).transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
    }

    /// Pay out; the native currency goes as ETH.
    function _pay(address to, address currency, uint256 amount) private {
        if (amount == 0) return;
        if (currency == NATIVE) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            if (!IERC20(currency).transfer(to, amount)) revert TransferFailed();
        }
    }
}

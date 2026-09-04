// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

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

interface IWETH is IERC20 {
    function deposit() external payable;
    function withdraw(uint256) external;
}

interface IUniswapV3Factory {
    function getPool(address, address, uint24) external view returns (address);
}

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function tickSpacing() external view returns (int24);
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
}

interface INonfungiblePositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }
    struct IncreaseLiquidityParams {
        uint256 tokenId;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }
    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function factory() external view returns (address);
    function WETH9() external view returns (address);
    function mint(MintParams calldata) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function increaseLiquidity(IncreaseLiquidityParams calldata) external payable returns (uint128 liquidity, uint256 amount0, uint256 amount1);
    function decreaseLiquidity(DecreaseLiquidityParams calldata) external payable returns (uint256 amount0, uint256 amount1);
    function collect(CollectParams calldata) external payable returns (uint256 amount0, uint256 amount1);
    function burn(uint256 tokenId) external payable;
    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );
}

/// @title OrdoLadderManager
/// @notice Shaped concentrated liquidity on Uniswap V3: a price range cut into
/// bins, every bin an ordinary V3 position, all of them minted, topped up,
/// partially withdrawn or closed in single transactions.
///
/// Custody model: the position NFTs sit in this contract, mapped to the ladder
/// owner. Only the owner can touch a ladder. There is no admin, no pause, no
/// upgrade, no key that can reach a position. The fee is a constant 1% of
/// *fees collected*, never of principal, and goes to an immutable treasury.
///
/// Any WETH owed to the owner is unwrapped and paid as native ETH.
contract OrdoLadderManager {
    uint256 private _locked = 1;

    error Reentrancy();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    IUniswapV3Factory public immutable factory;
    INonfungiblePositionManager public immutable positionManager;
    IWETH public immutable weth;
    address public immutable treasury;

    /// @notice Protocol fee on collected swap fees, in basis points.
    uint256 public constant FEE_BPS = 100;
    uint256 public constant MAX_RUNGS = 40;
    /// @notice Second generation: adds `compound` and `collectMany`. Ladders in
    ///         the first manager stay there; the UI reads both.
    uint8 public constant GENERATION = 2;

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
        address pool;
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

    event LadderOpened(uint256 indexed ladderId, address indexed owner, address indexed pool, uint8 shape, uint256 bins, uint256 deposited0, uint256 deposited1);
    event LiquidityAdded(uint256 indexed ladderId, address indexed owner, uint256 added0, uint256 added1, uint256 newBins);
    event FeesCollected(uint256 indexed ladderId, address indexed owner, uint256 toOwner0, uint256 toOwner1, uint256 toTreasury0, uint256 toTreasury1);
    event BinsClosed(uint256 indexed ladderId, address indexed owner, uint256 count, uint256 principal0, uint256 principal1, uint256 remaining);
    event LadderClosed(uint256 indexed ladderId, address indexed owner);

    error ZeroAddress();
    error Expired();
    error NoRungs();
    error TooManyRungs();
    error NotAPool(address pool);
    error PriceOutOfBounds(int24 tick, int24 minTick, int24 maxTick);
    error BadRange(int24 tickLower, int24 tickUpper);
    error RangeNotAligned(int24 tick, int24 spacing);
    error RungsOutOfOrder(uint256 index);
    error EmptyRung(uint256 index);
    error NothingMinted(uint256 index);
    error ETHNotAccepted();
    error InsufficientETH(uint256 sent, uint256 needed);
    error NotOwner();
    error AlreadyClosed();
    error BinNotOpen(uint256 index);
    error DuplicateBin(uint256 index);
    error NoBins();
    error TransferFailed();
    error PermitFailed(address token);

    constructor(address positionManager_, address treasury_) {
        if (positionManager_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        positionManager = INonfungiblePositionManager(positionManager_);
        factory = IUniswapV3Factory(positionManager.factory());
        weth = IWETH(positionManager.WETH9());
        treasury = treasury_;
    }

    receive() external payable {
        // Only WETH unwrapping may push ETH here.
        if (msg.sender != address(weth)) revert ETHNotAccepted();
    }

    // ---------------------------------------------------------------- open

    /// @notice Mint every bin of a new ladder in one call.
    /// @dev Send ETH to fund the WETH side instead of approving WETH; the other
    ///      token is pulled by allowance. Whatever the pool does not take is
    ///      refunded in the same transaction. Reverts if the pool's current tick
    ///      has left [minTick, maxTick] — the shape was computed for a price,
    ///      and a moved price would mint something the user did not ask for.
    function openLadder(address pool, Rung[] calldata rungs, uint8 shape, int24 minTick, int24 maxTick, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 ladderId)
    {
        return _openLadder(pool, rungs, shape, minTick, maxTick, deadline);
    }

    /// @notice `openLadder` with the token side allowed by an EIP-2612 signature
    ///         instead of a prior approve transaction.
    function openLadderWithPermit(address pool, Rung[] calldata rungs, uint8 shape, int24 minTick, int24 maxTick, uint256 deadline, Permit calldata permit)
        external
        payable
        nonReentrant
        returns (uint256 ladderId)
    {
        _permit(permit);
        return _openLadder(pool, rungs, shape, minTick, maxTick, deadline);
    }

    function _openLadder(address pool, Rung[] calldata rungs, uint8 shape, int24 minTick, int24 maxTick, uint256 deadline)
        private
        returns (uint256 ladderId)
    {
        if (block.timestamp > deadline) revert Expired();
        if (rungs.length == 0) revert NoRungs();
        if (rungs.length > MAX_RUNGS) revert TooManyRungs();

        IUniswapV3Pool p = IUniswapV3Pool(pool);
        (address token0, address token1, uint24 fee) = (p.token0(), p.token1(), p.fee());
        if (factory.getPool(token0, token1, fee) != pool) revert NotAPool(pool);
        (, int24 tick,,,,,) = p.slot0();
        if (tick < minTick || tick > maxTick) revert PriceOutOfBounds(tick, minTick, maxTick);

        (uint256 total0, uint256 total1) = _validate(rungs, p.tickSpacing());
        _fund(token0, token1, total0, total1);

        ladderId = _ladders.length;
        _ladders.push();
        Ladder storage l = _ladders[ladderId];
        l.owner = msg.sender;
        l.pool = pool;
        l.shape = shape;
        l.openedAt = uint64(block.timestamp);
        _byOwner[msg.sender].push(ladderId);

        (uint256 used0, uint256 used1) = _place(l, token0, token1, fee, rungs, total0, total1, deadline);
        l.deposited0 = used0;
        l.deposited1 = used1;

        _refund(token0, token1);
        emit LadderOpened(ladderId, msg.sender, pool, shape, rungs.length, used0, used1);
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

        IUniswapV3Pool p = IUniswapV3Pool(l.pool);
        (address token0, address token1, uint24 fee) = (p.token0(), p.token1(), p.fee());
        (uint256 total0, uint256 total1) = _validate(rungs, p.tickSpacing());
        uint256 newBins = _countNew(l, rungs);
        if (l.openBins + newBins > MAX_RUNGS) revert TooManyRungs();
        _fund(token0, token1, total0, total1);

        (added0, added1) = _place(l, token0, token1, fee, rungs, total0, total1, deadline);
        l.deposited0 += added0;
        l.deposited1 += added1;

        _refund(token0, token1);
        emit LiquidityAdded(ladderId, msg.sender, added0, added1, newBins);
    }

    // ------------------------------------------------------------- collect

    /// @notice Collect accrued swap fees across every open bin. 1% to treasury, rest to owner.
    function collect(uint256 ladderId) external nonReentrant returns (uint256 owner0, uint256 owner1) {
        Ladder storage l = _ladder(ladderId);
        if (l.closedAt != 0) revert AlreadyClosed();
        (uint256 fees0, uint256 fees1) = _collectAll(l);
        (owner0, owner1) = _splitFees(l, ladderId, fees0, fees1);
    }

    /// @notice Collect the fees of several ladders in one transaction. Every one
    ///         must be the caller's and open. Returns the totals paid to the owner,
    ///         summed across pools — informational, as each ladder pays in its own coins.
    function collectMany(uint256[] calldata ladderIds) external nonReentrant returns (uint256 owner0, uint256 owner1) {
        for (uint256 i = 0; i < ladderIds.length; i++) {
            Ladder storage l = _ladder(ladderIds[i]);
            if (l.closedAt != 0) revert AlreadyClosed();
            (uint256 f0, uint256 f1) = _collectAll(l);
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
    ///         (ETH as value for the WETH side, the token by allowance). Rungs
    ///         are the same as for `addLiquidity`: matching ticks top a bin up,
    ///         others become new bins. Whatever the pool does not take, fees
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

        IUniswapV3Pool p = IUniswapV3Pool(l.pool);
        (address token0, address token1, uint24 fee) = (p.token0(), p.token1(), p.fee());
        (uint256 total0, uint256 total1) = _validate(rungs, p.tickSpacing());
        uint256 newBins = _countNew(l, rungs);
        if (l.openBins + newBins > MAX_RUNGS) revert TooManyRungs();

        // Fees first: the treasury's cut leaves, the owner's share stays as funding.
        (uint256 fees0, uint256 fees1) = _collectAll(l);
        (uint256 have0, uint256 have1) = _keepFees(l, ladderId, fees0, fees1);
        _fund(token0, token1, total0 > have0 ? total0 - have0 : 0, total1 > have1 ? total1 - have1 : 0);

        (added0, added1) = _place(l, token0, token1, fee, rungs, total0, total1, deadline);
        l.deposited0 += added0;
        l.deposited1 += added1;

        _refund(token0, token1);
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

    // ------------------------------------------------------------ internal

    function _ladder(uint256 ladderId) private view returns (Ladder storage l) {
        l = _ladders[ladderId];
        if (l.owner != msg.sender) revert NotOwner();
    }

    /// Mint or top up every rung. Returns what the pool actually took.
    function _place(Ladder storage l, address token0, address token1, uint24 fee, Rung[] calldata rungs, uint256 total0, uint256 total1, uint256 deadline)
        private
        returns (uint256 used0, uint256 used1)
    {
        IERC20(token0).approve(address(positionManager), total0);
        IERC20(token1).approve(address(positionManager), total1);
        for (uint256 i = 0; i < rungs.length; i++) {
            Rung calldata r = rungs[i];
            uint256 at = _findOpen(l, r.tickLower, r.tickUpper);
            uint256 a0;
            uint256 a1;
            if (at != type(uint256).max) {
                uint128 liq;
                (liq, a0, a1) = positionManager.increaseLiquidity(
                    INonfungiblePositionManager.IncreaseLiquidityParams({
                        tokenId: l.bins[at].tokenId,
                        amount0Desired: r.amount0,
                        amount1Desired: r.amount1,
                        amount0Min: r.amount0Min,
                        amount1Min: r.amount1Min,
                        deadline: deadline
                    })
                );
                if (liq == 0) revert NothingMinted(i);
            } else {
                uint256 id;
                uint128 liq;
                (id, liq, a0, a1) = positionManager.mint(
                    INonfungiblePositionManager.MintParams({
                        token0: token0,
                        token1: token1,
                        fee: fee,
                        tickLower: r.tickLower,
                        tickUpper: r.tickUpper,
                        amount0Desired: r.amount0,
                        amount1Desired: r.amount1,
                        amount0Min: r.amount0Min,
                        amount1Min: r.amount1Min,
                        recipient: address(this),
                        deadline: deadline
                    })
                );
                if (liq == 0) revert NothingMinted(i);
                l.bins.push(Bin({tokenId: id, tickLower: r.tickLower, tickUpper: r.tickUpper, open: true}));
                l.openBins += 1;
            }
            used0 += a0;
            used1 += a1;
        }
        IERC20(token0).approve(address(positionManager), 0);
        IERC20(token1).approve(address(positionManager), 0);
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

    function _closeBins(Ladder storage l, uint256 ladderId, uint256[] memory indices) private returns (uint256 principal0, uint256 principal1) {
        (address token0, address token1) = _tokens(l.pool);
        uint256 fees0;
        uint256 fees1;
        // Fees first, so the fee is only ever charged on fees.
        for (uint256 i = 0; i < indices.length; i++) {
            uint256 at = indices[i];
            if (at >= l.bins.length || !l.bins[at].open) revert BinNotOpen(at);
            for (uint256 j = 0; j < i; j++) {
                if (indices[j] == at) revert DuplicateBin(at);
            }
            (uint256 f0, uint256 f1) = _collectRaw(l.bins[at].tokenId);
            fees0 += f0;
            fees1 += f1;
        }
        _splitFees(l, ladderId, fees0, fees1);

        for (uint256 i = 0; i < indices.length; i++) {
            Bin storage b = l.bins[indices[i]];
            (,,,,,,, uint128 liq,,,,) = positionManager.positions(b.tokenId);
            if (liq > 0) {
                positionManager.decreaseLiquidity(
                    INonfungiblePositionManager.DecreaseLiquidityParams({tokenId: b.tokenId, liquidity: liq, amount0Min: 0, amount1Min: 0, deadline: block.timestamp})
                );
            }
            (uint256 a0, uint256 a1) = _collectRaw(b.tokenId);
            principal0 += a0;
            principal1 += a1;
            positionManager.burn(b.tokenId);
            b.open = false;
        }
        l.openBins -= uint32(indices.length);
        l.withdrawn0 += principal0;
        l.withdrawn1 += principal1;
        _pay(l.owner, token0, principal0);
        _pay(l.owner, token1, principal1);
        emit BinsClosed(ladderId, l.owner, indices.length, principal0, principal1, l.openBins);
        if (l.openBins == 0) {
            l.closedAt = uint64(block.timestamp);
            emit LadderClosed(ladderId, l.owner);
        }
    }

    function _tokens(address pool) private view returns (address, address) {
        return (IUniswapV3Pool(pool).token0(), IUniswapV3Pool(pool).token1());
    }

    function _collectRaw(uint256 tokenId) private returns (uint256, uint256) {
        return positionManager.collect(
            INonfungiblePositionManager.CollectParams({tokenId: tokenId, recipient: address(this), amount0Max: type(uint128).max, amount1Max: type(uint128).max})
        );
    }

    /// Fees of every open bin, into this contract.
    function _collectAll(Ladder storage l) private returns (uint256 fees0, uint256 fees1) {
        for (uint256 i = 0; i < l.bins.length; i++) {
            if (!l.bins[i].open) continue;
            (uint256 a0, uint256 a1) = _collectRaw(l.bins[i].tokenId);
            fees0 += a0;
            fees1 += a1;
        }
    }

    /// `_splitFees` for a compound: same cut, same event, same accounting, but
    /// the owner's share is kept here to fund the rungs instead of being paid out.
    function _keepFees(Ladder storage l, uint256 ladderId, uint256 fees0, uint256 fees1) private returns (uint256 owner0, uint256 owner1) {
        if (fees0 == 0 && fees1 == 0) return (0, 0);
        (address token0, address token1) = _tokens(l.pool);
        uint256 cut0 = (fees0 * FEE_BPS) / 10_000;
        uint256 cut1 = (fees1 * FEE_BPS) / 10_000;
        owner0 = fees0 - cut0;
        owner1 = fees1 - cut1;
        l.collected0 += owner0;
        l.collected1 += owner1;
        _pay(treasury, token0, cut0);
        _pay(treasury, token1, cut1);
        emit FeesCollected(ladderId, l.owner, owner0, owner1, cut0, cut1);
    }

    function _splitFees(Ladder storage l, uint256 ladderId, uint256 fees0, uint256 fees1) private returns (uint256 owner0, uint256 owner1) {
        if (fees0 == 0 && fees1 == 0) return (0, 0);
        (address token0, address token1) = _tokens(l.pool);
        uint256 cut0 = (fees0 * FEE_BPS) / 10_000;
        uint256 cut1 = (fees1 * FEE_BPS) / 10_000;
        owner0 = fees0 - cut0;
        owner1 = fees1 - cut1;
        l.collected0 += owner0;
        l.collected1 += owner1;
        _pay(treasury, token0, cut0);
        _pay(treasury, token1, cut1);
        _pay(l.owner, token0, owner0);
        _pay(l.owner, token1, owner1);
        emit FeesCollected(ladderId, l.owner, owner0, owner1, cut0, cut1);
    }

    function _validate(Rung[] calldata rungs, int24 spacing) private pure returns (uint256 total0, uint256 total1) {
        int24 previousUpper = type(int24).min;
        for (uint256 i = 0; i < rungs.length; i++) {
            Rung calldata r = rungs[i];
            if (r.tickLower >= r.tickUpper) revert BadRange(r.tickLower, r.tickUpper);
            if (r.tickLower % spacing != 0) revert RangeNotAligned(r.tickLower, spacing);
            if (r.tickUpper % spacing != 0) revert RangeNotAligned(r.tickUpper, spacing);
            if (r.tickLower < previousUpper) revert RungsOutOfOrder(i);
            if (r.amount0 == 0 && r.amount1 == 0) revert EmptyRung(i);
            previousUpper = r.tickUpper;
            total0 += r.amount0;
            total1 += r.amount1;
        }
    }

    /// Pull the deposit. ETH funds the WETH side; anything else comes by allowance.
    function _fund(address token0, address token1, uint256 total0, uint256 total1) private {
        if (msg.value > 0) {
            uint256 need;
            address other;
            uint256 otherAmt;
            if (token0 == address(weth)) (need, other, otherAmt) = (total0, token1, total1);
            else if (token1 == address(weth)) (need, other, otherAmt) = (total1, token0, total0);
            else revert ETHNotAccepted();
            if (msg.value < need) revert InsufficientETH(msg.value, need);
            weth.deposit{value: msg.value}();
            _pull(other, otherAmt);
        } else {
            _pull(token0, total0);
            _pull(token1, total1);
        }
    }

    /// Whatever the pool did not take goes straight back.
    function _refund(address token0, address token1) private {
        _pay(msg.sender, token0, IERC20(token0).balanceOf(address(this)));
        _pay(msg.sender, token1, IERC20(token1).balanceOf(address(this)));
    }

    function _pull(address token, uint256 amount) private {
        if (amount == 0) return;
        if (!IERC20(token).transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
    }

    /// Pay out; WETH goes as native ETH.
    function _pay(address to, address token, uint256 amount) private {
        if (amount == 0) return;
        if (token == address(weth)) {
            weth.withdraw(amount);
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            if (!IERC20(token).transfer(to, amount)) revert TransferFailed();
        }
    }
}

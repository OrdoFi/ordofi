// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
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
/// @notice Shaped concentrated liquidity on Uniswap V3, minted in one transaction.
///
/// A "ladder" is a price range cut into bins, each bin an ordinary Uniswap V3
/// position. The shape — how the deposit spreads across the bins — is decided
/// off-chain and arrives here as a list of rungs; this contract's job is to
/// mint them all atomically, hold them for the owner, and pay out.
///
/// Custody model: the position NFTs sit in this contract, mapped to the ladder
/// owner. Only the owner can collect or close. There is no admin, no pause,
/// no upgrade, no key that can touch a position. The fee is a constant 1% of
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

    struct Rung {
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0;
        uint256 amount1;
        uint256 amount0Min;
        uint256 amount1Min;
    }

    struct Ladder {
        address owner;
        address pool;
        uint64 mintedAt;
        uint256 deposited0;
        uint256 deposited1;
        uint256 collected0; // fees paid to owner so far, net
        uint256 collected1;
        uint256[] tokenIds;
        bool closed;
    }

    Ladder[] private _ladders;
    mapping(address => uint256[]) private _byOwner;

    event LadderMinted(uint256 indexed ladderId, address indexed owner, address indexed pool, uint256 rungs, uint256 deposited0, uint256 deposited1);
    event FeesCollected(uint256 indexed ladderId, uint256 toOwner0, uint256 toOwner1, uint256 toTreasury0, uint256 toTreasury1);
    event LadderClosed(uint256 indexed ladderId, uint256 principal0, uint256 principal1);

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
    error TransferFailed();

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

    // ---------------------------------------------------------------- mint

    /// @notice Mint every rung of a ladder in one call.
    /// @dev Send ETH to fund the WETH side instead of approving WETH; the other
    ///      token is pulled by allowance. Whatever the pool does not take is
    ///      refunded in the same transaction. Reverts if the pool's current tick
    ///      has left [minTick, maxTick] — the shape was computed for a price,
    ///      and a moved price would mint something the user did not ask for.
    function mintLadder(address pool, Rung[] calldata rungs, int24 minTick, int24 maxTick, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 ladderId)
    {
        if (block.timestamp > deadline) revert Expired();
        if (rungs.length == 0) revert NoRungs();
        if (rungs.length > 40) revert TooManyRungs();

        IUniswapV3Pool p = IUniswapV3Pool(pool);
        address token0 = p.token0();
        address token1 = p.token1();
        uint24 fee = p.fee();
        if (factory.getPool(token0, token1, fee) != pool) revert NotAPool(pool);
        (, int24 tick,,,,,) = p.slot0();
        if (tick < minTick || tick > maxTick) revert PriceOutOfBounds(tick, minTick, maxTick);

        (uint256 total0, uint256 total1) = _validate(rungs, p.tickSpacing());
        _fund(token0, token1, total0, total1);

        IERC20(token0).approve(address(positionManager), total0);
        IERC20(token1).approve(address(positionManager), total1);

        ladderId = _ladders.length;
        _ladders.push();
        Ladder storage l = _ladders[ladderId];
        l.owner = msg.sender;
        l.pool = pool;
        l.mintedAt = uint64(block.timestamp);

        uint256 used0;
        uint256 used1;
        for (uint256 i = 0; i < rungs.length; i++) {
            Rung calldata r = rungs[i];
            (uint256 id, uint128 liq, uint256 a0, uint256 a1) = positionManager.mint(
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
            l.tokenIds.push(id);
            used0 += a0;
            used1 += a1;
        }
        l.deposited0 = used0;
        l.deposited1 = used1;
        _byOwner[msg.sender].push(ladderId);

        IERC20(token0).approve(address(positionManager), 0);
        IERC20(token1).approve(address(positionManager), 0);

        // Refund whatever the pool did not take.
        _pay(msg.sender, token0, IERC20(token0).balanceOf(address(this)));
        _pay(msg.sender, token1, IERC20(token1).balanceOf(address(this)));

        emit LadderMinted(ladderId, msg.sender, pool, rungs.length, used0, used1);
    }

    // ------------------------------------------------------------- collect

    /// @notice Collect accrued swap fees across every rung. 1% to treasury, rest to owner.
    function collect(uint256 ladderId) external nonReentrant returns (uint256 owner0, uint256 owner1) {
        Ladder storage l = _ladder(ladderId);
        if (l.closed) revert AlreadyClosed();
        (owner0, owner1) = _collectFees(l, ladderId);
    }

    /// @notice Withdraw everything: fees (1% to treasury) and principal (no fee). Burns the positions.
    function close(uint256 ladderId) external nonReentrant returns (uint256 principal0, uint256 principal1) {
        Ladder storage l = _ladder(ladderId);
        if (l.closed) revert AlreadyClosed();
        // Fees first, so the fee is only ever charged on fees.
        _collectFees(l, ladderId);

        (address token0, address token1) = _tokens(l.pool);
        for (uint256 i = 0; i < l.tokenIds.length; i++) {
            uint256 id = l.tokenIds[i];
            (,,,,,,, uint128 liq,,,,) = positionManager.positions(id);
            if (liq > 0) {
                positionManager.decreaseLiquidity(
                    INonfungiblePositionManager.DecreaseLiquidityParams({tokenId: id, liquidity: liq, amount0Min: 0, amount1Min: 0, deadline: block.timestamp})
                );
            }
            (uint256 a0, uint256 a1) = positionManager.collect(
                INonfungiblePositionManager.CollectParams({tokenId: id, recipient: address(this), amount0Max: type(uint128).max, amount1Max: type(uint128).max})
            );
            principal0 += a0;
            principal1 += a1;
            positionManager.burn(id);
        }
        l.closed = true;
        _pay(l.owner, token0, principal0);
        _pay(l.owner, token1, principal1);
        emit LadderClosed(ladderId, principal0, principal1);
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

    function _tokens(address pool) private view returns (address, address) {
        return (IUniswapV3Pool(pool).token0(), IUniswapV3Pool(pool).token1());
    }

    function _collectFees(Ladder storage l, uint256 ladderId) private returns (uint256 owner0, uint256 owner1) {
        (address token0, address token1) = _tokens(l.pool);
        uint256 fees0;
        uint256 fees1;
        for (uint256 i = 0; i < l.tokenIds.length; i++) {
            (uint256 a0, uint256 a1) = positionManager.collect(
                INonfungiblePositionManager.CollectParams({tokenId: l.tokenIds[i], recipient: address(this), amount0Max: type(uint128).max, amount1Max: type(uint128).max})
            );
            fees0 += a0;
            fees1 += a1;
        }
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
        emit FeesCollected(ladderId, owner0, owner1, cut0, cut1);
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

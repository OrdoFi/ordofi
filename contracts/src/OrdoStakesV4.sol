// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20, IWETH, IERC20Permit, IOrdoStakeFarm, Guard, Shares, OrdoStakeFarm} from "./OrdoStakes.sol";
import {PoolKey, IPositionManagerV4, IStateView, IPermit2, V4Actions, V4Pool, V4Liquidity, V4Swap} from "./V4Common.sol";

/// Stakes on Uniswap V4: pooled, always-in-range liquidity for a token's ETH
/// pool, paid in ETH. The V4 counterpart of OrdoStakes with the same model:
///
///   OrdoStakeVaultV4   one full-range V4 position per stake; depositors hold
///                      ERC-20 shares of it. Every deposit or withdrawal first
///                      harvests the pool fees: 1% of the ETH to the treasury,
///                      the rest streamed to the farm as WETH. Token-side fees
///                      are sold for ETH in the same pool against a reference
///                      price at least ten minutes old, so a sandwich around the
///                      sale cannot profit; without a reference yet they wait.
///   OrdoStakeFarm      unchanged from V3: stake shares, earn WETH over 7 days.
///   OrdoStakeZapV4     one coin in (ETH or the token), swapped in the pool,
///                      paired, deposited and staked in a single transaction.
///   OrdoStakeFactoryV4 attaches a vault + farm to any hookless ETH pool, once.
///
/// V4 specifics: ETH is a currency of its own (address zero, always currency0),
/// paid in as msg.value and out as ETH. The position is an ERC-721 held by the
/// vault and touched only through the PositionManager's batched actions; the
/// token side reaches the PositionManager through Permit2 for exactly what the
/// position takes, so deposits never leave anything behind to refund. Unlike
/// V3, nobody else can add liquidity to the vault's position.
///
/// No admin anywhere. The treasury address is fixed at deployment.

interface IOrdoStakeVaultV4 {
    function deposit(uint256 tokenDesired, uint128 ethMin, uint128 tokenMin, address to) external payable returns (uint256 shares, uint256 usedEth, uint256 usedToken);
    function key() external view returns (PoolKey memory);
    function token() external view returns (address);
    function farm() external view returns (address);
}

// =========================================================================== vault

contract OrdoStakeVaultV4 is Shares, Guard, V4Swap {
    IPositionManagerV4 public immutable positionManager;
    IStateView public immutable stateView;
    IPermit2 public immutable permit2;
    IWETH public immutable weth;
    address public immutable treasury;
    address public immutable factory;
    bytes32 public immutable poolId;
    /// currency1 of the pool; currency0 is ETH.
    address public immutable token;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    int24 public immutable tickLower;
    int24 public immutable tickUpper;

    address public farm;
    uint256 public tokenId; // 0 until the first deposit
    uint256 public totalRewards; // WETH streamed to the farm, lifetime
    uint256 public totalTreasury;

    /// The pool's tick as it stood at least TWAP_WINDOW ago, refreshed by
    /// every harvest once that long has passed. V4 pools carry no oracle of
    /// their own; this is the reference the fee sale is bounded against.
    int24 private _refTick;
    uint40 private _refAt;

    uint256 public constant FEE_BPS = 100;
    uint32 public constant TWAP_WINDOW = 600;
    uint256 public constant TWAP_SLIPPAGE_BPS = 300;
    /// @notice Shares locked forever at the first deposit (worth a few cents of
    ///         liquidity), so the supply can never be tiny and never return to
    ///         zero. V4 lets nobody else top up the position, so the inflation
    ///         this guards against in V3 has no vector here; it stays because a
    ///         supply that cannot vanish keeps every later deposit's rounding
    ///         negligible.
    uint256 public constant MIN_SHARES = 1e9;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    event Harvest(uint256 ethFees, uint256 tokenFees, uint256 tokenSwappedToEth, uint256 toTreasury, uint256 toFarm);
    event Deposit(address indexed from, address indexed to, uint256 shares, uint256 amountEth, uint256 amountToken);
    event Withdraw(address indexed owner, address indexed to, uint256 shares, uint256 amountEth, uint256 amountToken);

    error ZeroAddress();
    error FarmSet();
    error NotFactory();
    error ZeroShares();
    error NothingIn();
    error Slippage(uint256 eth, uint256 token_);
    error FirstDepositTooSmall();
    error ETHNotAccepted();
    error TransferFailed();
    error TokenIdMismatch();

    constructor(address posm_, address stateView_, PoolKey memory key_, address treasury_, string memory symbol_)
        V4Swap(IPositionManagerV4(posm_).poolManager())
    {
        positionManager = IPositionManagerV4(posm_);
        stateView = IStateView(stateView_);
        permit2 = IPermit2(positionManager.permit2());
        weth = IWETH(positionManager.WETH9());
        treasury = treasury_;
        factory = msg.sender;
        poolId = V4Pool.id(key_);
        token = key_.currency1;
        fee = key_.fee;
        tickSpacing = key_.tickSpacing;
        tickLower = (-887272 / key_.tickSpacing) * key_.tickSpacing;
        tickUpper = (887272 / key_.tickSpacing) * key_.tickSpacing;
        name = string.concat("Ordo Stake ", symbol_, " V4");
        symbol = string.concat("os", symbol_);
    }

    function setFarm(address farm_) external {
        if (msg.sender != factory) revert NotFactory();
        if (farm != address(0)) revert FarmSet();
        if (farm_ == address(0)) revert ZeroAddress();
        farm = farm_;
    }

    receive() external payable {
        // The pool paying out (take), or the PositionManager returning what a
        // mint did not use (sweep). Nothing else may push ETH in.
        if (msg.sender != address(_poolManager) && msg.sender != address(positionManager)) revert ETHNotAccepted();
    }

    /// @notice The pool this vault provides to.
    function key() public view returns (PoolKey memory) {
        return PoolKey({currency0: V4Actions.NATIVE, currency1: token, fee: fee, tickSpacing: tickSpacing, hooks: address(0)});
    }

    /// @notice Liquidity of the vault's position; shares are minted pro rata to it.
    function liquidity() public view returns (uint128) {
        if (tokenId == 0) return 0;
        return positionManager.getPositionLiquidity(tokenId);
    }

    /// @notice What a deposit of `eth` and `tokenDesired` would place right now.
    function previewDeposit(uint256 eth, uint256 tokenDesired) external view returns (uint128 liq, uint256 usedEth, uint256 usedToken) {
        (uint160 sqrtP, int24 tick,,) = stateView.getSlot0(poolId);
        return V4Liquidity.size(tickLower, tickUpper, eth, tokenDesired, sqrtP, tick);
    }

    /// @notice Add both sides: ETH as msg.value, the token by allowance. The
    ///         position takes as much of both as the price allows; the token is
    ///         pulled for exactly that and the ETH the position did not take is
    ///         refunded. Shares go to `to`.
    function deposit(uint256 tokenDesired, uint128 ethMin, uint128 tokenMin, address to)
        external
        payable
        nonReentrant
        returns (uint256 shares, uint256 usedEth, uint256 usedToken)
    {
        if (to == address(0)) revert ZeroAddress();
        harvest();
        uint128 before = liquidity();
        (uint160 sqrtP, int24 tick,,) = stateView.getSlot0(poolId);
        uint128 liq;
        (liq, usedEth, usedToken) = V4Liquidity.size(tickLower, tickUpper, msg.value, tokenDesired, sqrtP, tick);
        if (liq == 0) revert NothingIn();
        if (usedEth < ethMin || usedToken < tokenMin) revert Slippage(usedEth, usedToken);
        _pull(token, usedToken);

        bytes memory actions = abi.encodePacked(tokenId == 0 ? V4Actions.MINT_POSITION : V4Actions.INCREASE_LIQUIDITY, V4Actions.SETTLE_PAIR, V4Actions.SWEEP);
        bytes[] memory params = new bytes[](3);
        uint256 expectId;
        if (tokenId == 0) {
            expectId = positionManager.nextTokenId();
            params[0] = abi.encode(key(), tickLower, tickUpper, uint256(liq), uint128(usedEth), uint128(usedToken), address(this), bytes(""));
        } else {
            params[0] = abi.encode(tokenId, uint256(liq), uint128(usedEth), uint128(usedToken), bytes(""));
        }
        params[1] = abi.encode(V4Actions.NATIVE, token);
        params[2] = abi.encode(V4Actions.NATIVE, address(this));
        _allowPermit2(usedToken);
        positionManager.modifyLiquidities{value: usedEth}(abi.encode(actions, params), block.timestamp);
        _allowPermit2(0);
        if (tokenId == 0) {
            if (positionManager.nextTokenId() != expectId + 1) revert TokenIdMismatch();
            tokenId = expectId;
        }

        if (totalSupply == 0) {
            // First depositor: shares are liquidity, less a floor minted to a
            // dead address that can never be withdrawn.
            if (liq <= MIN_SHARES) revert FirstDepositTooSmall();
            _mint(DEAD, MIN_SHARES);
            shares = uint256(liq) - MIN_SHARES;
        } else {
            shares = (uint256(liq) * totalSupply) / before;
        }
        if (shares == 0) revert ZeroShares();
        _mint(to, shares);

        // The vault holds no ETH between calls (fees are wrapped the moment they
        // are collected), so whatever is here now is the depositor's change.
        _payEth(msg.sender, address(this).balance);
        emit Deposit(msg.sender, to, shares, usedEth, usedToken);
    }

    /// @notice Burn shares for the matching slice of the position, paid to `to`. ETH arrives as ETH.
    function withdraw(uint256 shares, uint128 ethMin, uint128 tokenMin, address to)
        external
        nonReentrant
        returns (uint256 amountEth, uint256 amountToken)
    {
        if (shares == 0) revert ZeroShares();
        if (to == address(0)) revert ZeroAddress();
        harvest();
        uint128 liq = uint128((uint256(liquidity()) * shares) / totalSupply);
        _burn(msg.sender, shares);
        if (liq > 0) {
            bytes memory actions = abi.encodePacked(V4Actions.DECREASE_LIQUIDITY, V4Actions.TAKE_PAIR);
            bytes[] memory params = new bytes[](2);
            params[0] = abi.encode(tokenId, uint256(liq), ethMin, tokenMin, bytes(""));
            params[1] = abi.encode(V4Actions.NATIVE, token, address(this));
            uint256 e0 = address(this).balance;
            uint256 t0 = IERC20(token).balanceOf(address(this));
            positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);
            amountEth = address(this).balance - e0;
            amountToken = IERC20(token).balanceOf(address(this)) - t0;
        }
        _payEth(to, amountEth);
        _payToken(to, amountToken);
        emit Withdraw(msg.sender, to, shares, amountEth, amountToken);
    }

    /// @notice Collect the position's fees and stream them. Anyone may call;
    ///         deposits and withdrawals do. Also refreshes the reference price.
    function harvest() public {
        (int24 refTick, bool haveRef) = _reference();
        _observe();
        if (tokenId == 0 || farm == address(0)) return;

        bytes memory actions = abi.encodePacked(V4Actions.DECREASE_LIQUIDITY, V4Actions.TAKE_PAIR);
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(tokenId, uint256(0), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(V4Actions.NATIVE, token, address(this));
        uint256 e0 = address(this).balance;
        uint256 t0 = IERC20(token).balanceOf(address(this));
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);
        uint256 ethFees = address(this).balance - e0;
        uint256 tokenFees = IERC20(token).balanceOf(address(this)) - t0;

        // Everything the vault holds of the token is fees: deposits pull exactly
        // what the position takes, so nothing of a depositor's is ever here.
        uint256 tokenHeld = IERC20(token).balanceOf(address(this));
        uint256 swapped;
        if (tokenHeld > 0 && haveRef) {
            uint256 minOut = (V4Liquidity.quote1To0(tokenHeld, refTick) * (10_000 - TWAP_SLIPPAGE_BPS)) / 10_000;
            if (minOut > 0) swapped = _trySwapExactIn(key(), false, tokenHeld, minOut);
        }
        uint256 total = ethFees + swapped;
        if (total == 0) {
            if (ethFees + tokenFees > 0) emit Harvest(ethFees, tokenFees, 0, 0, 0);
            return;
        }
        weth.deposit{value: total}();
        uint256 cut = (total * FEE_BPS) / 10_000;
        uint256 toFarm = total - cut;
        if (cut > 0) {
            totalTreasury += cut;
            if (!weth.transfer(treasury, cut)) revert TransferFailed();
        }
        totalRewards += toFarm;
        weth.approve(farm, toFarm);
        IOrdoStakeFarm(farm).notifyRewardAmount(toFarm);
        emit Harvest(ethFees, tokenFees, swapped, cut, toFarm);
    }

    /// @notice The reference tick the next fee sale will be bounded against, and
    ///         whether it is old enough to be used.
    function referencePrice() external view returns (int24 tick, uint40 at, bool usable) {
        (tick, usable) = _reference();
        at = _refAt;
    }

    function _reference() private view returns (int24 tick, bool ok) {
        ok = _refAt != 0 && block.timestamp - _refAt >= TWAP_WINDOW;
        tick = _refTick;
    }

    /// Record the pool's tick once the last record is a window old. A record
    /// must age a full window before it is used, so a price pushed for one block
    /// only becomes the reference if it also survives ten minutes of arbitrage.
    function _observe() private {
        if (block.timestamp - _refAt < TWAP_WINDOW) return;
        (, int24 tick,,) = stateView.getSlot0(poolId);
        _refTick = tick;
        _refAt = uint40(block.timestamp);
    }

    /// The PositionManager settles the token side from us through Permit2: the
    /// Permit2 allowance is exactly what the position takes, for this block only.
    /// The ERC-20 allowance to Permit2 is unbounded, as every wallet grants it —
    /// Solady tokens fix it at infinity and revert on any other figure — and the
    /// vault keeps no token between transactions for it to reach.
    function _allowPermit2(uint256 amount) private {
        if (amount != 0 && IERC20(token).allowance(address(this), address(permit2)) < amount) {
            IERC20(token).approve(address(permit2), type(uint256).max);
        }
        permit2.approve(token, address(positionManager), uint160(amount), uint48(block.timestamp));
    }

    function _pull(address t, uint256 amount) private {
        if (amount == 0) return;
        if (!IERC20(t).transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
    }

    function _payEth(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _payToken(address to, uint256 amount) private {
        if (amount == 0) return;
        if (!IERC20(token).transfer(to, amount)) revert TransferFailed();
    }
}

// ============================================================================= zap

contract OrdoStakeZapV4 is Guard, V4Swap {
    IWETH public immutable weth;

    event Zapped(address indexed user, address indexed vault, address tokenIn, uint256 amountIn, uint256 shares);
    error TransferFailed();
    error NothingIn();
    error PermitFailed(address token);

    /// An EIP-2612 signature standing in for the token approval.
    struct Permit {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    constructor(address poolManager_, address weth_) V4Swap(poolManager_) {
        weth = IWETH(weth_);
    }

    /// Vault refunds, swap output and unwrapped WETH arrive as ETH mid-transaction; nothing stays here between calls.
    receive() external payable {}

    /// @notice ETH in: half is swapped to the token in the pool, both are deposited, shares are staked for you.
    function zapETH(address vault, uint256 minTokenOut) external payable nonReentrant returns (uint256 shares) {
        if (msg.value == 0) revert NothingIn();
        IOrdoStakeVaultV4 v = IOrdoStakeVaultV4(vault);
        _swapExactIn(v.key(), true, msg.value / 2, minTokenOut);
        shares = _depositAndStake(v, msg.sender);
        emit Zapped(msg.sender, vault, address(0), msg.value, shares);
    }

    /// @notice WETH in by allowance (what the farm pays out): unwrapped, then as zapETH. This is how rewards compound.
    function zapWETH(address vault, uint256 amount, uint256 minTokenOut) external nonReentrant returns (uint256 shares) {
        if (amount == 0) revert NothingIn();
        if (!weth.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        weth.withdraw(amount);
        IOrdoStakeVaultV4 v = IOrdoStakeVaultV4(vault);
        _swapExactIn(v.key(), true, amount / 2, minTokenOut);
        shares = _depositAndStake(v, msg.sender);
        emit Zapped(msg.sender, vault, address(weth), amount, shares);
    }

    /// @notice Token in: half is swapped to ETH in the pool, both are deposited, shares are staked for you.
    function zapToken(address vault, uint256 amount, uint256 minEthOut) external nonReentrant returns (uint256 shares) {
        return _zapToken(vault, amount, minEthOut);
    }

    /// @notice `zapToken` with the allowance granted by signature in the same transaction.
    function zapTokenWithPermit(address vault, uint256 amount, uint256 minEthOut, Permit calldata pm) external nonReentrant returns (uint256 shares) {
        _permit(IOrdoStakeVaultV4(vault).token(), pm);
        return _zapToken(vault, amount, minEthOut);
    }

    /// @notice Both sides in (ETH as value, token by allowance), no swap, staked for you.
    function zapBoth(address vault, uint256 tokenAmount) external payable nonReentrant returns (uint256 shares) {
        return _zapBoth(vault, tokenAmount);
    }

    /// @notice `zapBoth` with the token allowance granted by signature in the same transaction.
    function zapBothWithPermit(address vault, uint256 tokenAmount, Permit calldata pm) external payable nonReentrant returns (uint256 shares) {
        _permit(IOrdoStakeVaultV4(vault).token(), pm);
        return _zapBoth(vault, tokenAmount);
    }

    function _zapToken(address vault, uint256 amount, uint256 minEthOut) private returns (uint256 shares) {
        if (amount == 0) revert NothingIn();
        IOrdoStakeVaultV4 v = IOrdoStakeVaultV4(vault);
        address token = v.token();
        if (!IERC20(token).transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        _swapExactIn(v.key(), false, amount / 2, minEthOut);
        shares = _depositAndStake(v, msg.sender);
        emit Zapped(msg.sender, vault, token, amount, shares);
    }

    function _zapBoth(address vault, uint256 tokenAmount) private returns (uint256 shares) {
        if (msg.value == 0 && tokenAmount == 0) revert NothingIn();
        IOrdoStakeVaultV4 v = IOrdoStakeVaultV4(vault);
        address token = v.token();
        if (tokenAmount > 0 && !IERC20(token).transferFrom(msg.sender, address(this), tokenAmount)) revert TransferFailed();
        shares = _depositAndStake(v, msg.sender);
        emit Zapped(msg.sender, vault, token, tokenAmount, shares);
    }

    /// A permit already consumed (replayed by a front-runner, or made redundant by an approve) is fine; the allowance is what counts.
    function _permit(address token, Permit calldata pm) private {
        try IERC20Permit(token).permit(msg.sender, address(this), pm.value, pm.deadline, pm.v, pm.r, pm.s) {} catch {}
        if (IERC20(token).allowance(msg.sender, address(this)) < pm.value) revert PermitFailed(token);
    }

    /// Deposit everything this contract holds of both sides, stake the shares for `user`, return the dust.
    function _depositAndStake(IOrdoStakeVaultV4 v, address user) private returns (uint256 shares) {
        address token = v.token();
        uint256 t = IERC20(token).balanceOf(address(this));
        IERC20(token).approve(address(v), t);
        (shares,,) = v.deposit{value: address(this).balance}(t, 0, 0, address(this));
        IERC20(token).approve(address(v), 0);
        address farm = v.farm();
        IERC20(address(v)).approve(farm, shares);
        IOrdoStakeFarm(farm).stakeFor(user, shares);
        // Dust: the ETH the vault refunded and the token it did not need.
        uint256 ethLeft = address(this).balance;
        if (ethLeft > 0) {
            (bool ok,) = user.call{value: ethLeft}("");
            if (!ok) revert TransferFailed();
        }
        uint256 tLeft = IERC20(token).balanceOf(address(this));
        if (tLeft > 0 && !IERC20(token).transfer(user, tLeft)) revert TransferFailed();
    }
}

// ========================================================================= factory

/// Creates a vault and its farm for the factory. A contract of its own only
/// because the vault's and the zap's creation code together would push the
/// factory past the size a contract may have.
contract OrdoStakeDeployerV4 {
    address public immutable factory;

    error NotFactory();

    constructor() {
        factory = msg.sender;
    }

    function deploy(address posm, address stateView, PoolKey calldata key, address treasury, string calldata sym, address weth)
        external
        returns (address vault, address farm)
    {
        if (msg.sender != factory) revert NotFactory();
        OrdoStakeVaultV4 v = new OrdoStakeVaultV4(posm, stateView, key, treasury, sym);
        OrdoStakeFarm f = new OrdoStakeFarm(address(v), weth);
        v.setFarm(address(f));
        return (address(v), address(f));
    }
}

contract OrdoStakeFactoryV4 {
    IPositionManagerV4 public immutable positionManager;
    IStateView public immutable stateView;
    address public immutable poolManager;
    address public immutable weth;
    address public immutable treasury;
    OrdoStakeZapV4 public immutable zap;
    OrdoStakeDeployerV4 public immutable deployer;

    struct Stake {
        address token;
        bytes32 poolId;
        address vault;
        address farm;
        uint64 createdAt;
        address creator;
    }

    Stake[] private _stakes;
    mapping(bytes32 => uint256) private _indexByPool; // index + 1

    event StakeCreated(uint256 indexed id, address indexed token, bytes32 indexed poolId, address vault, address farm, address creator);

    error ZeroAddress();
    error NotAPool();
    error NotAnEthPool();
    error HookedPool();
    error StakeExists();

    constructor(address posm_, address stateView_, address treasury_) {
        if (posm_ == address(0) || stateView_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        positionManager = IPositionManagerV4(posm_);
        stateView = IStateView(stateView_);
        poolManager = positionManager.poolManager();
        weth = positionManager.WETH9();
        treasury = treasury_;
        zap = new OrdoStakeZapV4(poolManager, weth);
        deployer = new OrdoStakeDeployerV4();
    }

    /// @notice Attach a stake to an existing ETH/token V4 pool without a hook.
    ///         Anyone can, once per pool. Hooked pools are refused: a hook may
    ///         veto or tax liquidity changes, and a vault whose withdrawals a
    ///         stranger's contract can block is not one to put stakes in.
    function createStake(PoolKey calldata key) external returns (address vault, address farm) {
        if (key.currency0 != V4Actions.NATIVE) revert NotAnEthPool();
        if (key.hooks != address(0)) revert HookedPool();
        bytes32 id = V4Pool.id(key);
        if (_indexByPool[id] != 0) revert StakeExists();
        (uint160 sqrtP,,,) = stateView.getSlot0(id);
        if (sqrtP == 0) revert NotAPool();

        (vault, farm) = deployer.deploy(address(positionManager), address(stateView), key, treasury, _symbol(key.currency1), weth);
        _stakes.push(Stake(key.currency1, id, vault, farm, uint64(block.timestamp), msg.sender));
        _indexByPool[id] = _stakes.length;
        emit StakeCreated(_stakes.length - 1, key.currency1, id, vault, farm, msg.sender);
    }

    function stakeCount() external view returns (uint256) {
        return _stakes.length;
    }

    function stakeAt(uint256 i) external view returns (Stake memory) {
        return _stakes[i];
    }

    function stakeForPool(bytes32 poolId) external view returns (Stake memory s) {
        uint256 i = _indexByPool[poolId];
        if (i != 0) s = _stakes[i - 1];
    }

    function allStakes() external view returns (Stake[] memory) {
        return _stakes;
    }

    function _symbol(address token) private view returns (string memory) {
        try IERC20(token).symbol() returns (string memory s) {
            return s;
        } catch {
            return "TOKEN";
        }
    }
}

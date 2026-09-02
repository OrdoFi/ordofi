// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Stakes: pooled, always-in-range liquidity for a token's ETH pool, paid in ETH.
///
///   OrdoStakeVault   one wide-range Uniswap V3 position per stake; depositors hold
///                    ERC-20 shares of it. Every deposit or withdrawal first harvests
///                    the pool fees: 1% of the WETH to the treasury, the rest streamed
///                    to the farm. Token-side fees are swapped to WETH against a TWAP
///                    bound so nothing can be sandwiched; if the pool has no oracle
///                    history yet they simply wait for the next harvest.
///   OrdoStakeFarm    Synthetix-style rewards: stake vault shares, earn WETH linearly
///                    over 7 days from each harvest.
///   OrdoStakeZap     one coin in (ETH or the token), swapped, paired, deposited and
///                    staked for you in a single transaction. Dust comes back.
///   OrdoStakeFactory attaches a vault + farm to any token/WETH V3 pool, once.
///
/// No admin anywhere. The treasury address is fixed at deployment.

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
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
    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory, uint160[] memory);
}

interface INonfungiblePositionManager {
    struct MintParams { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }
    struct IncreaseLiquidityParams { uint256 tokenId; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }
    struct DecreaseLiquidityParams { uint256 tokenId; uint128 liquidity; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }
    struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }
    function factory() external view returns (address);
    function WETH9() external view returns (address);
    function mint(MintParams calldata) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function increaseLiquidity(IncreaseLiquidityParams calldata) external payable returns (uint128 liquidity, uint256 amount0, uint256 amount1);
    function decreaseLiquidity(DecreaseLiquidityParams calldata) external payable returns (uint256 amount0, uint256 amount1);
    function collect(CollectParams calldata) external payable returns (uint256 amount0, uint256 amount1);
    function positions(uint256 tokenId) external view returns (uint96, address, address, address, uint24, int24, int24, uint128 liquidity, uint256, uint256, uint128, uint128);
}

interface ISwapRouter02 {
    struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }
    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256 amountOut);
}

interface IOrdoStakeFarm {
    function notifyRewardAmount(uint256 reward) external;
    function stakeFor(address account, uint256 amount) external;
    function stakingToken() external view returns (address);
}

interface IOrdoStakeVault {
    function deposit(uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address to) external payable returns (uint256 shares, uint256 used0, uint256 used1);
    function pool() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function farm() external view returns (address);
}

abstract contract Guard {
    uint256 private _locked = 1;
    error Reentrancy();
    modifier nonReentrant() { if (_locked != 1) revert Reentrancy(); _locked = 2; _; _locked = 1; }
}

/// Minimal ERC-20 for vault shares.
abstract contract Shares is IERC20 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    error InsufficientBalance();
    error InsufficientAllowance();
    error ZeroRecipient();

    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; emit Approval(msg.sender, spender, amount); return true; }
    function transfer(address to, uint256 amount) external returns (bool) { _move(msg.sender, to, amount); return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) { if (a < amount) revert InsufficientAllowance(); allowance[from][msg.sender] = a - amount; }
        _move(from, to, amount);
        return true;
    }
    function _move(address from, address to, uint256 amount) internal { if (to == address(0)) revert ZeroRecipient(); if (balanceOf[from] < amount) revert InsufficientBalance(); balanceOf[from] -= amount; balanceOf[to] += amount; emit Transfer(from, to, amount); }
    function _mint(address to, uint256 amount) internal { totalSupply += amount; balanceOf[to] += amount; emit Transfer(address(0), to, amount); }
    function _burn(address from, uint256 amount) internal { if (balanceOf[from] < amount) revert InsufficientBalance(); balanceOf[from] -= amount; totalSupply -= amount; emit Transfer(from, address(0), amount); }
}

// =========================================================================== vault

contract OrdoStakeVault is Shares, Guard {
    INonfungiblePositionManager public immutable positionManager;
    ISwapRouter02 public immutable router;
    IWETH public immutable weth;
    address public immutable treasury;
    address public immutable factory;
    address public immutable pool;
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    int24 public immutable tickLower;
    int24 public immutable tickUpper;
    bool public immutable wethIs0;

    address public farm;
    uint256 public tokenId; // 0 until the first deposit
    uint256 public totalRewards; // WETH streamed to the farm, lifetime
    uint256 public totalTreasury;

    uint256 public constant FEE_BPS = 100;
    uint32 public constant TWAP_WINDOW = 600;
    uint256 public constant TWAP_SLIPPAGE_BPS = 300;
    /// @notice Shares locked forever at the first deposit (worth a few cents of
    ///         liquidity). Anyone can add liquidity to the vault's position
    ///         without receiving shares, so a tiny first supply could be
    ///         inflated against everyone who deposits after it; with this floor
    ///         the supply can never be tiny, and can never return to zero.
    uint256 public constant MIN_SHARES = 1e9;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    event Harvest(uint256 wethFees, uint256 tokenFees, uint256 tokenSwappedToWeth, uint256 toTreasury, uint256 toFarm);
    event Deposit(address indexed from, address indexed to, uint256 shares, uint256 amount0, uint256 amount1);
    event Withdraw(address indexed owner, address indexed to, uint256 shares, uint256 amount0, uint256 amount1);

    error ZeroAddress();
    error FarmSet();
    error NotFactory();
    error ZeroShares();
    error FirstDepositTooSmall();
    error ETHNotAccepted();
    error TransferFailed();

    constructor(address npm_, address router_, address pool_, address treasury_, string memory symbol_) {
        positionManager = INonfungiblePositionManager(npm_);
        router = ISwapRouter02(router_);
        weth = IWETH(positionManager.WETH9());
        treasury = treasury_;
        factory = msg.sender;
        pool = pool_;
        IUniswapV3Pool p = IUniswapV3Pool(pool_);
        token0 = p.token0();
        token1 = p.token1();
        fee = p.fee();
        wethIs0 = token0 == address(weth);
        int24 spacing = p.tickSpacing();
        tickLower = (-887272 / spacing) * spacing;
        tickUpper = (887272 / spacing) * spacing;
        name = string.concat("Ordo Stake ", symbol_);
        symbol = string.concat("os", symbol_);
    }

    function setFarm(address farm_) external { if (msg.sender != factory) revert NotFactory(); if (farm != address(0)) revert FarmSet(); if (farm_ == address(0)) revert ZeroAddress(); farm = farm_; }

    receive() external payable { if (msg.sender != address(weth)) revert ETHNotAccepted(); }

    /// @notice Liquidity of the vault's position; shares are minted pro rata to it.
    function liquidity() public view returns (uint128 liq) { if (tokenId == 0) return 0; (,,,,,,, liq,,,,) = positionManager.positions(tokenId); }

    /// @notice Add both tokens. Send ETH for the WETH side or approve WETH; the token comes by allowance.
    ///         Whatever the position does not take is refunded. Shares go to `to`.
    function deposit(uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address to)
        external payable nonReentrant returns (uint256 shares, uint256 used0, uint256 used1)
    {
        if (to == address(0)) revert ZeroAddress();
        harvest();
        uint128 before = liquidity();
        // Pull the deposit. Anything the vault already holds (fees waiting for an
        // oracle) is measured first so it is never handed to the depositor.
        uint256 held0 = IERC20(token0).balanceOf(address(this));
        uint256 held1 = IERC20(token1).balanceOf(address(this));
        if (msg.value > 0) { weth.deposit{value: msg.value}(); if (wethIs0) amount0Desired = msg.value; else amount1Desired = msg.value; }
        _pull(token0, wethIs0 && msg.value > 0 ? 0 : amount0Desired);
        _pull(token1, !wethIs0 && msg.value > 0 ? 0 : amount1Desired);

        IERC20(token0).approve(address(positionManager), amount0Desired);
        IERC20(token1).approve(address(positionManager), amount1Desired);
        uint128 liq;
        if (tokenId == 0) {
            (tokenId, liq, used0, used1) = positionManager.mint(INonfungiblePositionManager.MintParams(token0, token1, fee, tickLower, tickUpper, amount0Desired, amount1Desired, amount0Min, amount1Min, address(this), block.timestamp));
        } else {
            (liq, used0, used1) = positionManager.increaseLiquidity(INonfungiblePositionManager.IncreaseLiquidityParams(tokenId, amount0Desired, amount1Desired, amount0Min, amount1Min, block.timestamp));
        }
        IERC20(token0).approve(address(positionManager), 0);
        IERC20(token1).approve(address(positionManager), 0);
        if (totalSupply == 0) {
            // First depositor: shares are liquidity, less a floor that is minted
            // to a dead address and can never be withdrawn. Branching on the
            // supply (not the position's liquidity) means liquidity donated to
            // an empty vault is simply captured by the next depositor instead of
            // making every later deposit round to zero.
            if (liq <= MIN_SHARES) revert FirstDepositTooSmall();
            _mint(DEAD, MIN_SHARES);
            shares = uint256(liq) - MIN_SHARES;
        } else {
            shares = (uint256(liq) * totalSupply) / before;
        }
        if (shares == 0) revert ZeroShares();
        _mint(to, shares);

        // Refund the depositor's unused part only.
        _pay(msg.sender, token0, IERC20(token0).balanceOf(address(this)) - held0);
        _pay(msg.sender, token1, IERC20(token1).balanceOf(address(this)) - held1);
        emit Deposit(msg.sender, to, shares, used0, used1);
    }

    /// @notice Burn shares for the matching slice of the position, paid to `to`. WETH arrives as ETH.
    function withdraw(uint256 shares, uint256 amount0Min, uint256 amount1Min, address to) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        if (shares == 0) revert ZeroShares();
        if (to == address(0)) revert ZeroAddress();
        harvest();
        uint128 liq = uint128((uint256(liquidity()) * shares) / totalSupply);
        _burn(msg.sender, shares);
        if (liq > 0) positionManager.decreaseLiquidity(INonfungiblePositionManager.DecreaseLiquidityParams(tokenId, liq, amount0Min, amount1Min, block.timestamp));
        (amount0, amount1) = positionManager.collect(INonfungiblePositionManager.CollectParams(tokenId, address(this), type(uint128).max, type(uint128).max));
        _pay(to, token0, amount0);
        _pay(to, token1, amount1);
        emit Withdraw(msg.sender, to, shares, amount0, amount1);
    }

    /// @notice Collect the position's fees and stream them. Anyone may call; deposits and withdrawals do.
    function harvest() public {
        if (tokenId == 0 || farm == address(0)) return;
        (uint256 c0, uint256 c1) = positionManager.collect(INonfungiblePositionManager.CollectParams(tokenId, address(this), type(uint128).max, type(uint128).max));
        uint256 wethFees = wethIs0 ? c0 : c1;
        uint256 tokenFees = wethIs0 ? c1 : c0;
        address token = wethIs0 ? token1 : token0;
        // Everything the vault holds of the token is fees (deposits never leave any behind).
        uint256 tokenHeld = IERC20(token).balanceOf(address(this));
        uint256 swapped;
        if (tokenHeld > 0) {
            uint256 minOut = _twapQuote(token, tokenHeld);
            if (minOut > 0) {
                IERC20(token).approve(address(router), tokenHeld);
                try router.exactInputSingle(ISwapRouter02.ExactInputSingleParams(token, address(weth), fee, address(this), tokenHeld, (minOut * (10_000 - TWAP_SLIPPAGE_BPS)) / 10_000, 0)) returns (uint256 out) { swapped = out; } catch {}
                IERC20(token).approve(address(router), 0);
            }
        }
        uint256 total = wethFees + swapped;
        if (total == 0) { if (c0 + c1 > 0) emit Harvest(wethFees, tokenFees, 0, 0, 0); return; }
        uint256 cut = (total * FEE_BPS) / 10_000;
        uint256 toFarm = total - cut;
        if (cut > 0) { totalTreasury += cut; if (!weth.transfer(treasury, cut)) revert TransferFailed(); }
        totalRewards += toFarm;
        weth.approve(farm, toFarm);
        IOrdoStakeFarm(farm).notifyRewardAmount(toFarm);
        emit Harvest(wethFees, tokenFees, swapped, cut, toFarm);
    }

    /// WETH the pool's 10-minute TWAP says `amount` of the token is worth; 0 if the pool has no oracle history.
    function _twapQuote(address token, uint256 amount) internal view returns (uint256) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = TWAP_WINDOW;
        ago[1] = 0;
        try IUniswapV3Pool(pool).observe(ago) returns (int56[] memory ticks, uint160[] memory) {
            int56 delta = ticks[1] - ticks[0];
            int24 tick = int24(delta / int56(uint56(TWAP_WINDOW)));
            if (delta < 0 && delta % int56(uint56(TWAP_WINDOW)) != 0) tick--;
            uint256 sqrtP = _sqrtAtTick(tick);
            if (amount >= 1 << 96) return 0; // beyond what this arithmetic covers; skip the swap this round
            // sqrtP is Q96; applying it twice in Q96 steps keeps every intermediate under 2^256.
            if (token == token0) return (((amount * sqrtP) >> 96) * sqrtP) >> 96; // token0 → token1
            return (((amount << 96) / sqrtP) << 96) / sqrtP; // token1 → token0
        } catch { return 0; }
    }

    /// TickMath.getSqrtRatioAtTick, verbatim.
    function _sqrtAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
        uint256 ratio = absTick & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
        if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
        if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
        if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
        if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
        if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
        if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
        if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
        if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
        if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
        if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
        if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
        if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
        if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
        if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
        if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
        if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
        if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
        if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
        if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;
        if (tick > 0) ratio = type(uint256).max / ratio;
        sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
    }

    function _pull(address token, uint256 amount) private { if (amount == 0) return; if (!IERC20(token).transferFrom(msg.sender, address(this), amount)) revert TransferFailed(); }
    function _pay(address to, address token, uint256 amount) private {
        if (amount == 0) return;
        if (token == address(weth)) { weth.withdraw(amount); (bool ok,) = to.call{value: amount}(""); if (!ok) revert TransferFailed(); }
        else if (!IERC20(token).transfer(to, amount)) revert TransferFailed();
    }
}

// ============================================================================ farm

/// Synthetix StakingRewards, trimmed: the vault is the only reward source.
contract OrdoStakeFarm is Guard {
    IERC20 public immutable stakingToken; // vault shares
    IERC20 public immutable rewardsToken; // WETH
    address public immutable vault;
    uint256 public constant DURATION = 7 days;

    uint256 public periodFinish;
    uint256 public rewardRate;
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenStored;
    uint256 public totalSupply;
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;
    mapping(address => uint256) public balanceOf;

    event RewardAdded(uint256 reward, uint256 rate, uint256 periodFinish);
    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);

    error NotVault();
    error ZeroAmount();
    error TransferFailed();

    constructor(address vault_, address weth_) { vault = vault_; stakingToken = IERC20(vault_); rewardsToken = IERC20(weth_); }

    function lastTimeRewardApplicable() public view returns (uint256) { return block.timestamp < periodFinish ? block.timestamp : periodFinish; }
    function rewardPerToken() public view returns (uint256) {
        if (totalSupply == 0) return rewardPerTokenStored;
        return rewardPerTokenStored + ((lastTimeRewardApplicable() - lastUpdateTime) * rewardRate * 1e18) / totalSupply;
    }
    function earned(address account) public view returns (uint256) { return (balanceOf[account] * (rewardPerToken() - userRewardPerTokenPaid[account])) / 1e18 + rewards[account]; }

    modifier update(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) { rewards[account] = earned(account); userRewardPerTokenPaid[account] = rewardPerTokenStored; }
        _;
    }

    function stake(uint256 amount) external { _stake(msg.sender, msg.sender, amount); }
    /// @notice Stake on someone's behalf — the zap uses this so one transaction ends staked.
    function stakeFor(address account, uint256 amount) external { _stake(msg.sender, account, amount); }
    function _stake(address from, address account, uint256 amount) private nonReentrant update(account) {
        if (amount == 0) revert ZeroAmount();
        totalSupply += amount;
        balanceOf[account] += amount;
        if (!stakingToken.transferFrom(from, address(this), amount)) revert TransferFailed();
        emit Staked(account, amount);
    }
    function withdraw(uint256 amount) public nonReentrant update(msg.sender) {
        if (amount == 0) revert ZeroAmount();
        totalSupply -= amount;
        balanceOf[msg.sender] -= amount;
        if (!stakingToken.transfer(msg.sender, amount)) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }
    function getReward() public nonReentrant update(msg.sender) {
        uint256 r = rewards[msg.sender];
        if (r > 0) { rewards[msg.sender] = 0; if (!rewardsToken.transfer(msg.sender, r)) revert TransferFailed(); emit RewardPaid(msg.sender, r); }
    }
    function exit() external { withdraw(balanceOf[msg.sender]); getReward(); }

    /// @notice Called by the vault with WETH already approved: adds it to the current 7-day stream.
    function notifyRewardAmount(uint256 reward) external update(address(0)) {
        if (msg.sender != vault) revert NotVault();
        if (!rewardsToken.transferFrom(msg.sender, address(this), reward)) revert TransferFailed();
        if (block.timestamp >= periodFinish) rewardRate = reward / DURATION;
        else { uint256 leftover = (periodFinish - block.timestamp) * rewardRate; rewardRate = (reward + leftover) / DURATION; }
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + DURATION;
        emit RewardAdded(reward, rewardRate, periodFinish);
    }
}

// ============================================================================= zap

contract OrdoStakeZap is Guard {
    ISwapRouter02 public immutable router;
    IWETH public immutable weth;

    event Zapped(address indexed user, address indexed vault, address tokenIn, uint256 amountIn, uint256 shares);
    error TransferFailed();
    error NothingIn();

    constructor(address router_, address weth_) { router = ISwapRouter02(router_); weth = IWETH(weth_); }
    /// Vault refunds arrive as ETH mid-transaction; nothing stays here between calls.
    receive() external payable {}

    /// @notice ETH in: half is swapped to the token, both are deposited, shares are staked for you.
    function zapETH(address vault, uint256 minTokenOut) external payable nonReentrant returns (uint256 shares) {
        if (msg.value == 0) revert NothingIn();
        weth.deposit{value: msg.value}();
        IOrdoStakeVault v = IOrdoStakeVault(vault);
        address token = v.token0() == address(weth) ? v.token1() : v.token0();
        uint256 half = msg.value / 2;
        _swap(address(weth), token, v.fee(), half, minTokenOut);
        shares = _depositAndStake(v, token, msg.sender);
        emit Zapped(msg.sender, vault, address(0), msg.value, shares);
    }

    /// @notice WETH in by allowance (what the farm pays out): same as zapETH. This is how rewards compound.
    function zapWETH(address vault, uint256 amount, uint256 minTokenOut) external nonReentrant returns (uint256 shares) {
        if (amount == 0) revert NothingIn();
        if (!weth.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        IOrdoStakeVault v = IOrdoStakeVault(vault);
        address token = v.token0() == address(weth) ? v.token1() : v.token0();
        _swap(address(weth), token, v.fee(), amount / 2, minTokenOut);
        shares = _depositAndStake(v, token, msg.sender);
        emit Zapped(msg.sender, vault, address(weth), amount, shares);
    }

    /// @notice Token in: half is swapped to WETH, both are deposited, shares are staked for you.
    function zapToken(address vault, uint256 amount, uint256 minWethOut) external nonReentrant returns (uint256 shares) {
        if (amount == 0) revert NothingIn();
        IOrdoStakeVault v = IOrdoStakeVault(vault);
        address token = v.token0() == address(weth) ? v.token1() : v.token0();
        if (!IERC20(token).transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        _swap(token, address(weth), v.fee(), amount / 2, minWethOut);
        shares = _depositAndStake(v, token, msg.sender);
        emit Zapped(msg.sender, vault, token, amount, shares);
    }

    /// @notice Both sides in (ETH as value, token by allowance), no swap, staked for you.
    function zapBoth(address vault, uint256 tokenAmount) external payable nonReentrant returns (uint256 shares) {
        if (msg.value == 0 && tokenAmount == 0) revert NothingIn();
        IOrdoStakeVault v = IOrdoStakeVault(vault);
        address token = v.token0() == address(weth) ? v.token1() : v.token0();
        if (msg.value > 0) weth.deposit{value: msg.value}();
        if (tokenAmount > 0 && !IERC20(token).transferFrom(msg.sender, address(this), tokenAmount)) revert TransferFailed();
        shares = _depositAndStake(v, token, msg.sender);
        emit Zapped(msg.sender, vault, token, tokenAmount, shares);
    }

    function _swap(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint256 minOut) private {
        if (amountIn == 0) return;
        IERC20(tokenIn).approve(address(router), amountIn);
        router.exactInputSingle(ISwapRouter02.ExactInputSingleParams(tokenIn, tokenOut, fee, address(this), amountIn, minOut, 0));
        IERC20(tokenIn).approve(address(router), 0);
    }

    /// Deposit everything this contract holds of both tokens, stake the shares for `user`, return dust.
    function _depositAndStake(IOrdoStakeVault v, address token, address user) private returns (uint256 shares) {
        uint256 w = weth.balanceOf(address(this));
        uint256 t = IERC20(token).balanceOf(address(this));
        weth.approve(address(v), w);
        IERC20(token).approve(address(v), t);
        bool weth0 = v.token0() == address(weth);
        (shares,,) = v.deposit(weth0 ? w : t, weth0 ? t : w, 0, 0, address(this));
        weth.approve(address(v), 0);
        IERC20(token).approve(address(v), 0);
        address farm = v.farm();
        IERC20(address(v)).approve(farm, shares);
        IOrdoStakeFarm(farm).stakeFor(user, shares);
        // Dust: the vault refunded it to us (as ETH for the WETH side); pass it on.
        uint256 ethLeft = address(this).balance;
        if (ethLeft > 0) { (bool ok,) = user.call{value: ethLeft}(""); if (!ok) revert TransferFailed(); }
        uint256 wLeft = weth.balanceOf(address(this));
        if (wLeft > 0) { weth.withdraw(wLeft); (bool ok,) = user.call{value: wLeft}(""); if (!ok) revert TransferFailed(); }
        uint256 tLeft = IERC20(token).balanceOf(address(this));
        if (tLeft > 0 && !IERC20(token).transfer(user, tLeft)) revert TransferFailed();
    }
}

// ========================================================================= factory

contract OrdoStakeFactory {
    INonfungiblePositionManager public immutable positionManager;
    IUniswapV3Factory public immutable v3Factory;
    address public immutable router;
    address public immutable weth;
    address public immutable treasury;
    OrdoStakeZap public immutable zap;

    struct Stake { address token; address pool; address vault; address farm; uint64 createdAt; address creator; }
    Stake[] private _stakes;
    mapping(address => uint256) private _indexByPool; // index + 1

    event StakeCreated(uint256 indexed id, address indexed token, address indexed pool, address vault, address farm, address creator);

    error ZeroAddress();
    error NotAPool();
    error NotAnEthPool();
    error StakeExists();

    constructor(address npm_, address router_, address treasury_) {
        if (npm_ == address(0) || router_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        positionManager = INonfungiblePositionManager(npm_);
        v3Factory = IUniswapV3Factory(positionManager.factory());
        weth = positionManager.WETH9();
        router = router_;
        treasury = treasury_;
        zap = new OrdoStakeZap(router_, weth);
    }

    /// @notice Attach a stake to an existing token/WETH V3 pool. Anyone can, once per pool.
    function createStake(address pool) external returns (address vault, address farm) {
        if (_indexByPool[pool] != 0) revert StakeExists();
        IUniswapV3Pool p = IUniswapV3Pool(pool);
        address t0 = p.token0();
        address t1 = p.token1();
        if (v3Factory.getPool(t0, t1, p.fee()) != pool) revert NotAPool();
        if (t0 != weth && t1 != weth) revert NotAnEthPool();
        address token = t0 == weth ? t1 : t0;
        string memory sym = _symbol(token);
        OrdoStakeVault v = new OrdoStakeVault(address(positionManager), router, pool, treasury, sym);
        OrdoStakeFarm f = new OrdoStakeFarm(address(v), weth);
        v.setFarm(address(f));
        vault = address(v);
        farm = address(f);
        _stakes.push(Stake(token, pool, vault, farm, uint64(block.timestamp), msg.sender));
        _indexByPool[pool] = _stakes.length;
        emit StakeCreated(_stakes.length - 1, token, pool, vault, farm, msg.sender);
    }

    function stakeCount() external view returns (uint256) { return _stakes.length; }
    function stakeAt(uint256 i) external view returns (Stake memory) { return _stakes[i]; }
    function stakeForPool(address pool) external view returns (Stake memory s) { uint256 i = _indexByPool[pool]; if (i != 0) s = _stakes[i - 1]; }
    function allStakes() external view returns (Stake[] memory) { return _stakes; }

    function _symbol(address token) private view returns (string memory) {
        try IERC20(token).symbol() returns (string memory s) { return s; } catch { return "TOKEN"; }
    }
}

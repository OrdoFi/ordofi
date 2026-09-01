// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice How a `Check`'s observed word is compared against its expected word.
enum Op {
    Eq,
    Gte,
    Lte
}

/// @notice One call in a bundle.
/// @dev `allowFailure` exists for legs that are genuinely optional — a sweep of
///      a token that may hold a zero balance, say. It defaults to false, which
///      is the whole point of the contract: any leg that reverts takes the
///      bundle with it.
struct Call {
    address target;
    uint256 value;
    bytes data;
    bool allowFailure;
}

/// @notice A precondition asserted against live state before any call runs.
/// @dev The observed value is the first 32-byte word the `staticcall` returns,
///      `mask`ed before comparison so a caller can isolate a packed field —
///      a `sqrtPriceX96` out of a Uniswap v4 `slot0`, for instance — without
///      needing a purpose-built view.
struct Check {
    address target;
    bytes data;
    bytes32 mask;
    bytes32 expected;
    Op op;
}

/// @title OrdoExecutor
/// @notice One address's atomic bundle executor on Robinhood Chain.
///
/// @dev ## What atomicity this actually provides
///
/// Robinhood Chain has a single sequencer, orders first-come-first-served, and
/// exposes no bundle endpoint. That makes *cross-sender* atomicity — a user's
/// trade and a searcher's backrun landing adjacent, or neither landing —
/// impossible without the sequencer's cooperation, and no contract can change
/// that. Anyone claiming otherwise is selling a race.
///
/// What is possible today, and is what this contract does:
///
///   1. **Within one sender, atomicity is total.** Every leg runs in a single
///      transaction. If any leg reverts, all of them revert. A multi-hop
///      arbitrage, or a buy/act/sell round trip, either completes or costs
///      nothing but gas. This is the guarantee a searcher actually needs for
///      their own legs, and today they get it by deploying their own bot
///      contract; here it is a public primitive.
///
///   2. **Across senders, execution becomes conditional rather than atomic.**
///      A backrun cannot be guaranteed to land behind its target, but it can
///      be made to *refuse to execute* unless the target already landed. The
///      searcher asserts the state the user's trade would have produced — a
///      pool price past a bound — and if the race was lost the bundle reverts
///      having traded nothing. The searcher pays gas on a miss instead of
///      eating a fill at a price that no longer exists.
///
///      This is strictly weaker than a Jito bundle and is described as such.
///      It converts an unbounded execution risk into a bounded gas cost.
///
/// ## Why one executor per owner
///
/// A shared multicall that anyone may drive is a standing invitation to drain
/// whoever grants it a token allowance, because an attacker can call it with
/// `transferFrom` calldata of their choosing. This contract's owner is an
/// immutable set at construction and `execute` is owner-only, so allowances
/// granted here can only ever be spent by the account that granted them.
/// Deployment is CREATE2 with the owner as salt, so the address is derivable
/// before it exists and cannot be occupied by anyone else.
contract OrdoExecutor {
    /// @notice The only account that can ever execute through this contract.
    address public immutable owner;

    uint256 private _locked = 1;

    event Executed(address indexed caller, uint256 callCount, uint256 balanceBefore, uint256 balanceAfter);

    error NotOwner();
    error Reentrancy();
    error DeadlinePassed(uint64 maxBlock, uint256 currentBlock);
    error CheckFailed(uint256 index, bytes32 observed, bytes32 expected);
    error CheckReverted(uint256 index);
    error CallFailed(uint256 index, bytes returnData);
    error GainTooLow(uint256 balanceBefore, uint256 balanceAfter, uint256 required);
    error WithdrawFailed();

    constructor(address owner_) {
        owner = owner_;
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

    /// @notice Run a bundle: assert preconditions, then execute every call
    ///         atomically, then assert the bundle made money.
    ///
    /// @param calls        The legs, in order. Any revert unwinds all of them
    ///                     unless that leg set `allowFailure`.
    /// @param checks       Preconditions evaluated before the first call. Use
    ///                     these to refuse to execute when the transaction this
    ///                     bundle was meant to follow has not landed.
    /// @param maxBlock     Latest block this may execute in; zero disables the
    ///                     bound. Blocks rather than timestamps, because at
    ///                     sub-second block times a timestamp deadline is too
    ///                     coarse to express "the next few blocks".
    /// @param minGainWei   Ether this contract must hold *more* of when the
    ///                     bundle finishes than when it started. Gas is not
    ///                     counted, so a searcher sets this above their gas
    ///                     cost to make an unprofitable bundle revert rather
    ///                     than settle.
    ///
    /// @return results     Each call's return data, in order.
    function execute(Call[] calldata calls, Check[] calldata checks, uint64 maxBlock, uint256 minGainWei)
        external
        payable
        onlyOwner
        nonReentrant
        returns (bytes[] memory results)
    {
        if (maxBlock != 0 && block.number > maxBlock) revert DeadlinePassed(maxBlock, block.number);

        _runChecks(checks);

        // Taken after `msg.value` has landed, so working capital sent in with
        // the bundle counts as capital the bundle has to give back.
        uint256 balanceBefore = address(this).balance;

        results = new bytes[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            Call calldata c = calls[i];
            (bool ok, bytes memory ret) = c.target.call{value: c.value}(c.data);
            if (!ok && !c.allowFailure) revert CallFailed(i, ret);
            results[i] = ret;
        }

        uint256 balanceAfter = address(this).balance;
        if (minGainWei != 0) {
            uint256 required = balanceBefore + minGainWei;
            if (balanceAfter < required) revert GainTooLow(balanceBefore, balanceAfter, required);
        }

        emit Executed(msg.sender, calls.length, balanceBefore, balanceAfter);
    }

    /// @notice Evaluate preconditions without executing anything.
    /// @dev Lets a keeper or the gateway ask "would this bundle run right now"
    ///      over `eth_call`, without simulating the calls themselves.
    function checksPass(Check[] calldata checks) external view returns (bool) {
        for (uint256 i = 0; i < checks.length; i++) {
            (bool ok, bytes32 observed) = _observe(checks[i]);
            if (!ok || !_compare(checks[i].op, observed, checks[i].expected)) return false;
        }
        return true;
    }

    function withdraw(address to, uint256 amount) external onlyOwner {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
    }

    /// @dev Tokens are moved with a raw call so this contract needs no ERC-20
    ///      interface and works with the non-standard tokens that return nothing.
    function withdrawToken(address token, address to, uint256 amount) external onlyOwner {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert WithdrawFailed();
    }

    function _runChecks(Check[] calldata checks) private view {
        for (uint256 i = 0; i < checks.length; i++) {
            (bool ok, bytes32 observed) = _observe(checks[i]);
            if (!ok) revert CheckReverted(i);
            if (!_compare(checks[i].op, observed, checks[i].expected)) {
                revert CheckFailed(i, observed, checks[i].expected);
            }
        }
    }

    function _observe(Check calldata check) private view returns (bool ok, bytes32 observed) {
        bytes memory ret;
        (ok, ret) = check.target.staticcall(check.data);
        if (!ok || ret.length < 32) return (false, bytes32(0));
        assembly {
            observed := mload(add(ret, 32))
        }
        observed &= check.mask;
    }

    function _compare(Op op, bytes32 observed, bytes32 expected) private pure returns (bool) {
        if (op == Op.Eq) return observed == expected;
        if (op == Op.Gte) return uint256(observed) >= uint256(expected);
        return uint256(observed) <= uint256(expected);
    }

    receive() external payable {}
}

/// @title OrdoBundler
/// @notice Deploys and addresses the per-owner executors.
///
/// @dev The owner is baked into the executor's constructor and the salt is the
///      owner's address, so `executorOf` is answerable before deployment and
///      nobody can deploy someone else's executor with a different owner. There
///      is no initializer, and therefore no window in which a freshly deployed
///      executor is unowned.
contract OrdoBundler {
    event ExecutorDeployed(address indexed owner, address indexed executor);

    /// @notice Hash of the executor's creation code, for off-chain address derivation.
    bytes32 public immutable EXECUTOR_INIT_CODE_HASH_PREFIX;

    constructor() {
        EXECUTOR_INIT_CODE_HASH_PREFIX = keccak256(type(OrdoExecutor).creationCode);
    }

    /// @notice The executor address for `owner`, deployed or not.
    function executorOf(address owner) public view returns (address) {
        bytes32 initCodeHash = keccak256(abi.encodePacked(type(OrdoExecutor).creationCode, abi.encode(owner)));
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), address(this), bytes32(uint256(uint160(owner))), initCodeHash)
                    )
                )
            )
        );
    }

    function isDeployed(address owner) public view returns (bool) {
        return executorOf(owner).code.length != 0;
    }

    /// @notice Deploy `owner`'s executor. Idempotent: returns the existing one
    ///         if it is already there, so a caller never has to check first.
    function deploy(address owner) public returns (address executor) {
        executor = executorOf(owner);
        if (executor.code.length != 0) return executor;

        executor = address(new OrdoExecutor{salt: bytes32(uint256(uint160(owner)))}(owner));
        emit ExecutorDeployed(owner, executor);
    }

    /// @notice Deploy the caller's own executor.
    function deploy() external returns (address) {
        return deploy(msg.sender);
    }
}

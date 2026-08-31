// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title OrdoSettlement
/// @notice On-chain settlement for OrdoFi's backrun order-flow auction on
///         Robinhood Chain. Searchers bond native ETH; when they win an
///         auction, the clearing price is debited from their bond and split
///         between the end user, the order-flow originating app, and the
///         protocol. Beneficiaries claim their balances permissionlessly.
///
/// @dev    Trust model: the off-chain auctioneer submits settlements, but it
///         can never over-charge a searcher. Every settlement carries the
///         searcher's own EIP-712 signature over (opportunityId, amount), so
///         the contract only debits amounts the searcher provably authorized
///         as a bid. Replay is prevented per opportunityId.
contract OrdoSettlement {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    struct Settlement {
        address searcher; // who pays (must have signed the bid)
        bytes32 opportunityId; // unique auction id; also the replay key
        uint256 maxAmountWei; // the searcher's signed bid (max willingness to pay)
        uint256 chargeWei; // actual charge (clearing/second price); must be <= maxAmountWei
        address user; // end user whose order created the value
        address app; // order-flow originator (wallet/DEX/app)
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    mapping(address => uint256) public bond; // searcher bonded balance
    mapping(address => uint256) public claimable; // beneficiary claimable balance
    mapping(bytes32 => bool) public settled; // opportunityId => used

    address public owner;
    address public auctioneer; // authorized settlement submitter (OrdoFi backend)
    address public protocolTreasury;

    // Split in basis points. userBps is implied: 10000 - appBps - protocolBps.
    uint16 public appBps;
    uint16 public protocolBps;

    // EIP-712
    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public constant BID_TYPEHASH =
        keccak256("Bid(address searcher,bytes32 opportunityId,uint256 maxAmountWei)");

    uint256 private _locked = 1;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event Deposited(address indexed searcher, uint256 amount, uint256 newBond);
    event BondWithdrawn(address indexed searcher, uint256 amount, uint256 newBond);
    event Settled(
        bytes32 indexed opportunityId,
        address indexed searcher,
        uint256 amount,
        uint256 userAmt,
        uint256 appAmt,
        uint256 protocolAmt,
        address user,
        address app
    );
    event Claimed(address indexed beneficiary, uint256 amount);
    event AuctioneerUpdated(address indexed auctioneer);
    event SplitUpdated(uint16 appBps, uint16 protocolBps);
    event TreasuryUpdated(address indexed treasury);
    event OwnerUpdated(address indexed owner);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotOwner();
    error NotAuctioneer();
    error AlreadySettled();
    error BadSignature();
    error ChargeExceedsBid();
    error InsufficientBond();
    error NothingToClaim();
    error InvalidSplit();
    error ZeroAddress();
    error TransferFailed();
    error Reentrancy();

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

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

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    constructor(address _auctioneer, address _protocolTreasury, uint16 _appBps, uint16 _protocolBps) {
        if (_auctioneer == address(0) || _protocolTreasury == address(0)) revert ZeroAddress();
        if (uint256(_appBps) + uint256(_protocolBps) > 10_000) revert InvalidSplit();

        owner = msg.sender;
        auctioneer = _auctioneer;
        protocolTreasury = _protocolTreasury;
        appBps = _appBps;
        protocolBps = _protocolBps;

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("OrdoSettlement")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    // ---------------------------------------------------------------------
    // Searcher bonding
    // ---------------------------------------------------------------------

    function deposit() external payable {
        bond[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value, bond[msg.sender]);
    }

    receive() external payable {
        bond[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value, bond[msg.sender]);
    }

    function withdrawBond(uint256 amount) external nonReentrant {
        uint256 bal = bond[msg.sender];
        if (amount > bal) revert InsufficientBond();
        bond[msg.sender] = bal - amount;
        _send(msg.sender, amount);
        emit BondWithdrawn(msg.sender, amount, bond[msg.sender]);
    }

    // ---------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------

    /// @notice Debit a winning searcher's bond and credit the split to the
    ///         user, app, and protocol. Callable only by the auctioneer, and
    ///         only with the searcher's valid EIP-712 signature over the bid.
    function settle(Settlement calldata s, bytes calldata searcherSig) external {
        if (msg.sender != auctioneer) revert NotAuctioneer();
        if (settled[s.opportunityId]) revert AlreadySettled();
        // Second-price: the searcher signs their max bid; we charge the lower
        // clearing price. Charging more than the signed bid is never allowed.
        if (s.chargeWei > s.maxAmountWei) revert ChargeExceedsBid();

        bytes32 structHash = keccak256(abi.encode(BID_TYPEHASH, s.searcher, s.opportunityId, s.maxAmountWei));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        if (_recover(digest, searcherSig) != s.searcher) revert BadSignature();

        uint256 amount = s.chargeWei;
        if (bond[s.searcher] < amount) revert InsufficientBond();

        settled[s.opportunityId] = true;
        bond[s.searcher] -= amount;

        uint256 appAmt = (amount * appBps) / 10_000;
        uint256 protocolAmt = (amount * protocolBps) / 10_000;
        uint256 userAmt = amount - appAmt - protocolAmt;

        if (userAmt > 0) claimable[s.user] += userAmt;
        if (appAmt > 0) claimable[s.app] += appAmt;
        if (protocolAmt > 0) claimable[protocolTreasury] += protocolAmt;

        emit Settled(s.opportunityId, s.searcher, amount, userAmt, appAmt, protocolAmt, s.user, s.app);
    }

    // ---------------------------------------------------------------------
    // Claims
    // ---------------------------------------------------------------------

    function claim() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender] = 0;
        _send(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setAuctioneer(address _auctioneer) external onlyOwner {
        if (_auctioneer == address(0)) revert ZeroAddress();
        auctioneer = _auctioneer;
        emit AuctioneerUpdated(_auctioneer);
    }

    function setSplit(uint16 _appBps, uint16 _protocolBps) external onlyOwner {
        if (uint256(_appBps) + uint256(_protocolBps) > 10_000) revert InvalidSplit();
        appBps = _appBps;
        protocolBps = _protocolBps;
        emit SplitUpdated(_appBps, _protocolBps);
    }

    function setProtocolTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        protocolTreasury = _treasury;
        emit TreasuryUpdated(_treasury);
    }

    function transferOwnership(address _owner) external onlyOwner {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
        emit OwnerUpdated(_owner);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /// @notice The EIP-712 digest a searcher must sign to authorize a bid up to
    ///         maxAmountWei. The searcher may be charged any amount <= this.
    function bidDigest(address searcher, bytes32 opportunityId, uint256 maxAmountWei) external view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(BID_TYPEHASH, searcher, opportunityId, maxAmountWei));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        // Reject high-s signature malleability (EIP-2).
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert BadSignature();
        }
        if (v != 27 && v != 28) revert BadSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }
}

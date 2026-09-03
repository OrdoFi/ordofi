# Uniswap V4 math, vendored

Byte-identical copies of the MIT-licensed libraries OrdoLadderManagerV4 needs
to compute the same liquidity and token amounts the PoolManager will, so what
it asks the PositionManager to mint is exactly what the pool takes:

- `TickMath`, `SqrtPriceMath`, `FullMath`, `UnsafeMath`, `FixedPoint96`,
  `SafeCast`, `CustomRevert`, `BitMath` — Uniswap/v4-core `main` @ `46c6834698c4`
- `LiquidityAmounts` — Uniswap/v4-periphery `main` @ `dce236d4e205`

`foundry.toml` remaps `@uniswap/v4-core/src/libraries/` here so the periphery
file's imports resolve without edits. Nothing else from either repository is
used: the PositionManager, StateView and Permit2 are called through interfaces
declared next to the manager.

/**
 * Everything the batcher asks the chain: the simulation oracle, the checks that
 * keep a bad order from failing everyone's batch, and the settlement itself —
 * signed here and sent on the private path like every other Ordo transaction.
 */
import { decodeErrorResult, encodeFunctionData, decodeFunctionResult, hashTypedData, recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { rpcFetch, sendRawTransaction } from "@ordofi/core";
import { revertBytes } from "@ordofi/core/ordoswap";
import { BATCH_ABI, ERC20_ABI, ORDER_TYPES, domain } from "./abi.js";
import type { Interaction, Order, Price, SimResult } from "./types.js";

export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

export interface ChainConfig {
  chainId: number;
  batch: Hex;
  solverKey: Hex;
}

export class Chain {
  readonly account;
  private nonce = 0;
  private maxFeePerGas = 2_000_000_000n;
  private nonceLoaded = false;

  constructor(readonly cfg: ChainConfig, readonly rpc: Rpc = rpcFetch) {
    this.account = privateKeyToAccount(cfg.solverKey);
  }

  // ---------------------------------------------------------------- orders

  orderHash(o: Order): Hex {
    return hashTypedData({ domain: domain(this.cfg.chainId, this.cfg.batch), types: ORDER_TYPES, primaryType: "Order", message: o });
  }

  /** Who signed this order, or null. Contract wallets are checked on-chain instead. */
  async signer(o: Order, signature: Hex): Promise<Hex | null> {
    try {
      const a = await recoverTypedDataAddress({ domain: domain(this.cfg.chainId, this.cfg.batch), types: ORDER_TYPES, primaryType: "Order", message: o, signature });
      return a.toLowerCase() as Hex;
    } catch {
      return null;
    }
  }

  async hasCode(addr: Hex): Promise<boolean> {
    const code = (await this.rpc("eth_getCode", [addr, "latest"])) as string;
    return typeof code === "string" && code.length > 2;
  }

  /** Allowance and balance in one round trip — the two things that fail a pull. */
  async canPull(owner: Hex, token: Hex, amount: bigint): Promise<{ ok: boolean; why?: string }> {
    const [allowanceHex, balanceHex] = (await Promise.all([
      this.rpc("eth_call", [{ to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "allowance", args: [owner, this.cfg.batch] }) }, "latest"]),
      this.rpc("eth_call", [{ to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "balanceOf", args: [owner] }) }, "latest"]),
    ])) as [Hex, Hex];
    const allowance = BigInt(allowanceHex);
    const balance = BigInt(balanceHex);
    if (balance < amount) return { ok: false, why: `balance ${balance} < ${amount}` };
    if (allowance < amount) return { ok: false, why: `allowance ${allowance} < ${amount}; approve ${this.cfg.batch} first` };
    return { ok: true };
  }

  async escrowed(hash: Hex): Promise<bigint> {
    const r = (await this.rpc("eth_call", [{ to: this.cfg.batch, data: encodeFunctionData({ abi: BATCH_ABI, functionName: "escrowed", args: [hash] }) }, "latest"])) as Hex;
    return BigInt(r);
  }

  async nonceUsed(owner: Hex, nonce: bigint): Promise<boolean> {
    const r = (await this.rpc("eth_call", [{ to: this.cfg.batch, data: encodeFunctionData({ abi: BATCH_ABI, functionName: "nonceUsed", args: [owner, nonce] }) }, "latest"])) as Hex;
    return decodeFunctionResult({ abi: BATCH_ABI, functionName: "nonceUsed", data: r }) as boolean;
  }

  async maxFeeBps(): Promise<bigint> {
    const r = (await this.rpc("eth_call", [{ to: this.cfg.batch, data: encodeFunctionData({ abi: BATCH_ABI, functionName: "maxFeeBps" }) }, "latest"])) as Hex;
    return BigInt(r);
  }

  // ------------------------------------------------------------ simulation

  /**
   * Run the settlement without sending it. Always reverts; the answer is in the
   * revert. Any other revert is the route's problem and is returned as an error.
   */
  async simulate(orders: Order[], prices: Price[], interactions: Interaction[]): Promise<SimResult | { error: string }> {
    const data = encodeFunctionData({ abi: BATCH_ABI, functionName: "simulate", args: [orders, prices, interactions] });
    try {
      await this.rpc("eth_call", [{ from: this.account.address, to: this.cfg.batch, data }, "latest"]);
      return { error: "simulate returned instead of reverting" };
    } catch (e) {
      const bytes = revertBytes(e);
      if (!bytes) return { error: (e as Error).message };
      try {
        const d = decodeErrorResult({ abi: BATCH_ABI, data: bytes });
        if (d.errorName === "SimResult") {
          const [tokens, delta, owed, buyAmounts] = d.args as [readonly Hex[], readonly bigint[], readonly bigint[], readonly bigint[]];
          return { tokens: tokens.map((t) => t.toLowerCase() as Hex), delta: [...delta], owed: [...owed], buyAmounts: [...buyAmounts] };
        }
        return { error: `${d.errorName}(${(d.args ?? []).map(String).join(",")})` };
      } catch {
        return { error: `revert ${bytes.slice(0, 10)}` };
      }
    }
  }

  /** The real thing as an eth_call, to be sure before spending gas. */
  async dryRunSettle(orders: Order[], signatures: Hex[], prices: Price[], interactions: Interaction[]): Promise<{ ok: true; gas: bigint } | { ok: false; error: string }> {
    const data = encodeFunctionData({ abi: BATCH_ABI, functionName: "settle", args: [orders, signatures, prices, interactions] });
    try {
      const gasHex = (await this.rpc("eth_estimateGas", [{ from: this.account.address, to: this.cfg.batch, data }])) as Hex;
      return { ok: true, gas: BigInt(gasHex) };
    } catch (e) {
      const bytes = revertBytes(e);
      if (bytes) {
        try {
          const d = decodeErrorResult({ abi: BATCH_ABI, data: bytes });
          return { ok: false, error: `${d.errorName}(${(d.args ?? []).map(String).join(",")})` };
        } catch {
          /* fall through */
        }
      }
      return { ok: false, error: (e as Error).message };
    }
  }

  // ------------------------------------------------------------ settlement

  async refresh(): Promise<void> {
    const [nonceHex, gasPriceHex] = (await Promise.all([
      this.rpc("eth_getTransactionCount", [this.account.address, "pending"]),
      this.rpc("eth_gasPrice", []),
    ])) as [Hex, Hex];
    this.nonce = parseInt(nonceHex, 16);
    this.maxFeePerGas = BigInt(gasPriceHex) * 2n;
    this.nonceLoaded = true;
  }

  async settle(orders: Order[], signatures: Hex[], prices: Price[], interactions: Interaction[], gas: bigint): Promise<Hex> {
    if (!this.nonceLoaded) await this.refresh();
    const data = encodeFunctionData({ abi: BATCH_ABI, functionName: "settle", args: [orders, signatures, prices, interactions] });
    const raw = await this.account.signTransaction({
      chainId: this.cfg.chainId,
      to: this.cfg.batch,
      data,
      gas: (gas * 13n) / 10n,
      maxFeePerGas: this.maxFeePerGas,
      maxPriorityFeePerGas: 0n,
      nonce: this.nonce++,
      type: "eip1559",
    });
    try {
      return (await sendRawTransaction(raw, {
        onFallback: (r) => console.warn(`batcher | private send hop unavailable (${r}) — next private hop`),
      })) as Hex;
    } catch (e) {
      // A nonce we could not use is a nonce we must reload.
      this.nonceLoaded = false;
      throw e;
    }
  }

  /** Blocks are 100 ms; a settlement is usually visible within a few. */
  async receipt(txHash: Hex, timeoutMs = 15_000): Promise<{ status: boolean; gasUsed: bigint } | null> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const r = (await this.rpc("eth_getTransactionReceipt", [txHash]).catch(() => null)) as { status?: Hex; gasUsed?: Hex } | null;
      if (r && r.status !== undefined) return { status: r.status === "0x1", gasUsed: BigInt(r.gasUsed ?? "0x0") };
      await new Promise((res) => setTimeout(res, 150));
    }
    return null;
  }

  async balance(): Promise<bigint> {
    return BigInt((await this.rpc("eth_getBalance", [this.account.address, "latest"])) as Hex);
  }
}

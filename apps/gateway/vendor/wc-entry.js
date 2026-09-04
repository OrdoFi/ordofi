/**
 * WalletConnect, bundled and served from our own origin.
 *
 * The swap page is one HTML string with no build step, which is why it has no
 * dependencies — but a phone browser has no injected wallet, and the only way
 * to reach the wallet app from Safari is WalletConnect's relay. That is a real
 * dependency, and it signs transactions, so it is built from a pinned version
 * and served from rpc.ordofi.network rather than pulled off a public CDN at
 * the moment a user is about to spend money.
 *
 * It is loaded on demand — nothing here is fetched until someone opens the
 * wallet sheet — so the page stays as fast as it was for everyone with an
 * extension.
 *
 * Build: npm run build:wc
 */
export { EthereumProvider } from "@walletconnect/ethereum-provider";
export { default as qrcode } from "qrcode-generator";

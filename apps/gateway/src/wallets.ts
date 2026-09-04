/**
 * How a phone reaches its wallet.
 *
 * On a desktop the wallet is in the page: an extension injects a provider and
 * a click on "swap" opens a window over the tab. On a phone in Safari there is
 * no extension and no provider — the wallet is a separate app — so the page
 * talks to it over WalletConnect's relay and moves the user between the two
 * apps with links.
 *
 * Two links per wallet, and the difference matters:
 *
 *   pair — a universal link (https://), used once, carrying the pairing URI.
 *          It has to be a universal link because the wallet may not be
 *          installed, and then the phone should offer to install it rather
 *          than show "cannot open page".
 *   open — a custom scheme (metamask://), used every time after that, to bring
 *          the wallet forward for a request the relay has already delivered.
 *          A scheme is right here precisely because it fails silently: the
 *          wallet is known to be installed by now, and if the phone disagrees
 *          we would rather nothing happen than send someone to a website in
 *          the middle of signing a transaction.
 *
 * No logos are fetched. A connect sheet that hangs on a third-party image host
 * is worse than one with a coloured tile, and the wallet's name is what people
 * actually read.
 */

export interface MobileWallet {
  id: string;
  name: string;
  /** Universal link that hands the wallet a fresh pairing URI. `{uri}` is replaced, URI-encoded. */
  pair: string;
  /** Scheme that brings the wallet forward for a request it already has. */
  open: string;
  /** Brand colour for the tile, and the letter to put on it. */
  color: string;
  mark: string;
}

export const MOBILE_WALLETS: MobileWallet[] = [
  { id: "metamask", name: "MetaMask", pair: "https://metamask.app.link/wc?uri={uri}", open: "metamask://", color: "#f6851b", mark: "M" },
  { id: "rainbow", name: "Rainbow", pair: "https://rnbwapp.com/wc?uri={uri}", open: "rainbow://", color: "#174299", mark: "R" },
  { id: "trust", name: "Trust Wallet", pair: "https://link.trustwallet.com/wc?uri={uri}", open: "trust://", color: "#0500ff", mark: "T" },
  { id: "coinbase", name: "Coinbase Wallet", pair: "https://go.cb-w.com/wc?uri={uri}", open: "cbwallet://", color: "#0052ff", mark: "C" },
  { id: "phantom", name: "Phantom", pair: "https://phantom.app/ul/wc?uri={uri}", open: "phantom://", color: "#8f7df2", mark: "P" },
  { id: "zerion", name: "Zerion", pair: "https://wallet.zerion.io/wc?uri={uri}", open: "zerion://", color: "#2962ef", mark: "Z" },
];

/**
 * The methods that put something on the wallet's screen, and so are the ones
 * worth switching apps for. A read the relay answers without asking the user —
 * eth_chainId, eth_accounts — must not throw the phone into another app; doing
 * that on every poll would make the page unusable.
 */
export const HANDOFF_METHODS = [
  "eth_sendTransaction",
  "eth_signTransaction",
  "eth_sign",
  "personal_sign",
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
] as const;

/** The link that hands `uri` to `w`. The page builds this too; this is the definition. */
export function pairingLink(w: MobileWallet, uri: string): string {
  return w.pair.replace("{uri}", encodeURIComponent(uri));
}

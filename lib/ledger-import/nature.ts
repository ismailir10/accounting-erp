/**
 * A file account's balance against the side of the Buku account it is mapped to. A balance is debit-positive (as the import plan
 * stores it); an account has a normal side. The balance is "against nature" when it sits on the other side: a credit balance in an
 * asset, a debit balance in a liability. Said as a hint while mapping, not refused: contra accounts and real reversals exist.
 */
export type NormalSide = "DEBIT" | "CREDIT";

/** The side the balance sits on when that is not the account's normal side; null when it agrees, or the balance is zero. */
export function againstNature(balance: bigint, normal: NormalSide): "debit" | "kredit" | null {
  if (balance > 0n && normal === "CREDIT") return "debit";
  if (balance < 0n && normal === "DEBIT") return "kredit";
  return null;
}

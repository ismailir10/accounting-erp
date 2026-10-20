/**
 * Currency registry + exact rate math (ADR 0006, accounting-rules §6/6b).
 * Amounts are bigint minor units of their currency; rates are decimal strings ("1.31", "11245.5").
 * No floating point anywhere: a rate is parsed into (integer numerator, decimal scale).
 */

export const CURRENCIES = {
  IDR: { exponent: 0, name: "Rupiah", symbol: "Rp" },
  USD: { exponent: 2, name: "Dolar AS", symbol: "US$" },
  SGD: { exponent: 2, name: "Dolar Singapura", symbol: "S$" },
  JPY: { exponent: 0, name: "Yen Jepang", symbol: "¥" },
  EUR: { exponent: 2, name: "Euro", symbol: "€" },
  AUD: { exponent: 2, name: "Dolar Australia", symbol: "A$" },
  CNY: { exponent: 2, name: "Yuan Tiongkok", symbol: "CN¥" },
  HKD: { exponent: 2, name: "Dolar Hong Kong", symbol: "HK$" },
  MYR: { exponent: 2, name: "Ringgit Malaysia", symbol: "RM" },
  GBP: { exponent: 2, name: "Pound Sterling", symbol: "£" },
} as const;

export type CurrencyCode = keyof typeof CURRENCIES;
export const CURRENCY_CODES = Object.keys(CURRENCIES) as CurrencyCode[];
export const PRESENTATION_CURRENCY: CurrencyCode = "IDR";

export function isCurrency(code: string | null | undefined): code is CurrencyCode {
  return !!code && Object.prototype.hasOwnProperty.call(CURRENCIES, code);
}

/** "Rupiah", "Dolar Singapura": how a report header names the currency its amounts are in. */
export const currencyName = (code: string) => CURRENCIES[code as keyof typeof CURRENCIES]?.name ?? code;

export function exponentOf(code: string): number {
  if (!isCurrency(code)) throw new Error(`Mata uang ${code} belum didukung`);
  return CURRENCIES[code].exponent;
}

export type ParsedRate = { num: bigint; scale: number };

/** Parse a positive decimal rate. Accepts "1.31", "11245.50", "11,245.50" (comma thousands) — never a float. */
export function parseRate(input: string): ParsedRate {
  const s = input.trim().replace(/\s/g, "");
  let t = s;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, "");
  else if (/^\d+,\d+$/.test(t)) t = t.replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`Kurs tidak valid: "${input}"`);
  const [int, frac = ""] = t.split(".");
  const num = BigInt(int + frac);
  if (num === 0n) throw new Error(`Kurs tidak boleh nol: "${input}"`);
  return { num, scale: frac.length };
}

/** Canonical decimal string of a rate ("1.3100" → "1.31"). */
export function formatRate(rate: ParsedRate | string): string {
  const r = typeof rate === "string" ? parseRate(rate) : rate;
  const digits = r.num.toString().padStart(r.scale + 1, "0");
  if (r.scale === 0) return digits;
  const int = digits.slice(0, digits.length - r.scale);
  const frac = digits.slice(digits.length - r.scale).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

/** Integer division rounding half away from zero. */
export function divRound(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error("divRound: pembagi harus positif");
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice >= d) return n < 0n ? q - 1n : q + 1n;
  return q;
}

/**
 * Convert minor units of `from` into minor units of `to` at `rate` (= units of `to` per 1 unit of `from`).
 * Rounded half away from zero to the target's minor unit.
 */
export function convertMinor(amount: bigint, from: string, to: string, rate: string | ParsedRate): bigint {
  const r = typeof rate === "string" ? parseRate(rate) : rate;
  const eFrom = exponentOf(from);
  const eTo = exponentOf(to);
  // amount / 10^eFrom * (num / 10^scale) * 10^eTo
  const numer = amount * r.num * 10n ** BigInt(eTo);
  const denom = 10n ** BigInt(r.scale + eFrom);
  return divRound(numer, denom);
}

/**
 * Inverse of a rate as a decimal string with `significant` significant digits (for quoting IDR per SGD vs SGD per IDR). Fixed decimals
 * lost cents: 1/15.873 at 10 decimals is 0,0000630001, so Rp 10 miliar became USD 630.001,00 instead of 630.000,63.
 */
export function invertRate(rate: string, significant = 18): string {
  const r = parseRate(rate);
  // 1 / (num / 10^scale) has about (digits of num − scale) zeros after the point; keep `significant` digits beyond them.
  const digits = Math.max(10, r.num.toString().length - r.scale + significant);
  const q = divRound(10n ** BigInt(r.scale + digits), r.num);
  return formatRate({ num: q, scale: digits });
}

/** Display a rate id-ID style without floats: "12250.5" → "12.250,5", "1.31" → "1,31". */
export function formatRateId(rate: string): string {
  const canonical = formatRate(rate);
  const [int, frac] = canonical.split(".");
  const grouped = new Intl.NumberFormat("id-ID").format(BigInt(int));
  return frac ? `${grouped},${frac}` : grouped;
}

/**
 * Plausible IDR per 1 unit of a currency, deliberately wide (2015–2030 swings with room). Only used to settle "105.234": thousands
 * (105234) or decimal (105,234)? Whichever reading falls inside the band wins.
 */
const IDR_BAND: Record<string, [number, number]> = {
  USD: [3000, 60000], SGD: [3000, 60000], EUR: [3000, 80000], GBP: [3000, 90000], AUD: [2000, 50000],
  CNY: [500, 10000], HKD: [500, 10000], MYR: [500, 20000], JPY: [20, 1000],
};

/**
 * Typed-in rate → canonical decimal ("12.250,50" → "12250.50", "12.250" → "12250", "1,31" → "1.31", "1.31" → "1.31").
 * Both separators: the last one is the decimal. One kind only: 3-digit groups look like thousands, anything else is the decimal.
 * `pair` settles the look-alike: a rate between two foreign currencies is never in the thousands ("1.085" is 1,085), a group led by
 * "0" is a fraction ("0.745"), and against Rupiah the reading that lands in a plausible IDR range wins (JPY→IDR "105.234" is
 * 105,234 not 105234; USD→IDR "16.250" stays 16250).
 */
export function normalizeRateInput(input: string, pair?: { currency: string; quote: string }): string {
  const s = input.trim().replace(/\s/g, "");
  const dot = s.lastIndexOf(".");
  const comma = s.lastIndexOf(",");
  if (dot >= 0 && comma >= 0) {
    const dec = dot > comma ? "." : ",";
    const thou = dec === "." ? "," : ".";
    return s.split(thou).join("").replace(dec, ".");
  }
  const sep = dot >= 0 ? "." : comma >= 0 ? "," : null;
  if (!sep) return s;
  const looksThousands = new RegExp(`^\\d{1,3}(\\${sep}\\d{3})+$`).test(s);
  const thousands = s.split(sep).join("");
  const decimal = s.replace(sep, ".");
  if (!looksThousands || s.startsWith("0")) return decimal;
  if (!pair) return thousands;
  if (pair.currency !== "IDR" && pair.quote !== "IDR") return s.split(sep).length > 2 ? thousands : decimal;
  const base = pair.quote === "IDR" ? pair.currency : pair.quote;
  const band = IDR_BAND[base];
  if (!band) return thousands;
  const inBand = (n: number) => (pair.quote === "IDR" ? n >= band[0] && n <= band[1] : n >= 1 / band[1] && n <= 1 / band[0]);
  const asThousands = inBand(Number(thousands));
  const asDecimal = inBand(Number(decimal));
  return asDecimal && !asThousands ? decimal : thousands;
}

/**
 * A rate cell of a ledger file read as text. Both separators: the last is the decimal ("15.750,50" → "15750.50"). A lone comma
 * followed by exactly three digits is a thousands group ("15,750"), any other lone comma a decimal ("1,31"); a lone dot stays the
 * decimal point, as these files always had it ("1.31", "1.085").
 */
export function normalizeLedgerRate(input: string): string {
  const s = input.trim().replace(/\s/g, "");
  const dot = s.lastIndexOf(".");
  const comma = s.lastIndexOf(",");
  if (dot >= 0 && comma >= 0) return normalizeRateInput(s);
  if (comma >= 0) return /^\d{1,3}(,\d{3})+$/.test(s) ? s.split(",").join("") : s.replace(",", ".");
  return s;
}

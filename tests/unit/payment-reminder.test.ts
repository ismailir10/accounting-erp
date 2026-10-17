import { describe, expect, it } from "vitest";
import { paymentReminder, reminderDate, type ReminderLine } from "@/lib/receivables/reminder";
import { dateOnly } from "@/lib/format";

const line = (number: string, due: number, amount: bigint, days: number): ReminderLine => ({ number, issueDate: dateOnly(2026, 7, 1), dueDate: dateOnly(2026, 8, due), amount, daysPastDue: days });

describe("pengingat tagihan text (cycle 2026-10-17-pengingat-piutang)", () => {
  it("lists each overdue invoice with its days late, their sum, and signs with the company", () => {
    const text = paymentReminder({ company: "PT Piutang Uji", customer: "PT Mitra Unggas", asOf: dateOnly(2026, 8, 31), currency: "IDR", overdue: [line("INV-100", 1, 5_550_000n, 30), line("INV-101", 21, 1_000_000n, 10)], advance: 0n });
    expect(text).toBe(
      [
        "Yth. PT Mitra Unggas,",
        "",
        "Menurut catatan kami per 31 Agu 2026, 2 faktur berikut sudah lewat jatuh tempo:",
        "1. INV-100 (tgl. 1 Jul 2026, jatuh tempo 1 Agu 2026): Rp 5.550.000, terlambat 30 hari",
        "2. INV-101 (tgl. 1 Jul 2026, jatuh tempo 21 Agu 2026): Rp 1.000.000, terlambat 10 hari",
        "Jumlah: Rp 6.550.000",
        "",
        "Mohon pembayarannya dapat segera dilakukan. Bila pembayaran sudah dilakukan setelah 31 Agu 2026, mohon abaikan pesan ini.",
        "",
        "Terima kasih.",
        "",
        "Hormat kami,",
        "PT Piutang Uji",
      ].join("\n"),
    );
  });

  it("asks what an unallocated advance is for, lists the oldest 15 and points to the statement for the rest", () => {
    const overdue = Array.from({ length: 17 }, (_, i) => line(`N-${i + 1}`, 1, 100_000n, 30));
    const text = paymentReminder({ company: "CV Dagang", customer: "Toko Sejahtera", asOf: dateOnly(2026, 8, 31), currency: "IDR", overdue, advance: 250_000n })!;
    expect(text).toContain("17 faktur berikut sudah lewat jatuh tempo:");
    expect(text).toContain("15. N-15 ");
    expect(text).not.toContain("N-16 ");
    expect(text).toContain("… dan 2 faktur lain sebesar Rp 200.000; rinciannya ada di surat tagihan terlampir.");
    expect(text).toContain("Jumlah: Rp 1.700.000");
    expect(text).toContain("Kami juga mencatat pembayaran Rp 250.000 dari Bapak/Ibu yang belum dialokasikan ke faktur. Mohon informasikan faktur mana yang dibayar dengan dana tersebut.");
    expect(text.endsWith("Hormat kami,\nCV Dagang")).toBe(true);
  });

  it("returns null when nothing is overdue, and writes another currency in its own unit", () => {
    expect(paymentReminder({ company: "PT A", customer: "B", asOf: dateOnly(2026, 8, 31), currency: "IDR", overdue: [], advance: 5n })).toBeNull();
    expect(paymentReminder({ company: "PT A", customer: "B", asOf: dateOnly(2026, 8, 31), currency: "USD", overdue: [line("U-1", 1, 12_345n, 30)], advance: 0n })).toContain("US$ 123,45");
  });

  it("dates the reminder at the month end, or today (WIB) while the month runs", () => {
    const end = dateOnly(2026, 10, 31);
    expect(reminderDate(end, new Date("2026-10-17T03:00:00Z"))).toEqual(dateOnly(2026, 10, 17));
    expect(reminderDate(end, new Date("2026-10-17T18:00:00Z"))).toEqual(dateOnly(2026, 10, 18)); // already the 18th in Jakarta
    expect(reminderDate(dateOnly(2026, 8, 31), new Date("2026-10-17T03:00:00Z"))).toEqual(dateOnly(2026, 8, 31));
  });
});

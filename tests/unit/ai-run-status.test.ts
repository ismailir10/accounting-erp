import { describe, expect, it } from "vitest";
import { aiRunStatusText } from "@/lib/ai/run-status";
import type { AiRunView } from "@/lib/ai/run";

const run = (over: Partial<AiRunView>): AiRunView => ({ id: "r1", status: "RUNNING", totalLines: 150, askedLines: 45, suggestedLines: 0, note: null, ...over });

describe("Saran AI status text", () => {
  it("shows progress while running", () => {
    expect(aiRunStatusText(run({}))).toEqual({ state: "running", value: "diproses · 45 dari 150 transaksi", note: null });
  });

  it("formats counts id-ID and never shows more asked than total", () => {
    expect(aiRunStatusText(run({ totalLines: 1200, askedLines: 1300 })).value).toBe("diproses · 1.200 dari 1.200 transaksi");
  });

  it("counts suggestions and the lines left on a simple guess when done", () => {
    expect(aiRunStatusText(run({ status: "DONE", askedLines: 150, suggestedLines: 132 }))).toEqual({ state: "done", value: "selesai · 132 saran · 18 tetap tebakan sederhana", note: null });
    expect(aiRunStatusText(run({ status: "DONE", askedLines: 150, suggestedLines: 150 })).value).toBe("selesai · 150 saran");
  });

  it("keeps the run's note under a partial result", () => {
    const note = "Kuota AI bulan ini habis.";
    expect(aiRunStatusText(run({ status: "DONE", suggestedLines: 40, note })).note).toBe(note);
  });

  it("says only the reason when it stopped without a suggestion", () => {
    expect(aiRunStatusText(run({ status: "DONE", note: "AI belum diatur" }))).toEqual({ state: "stopped", value: "tidak ada saran baru", note: "AI belum diatur" });
  });

  it("says there is nothing new when it finished without a suggestion or a note", () => {
    expect(aiRunStatusText(run({ status: "DONE", askedLines: 150 }))).toEqual({ state: "done", value: "selesai · tidak ada saran baru", note: null });
  });
});

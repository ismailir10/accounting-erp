// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagementNoteCard, type ManagementNoteProps } from "@/components/app/management-note";
import { draftCommentaryAction, saveReportCommentAction } from "@/app/actions";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/actions", () => ({
  clearReportCommentAction: vi.fn(),
  draftCommentaryAction: vi.fn(),
  saveReportCommentAction: vi.fn(),
}));

const august: ManagementNoteProps = {
  clientId: "client-demo", entityId: "entity-demo", year: 2026, month: 8,
  periodLabel: "Agustus 2026", facts: ["Catatan otomatis Agustus."], note: null, aiReady: true,
};
const editorLabel = "Catatan untuk laporan manajemen";

afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("management note report scope", () => {
  it.each([
    { month: 9, periodLabel: "September 2026" },
    { year: 2027 },
    { entityId: "entity-other" },
    { clientId: "client-other" },
  ])("discards the previous report's draft when scope changes to %j", async (change) => {
    vi.mocked(saveReportCommentAction).mockResolvedValue({ ok: true, foreign: [] });
    const view = render(createElement(ManagementNoteCard, august));
    fireEvent.click(view.getByRole("button", { name: "Tulis sendiri" }));
    fireEvent.change(view.getByLabelText(editorLabel), { target: { value: "Draf khusus Agustus." } });

    const next = { ...august, ...change, facts: ["Catatan otomatis laporan baru."] };
    view.rerender(createElement(ManagementNoteCard, next));
    expect(view.queryByLabelText(editorLabel)).toBeNull();
    expect(view.queryByRole("button", { name: "Pakai catatan ini" })).toBeNull();
    expect(saveReportCommentAction).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("button", { name: "Tulis sendiri" }));
    expect(view.getByLabelText(editorLabel)).toHaveProperty("value", "Catatan otomatis laporan baru.");
    fireEvent.click(view.getByRole("button", { name: "Pakai catatan ini" }));
    await waitFor(() => expect(saveReportCommentAction).toHaveBeenCalledWith({
      clientId: next.clientId, entityId: next.entityId, year: next.year, month: next.month,
      text: "Catatan otomatis laporan baru.", source: "ACCOUNTANT",
    }));
  });

  it("keeps an unsaved edit when the same report refreshes", () => {
    const view = render(createElement(ManagementNoteCard, august));
    fireEvent.click(view.getByRole("button", { name: "Tulis sendiri" }));
    fireEvent.change(view.getByLabelText(editorLabel), { target: { value: "Catatan sedang ditulis." } });
    view.rerender(createElement(ManagementNoteCard, { ...august, facts: ["Kalimat terbaru."] }));
    expect(view.getByLabelText(editorLabel)).toHaveProperty("value", "Catatan sedang ditulis.");
  });

  it("returns to the saved note after leaving a dirty report, without restoring its discarded draft", () => {
    const saved = { ...august, note: { text: "Catatan Agustus yang disetujui.", source: "ACCOUNTANT" as const, approved: "Akuntan", stale: false } };
    const view = render(createElement(ManagementNoteCard, saved));
    fireEvent.click(view.getByRole("button", { name: "Tulis sendiri" }));
    fireEvent.change(view.getByLabelText(editorLabel), { target: { value: "Perubahan belum disetujui." } });
    view.rerender(createElement(ManagementNoteCard, { ...august, month: 9, periodLabel: "September 2026" }));
    view.rerender(createElement(ManagementNoteCard, saved));
    expect(view.queryByLabelText(editorLabel)).toBeNull();
    expect(view.getByTestId("management-note-approved").textContent).toContain(saved.note.text);
    fireEvent.click(view.getByRole("button", { name: "Tulis sendiri" }));
    expect(view.getByLabelText(editorLabel)).toHaveProperty("value", saved.note.text);
    expect(saveReportCommentAction).not.toHaveBeenCalled();
  });

  it("does not overwrite a new draft when an old AI request finishes after leaving and returning", async () => {
    let finish!: (result: Awaited<ReturnType<typeof draftCommentaryAction>>) => void;
    vi.mocked(draftCommentaryAction).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const view = render(createElement(ManagementNoteCard, august));
    fireEvent.click(view.getByRole("button", { name: "Susun dengan AI" }));
    view.rerender(createElement(ManagementNoteCard, { ...august, month: 9 }));
    view.rerender(createElement(ManagementNoteCard, august));
    fireEvent.click(view.getByRole("button", { name: "Tulis sendiri" }));
    fireEvent.change(view.getByLabelText(editorLabel), { target: { value: "Draf baru setelah kembali." } });
    await act(async () => { finish({ ok: true, text: "Draf AI dari editor lama.", foreign: [] }); });
    expect(view.getByLabelText(editorLabel)).toHaveProperty("value", "Draf baru setelah kembali.");
    expect(saveReportCommentAction).not.toHaveBeenCalled();
  });

  it("keeps the original save target and preserves a new draft when an earlier save completes", async () => {
    let finish!: (result: Awaited<ReturnType<typeof saveReportCommentAction>>) => void;
    vi.mocked(saveReportCommentAction).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const view = render(createElement(ManagementNoteCard, august));
    fireEvent.click(view.getByRole("button", { name: "Tulis sendiri" }));
    fireEvent.click(view.getByRole("button", { name: "Pakai catatan ini" }));
    expect(saveReportCommentAction).toHaveBeenCalledWith({
      clientId: august.clientId, entityId: august.entityId, year: august.year, month: august.month,
      text: august.facts[0], source: "ACCOUNTANT",
    });
    view.rerender(createElement(ManagementNoteCard, { ...august, month: 9 }));
    view.rerender(createElement(ManagementNoteCard, august));
    fireEvent.click(view.getByRole("button", { name: "Tulis sendiri" }));
    fireEvent.change(view.getByLabelText(editorLabel), { target: { value: "Perubahan setelah kembali." } });
    await act(async () => { finish({ ok: true, foreign: [] }); });
    expect(view.getByLabelText(editorLabel)).toHaveProperty("value", "Perubahan setelah kembali.");
    expect(saveReportCommentAction).toHaveBeenCalledTimes(1);
  });

  it("preserves the new report's edit when the previous AI request returns an error", async () => {
    let finish!: (result: Awaited<ReturnType<typeof draftCommentaryAction>>) => void;
    vi.mocked(draftCommentaryAction).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const view = render(createElement(ManagementNoteCard, august));
    fireEvent.click(view.getByRole("button", { name: "Susun dengan AI" }));
    view.rerender(createElement(ManagementNoteCard, { ...august, month: 9 }));
    fireEvent.click(view.getByRole("button", { name: "Tulis sendiri" }));
    fireEvent.change(view.getByLabelText(editorLabel), { target: { value: "Draf September." } });
    await act(async () => { finish({ ok: false, error: "AI tidak tersedia." }); });
    expect(view.getByLabelText(editorLabel)).toHaveProperty("value", "Draf September.");
    expect(view.getByRole("button", { name: "Pakai catatan ini" })).toHaveProperty("disabled", false);
    expect(saveReportCommentAction).not.toHaveBeenCalled();
  });

  it("ignores an AI draft that finishes after switching reports", async () => {
    let finish!: (result: Awaited<ReturnType<typeof draftCommentaryAction>>) => void;
    vi.mocked(draftCommentaryAction).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const view = render(createElement(ManagementNoteCard, august));
    fireEvent.click(view.getByRole("button", { name: "Susun dengan AI" }));
    expect(view.getByRole("button", { name: "Menyusun…" })).toHaveProperty("disabled", true);

    view.rerender(createElement(ManagementNoteCard, { ...august, month: 9, periodLabel: "September 2026" }));
    expect(view.getByRole("button", { name: "Susun dengan AI" })).toHaveProperty("disabled", false);
    await act(async () => { finish({ ok: true, text: "Draf AI Agustus.", foreign: [] }); });
    expect(view.queryByLabelText(editorLabel)).toBeNull();
    expect(saveReportCommentAction).not.toHaveBeenCalled();
  });
});

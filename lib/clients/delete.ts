import type { Db } from "@/lib/db";
import { COMPANY_NO_DELETE } from "@/lib/org";

export class DeleteClientError extends Error {}

/**
 * Remove a client and everything that is its books (admin only, typed confirmation — the caller checks the role).
 * This is not a ledger correction (rule 3 still holds for books that stay): it removes a client entered by mistake or a
 * test copy, all or nothing in one transaction (leases, employee benefits included). Firm-level rules, exchange rates and the AI caches stay (they hold names
 * and codes only, keyed per client). Order follows the foreign keys: leaves first.
 */
export async function deleteClient(db: Db, input: { firmId: string; clientId: string; confirmName: string }) {
  const client = await db.client.findFirst({ where: { id: input.clientId, firmId: input.firmId }, select: { id: true, name: true } });
  if (!client) throw new DeleteClientError("Klien tidak ditemukan.");
  // A company's one client is its books (ADR 0017 §1): removing it would leave an organisation without books.
  if ((await db.firm.findUniqueOrThrow({ where: { id: input.firmId }, select: { kind: true } })).kind === "PERUSAHAAN") throw new DeleteClientError(COMPANY_NO_DELETE);
  if (input.confirmName.trim() !== client.name) throw new DeleteClientError(`Ketik nama klien persis "${client.name}" untuk menghapusnya.`);

  return db.$transaction(
    async (tx) => {
      // The ledger guards refuse deleting journals in a closed month (accounting-rules 4); removing a whole client is the one
      // exception, allowed for this transaction only.
      await tx.$executeRaw`SELECT set_config('buku.client_delete', 'on', true)`;
      const clientId = client.id;
      const entityIds = (await tx.entity.findMany({ where: { clientId }, select: { id: true } })).map((e) => e.id);
      const bankIds = (await tx.bankAccount.findMany({ where: { entityId: { in: entityIds } }, select: { id: true } })).map((b) => b.id);
      const periodIds = (await tx.period.findMany({ where: { clientId }, select: { id: true } })).map((p) => p.id);
      const taxYearIds = (await tx.taxYear.findMany({ where: { clientId }, select: { id: true } })).map((t) => t.id);
      const intakeIds = (await tx.evidenceIntake.findMany({ where: { clientId }, select: { id: true } })).map((i) => i.id);
      const byEntity = { entityId: { in: entityIds } };

      await tx.controlAck.deleteMany({ where: { periodId: { in: periodIds } } });
      await tx.closeSignoff.deleteMany({ where: { periodId: { in: periodIds } } });
      await tx.checklistMark.deleteMany({ where: { task: { clientId } } }); // Checklist tutup buku: the month marks, then the template
      await tx.checklistTask.deleteMany({ where: { clientId } });
      await tx.journalApproval.deleteMany({ where: { clientId } }); // Persetujuan kedua: points at drafts and entries
      await tx.reopenRequest.deleteMany({ where: { clientId } });
      await tx.proposedEntry.deleteMany({ where: { clientId } });
      await tx.withholdingSlip.deleteMany({ where: { clientId } }); // points at bank lines and contacts
      await tx.invoiceSettlement.deleteMany({ where: { invoice: { clientId } } });
      await tx.invoice.deleteMany({ where: { clientId } });
      await tx.contact.deleteMany({ where: { clientId } });
      await tx.taxPosting.deleteMany({ where: { taxYearId: { in: taxYearIds } } });
      await tx.taxCredit.deleteMany({ where: { taxYearId: { in: taxYearIds } } });
      await tx.fiscalCorrection.deleteMany({ where: { taxYearId: { in: taxYearIds } } });
      await tx.taxLossCarryforward.deleteMany({ where: { taxYearId: { in: taxYearIds } } });
      await tx.taxYear.deleteMany({ where: { clientId } });
      await tx.inventoryCount.deleteMany({ where: { clientId } });
      await tx.fixedAsset.deleteMany({ where: { clientId } });
      await tx.leasePosting.deleteMany({ where: { lease: { clientId } } });
      await tx.lease.deleteMany({ where: { clientId } });
      await tx.benefitPosting.deleteMany({ where: byEntity });
      await tx.employee.deleteMany({ where: byEntity });
      await tx.benefitSetting.deleteMany({ where: byEntity });
      // Schedules and entries point at each other (a schedule's source line; installments' scheduleId): release the source
      // line on both columns at once (a CHECK keeps them paired), then entries, then schedules.
      await tx.adjustmentSchedule.updateMany({ where: { clientId }, data: { sourceEntryId: null, sourceAccountId: null } });
      await tx.subledgerImport.deleteMany({ where: { clientId } }); // its rows cascade; it points at its Temuan
      await tx.finding.deleteMany({ where: { clientId } }); // points at the entries that raised and resolved it
      await tx.journalEntry.updateMany({ where: { ...byEntity, reversesId: { not: null } }, data: { reversesId: null } }); // self-reference first
      await tx.journalEntry.deleteMany({ where: byEntity }); // lines cascade
      await tx.adjustmentSchedule.deleteMany({ where: { clientId } });
      await tx.recurringJournal.deleteMany({ where: { clientId } }); // Jurnal berulang: its entries and requests went above
      await tx.ckpnSetting.deleteMany({ where: byEntity });
      await tx.bankTransaction.deleteMany({ where: { bankAccountId: { in: bankIds } } });
      await tx.statementImport.deleteMany({ where: { bankAccountId: { in: bankIds } } });
      await tx.dimension.deleteMany({ where: { clientId } }); // Departemen & Proyek: after the lines and bank lines that carry them
      await tx.bankAccount.deleteMany({ where: { id: { in: bankIds } } });
      await tx.sourceAccount.deleteMany({ where: { clientId } });
      await tx.ledgerImport.deleteMany({ where: { clientId } }); // checks cascade
      await tx.memory.deleteMany({ where: { clientId } });
      await tx.rule.deleteMany({ where: { clientId } }); // its instruction rules too, before the instructions they point at
      await tx.instruction.deleteMany({ where: { clientId } }); // Instruksi kantor for this client; *Semua klien* ones stay
      await tx.uploadLink.deleteMany({ where: { clientId } });
      await tx.evidenceSelection.deleteMany({ where: { intakeId: { in: intakeIds } } });
      await tx.evidenceUpload.deleteMany({ where: { intakeId: { in: intakeIds } } });
      await tx.evidenceIntake.deleteMany({ where: { id: { in: intakeIds } } }); // documents, versions, passages, facts, conflicts, messages cascade
      await tx.evidenceAiCache.deleteMany({ where: { firmId: input.firmId, scope: { startsWith: `close:${clientId}:` } } });
      await tx.evidenceAiCache.deleteMany({ where: { firmId: input.firmId, scope: { startsWith: `flux:${clientId}:` } } }); // drafts quote ledger memos
      await tx.auditEvent.deleteMany({ where: { clientId } });
      await tx.reportFormat.deleteMany({ where: { clientId } });
      await tx.reportComment.deleteMany({ where: { clientId } });
      await tx.fluxExplanation.deleteMany({ where: { clientId } });
      await tx.ocrDraft.deleteMany({ where: { clientId } });
      await tx.coretaxFaktur.deleteMany({ where: { clientId } });
      await tx.coretaxBupot.deleteMany({ where: { clientId } });
      await tx.taxInstalment.deleteMany({ where: { clientId } });
      await tx.budget.deleteMany({ where: { clientId } });
      await tx.periodUnlockLog.deleteMany({ where: { clientId } });
      await tx.period.deleteMany({ where: { clientId } });
      await tx.account.deleteMany({ where: { clientId } });
      await tx.entity.deleteMany({ where: { clientId } });
      await tx.client.delete({ where: { id: clientId } });
      return { name: client.name, entities: entityIds.length };
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
}

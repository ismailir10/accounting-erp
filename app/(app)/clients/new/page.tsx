import { redirect } from "next/navigation";
import { PageHeader } from "@/components/app/page-header";
import { NewClientStart } from "@/components/app/new-client-from-files";
import { requireWorkspaceSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { companyClient, isCompany } from "@/lib/org";

export const metadata = { title: "Tambah klien" };

/** Starts from the client's files (cycle 2026-10-10-new-client-from-files); `?manual=1` opens the manual form (*Isi manual*). */
export default async function NewClientPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // A company has one set of books (ADR 0017 §1): once it exists, this page leads back to it.
  const { firm } = await requireWorkspaceSession();
  const books = await companyClient(prisma, firm);
  if (books) redirect(`/clients/${books.id}`);
  const company = isCompany(firm);
  const manual = (await searchParams).manual === "1";
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={company ? "Siapkan buku perusahaan" : "Tambah klien"} description={company ? "Perusahaan Anda beserta perusahaan anak atau pemilik, masing-masing dengan pembukuan dan mata uangnya sendiri." : "Satu klien bisa punya beberapa perusahaan, masing-masing dengan pembukuan dan mata uangnya sendiri."} />
      <NewClientStart company={company} manual={manual} />
    </div>
  );
}

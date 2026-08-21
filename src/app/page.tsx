import MigratorApp from "@/components/MigratorApp";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <main className="min-h-screen bg-[radial-gradient(ellipse_at_top,_rgba(56,189,248,0.08),_transparent_55%)]">
      <MigratorApp />
      <footer className="border-t border-slate-800/60 py-6 text-center text-xs text-slate-600">
        MySQL → PostgreSQL data migrator · source database is opened read-only ·
        schema is expected to be managed by Prisma
      </footer>
    </main>
  );
}

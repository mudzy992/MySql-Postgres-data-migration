import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "MySQL → PostgreSQL Data Migrator",
  description:
    "Selectively copy data from a MySQL database into a Prisma-managed PostgreSQL schema, then validate the result.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-950 text-slate-100 antialiased">{children}</body>
    </html>
  );
}

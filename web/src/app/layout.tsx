import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Neural Knowledge Studio — Local Semantic Graph & Agent Memory Platform",
  description: "High-performance Neural Knowledge Base & Agent Memory Studio with shadcn/ui and Next.js",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="vi" className="h-full bg-slate-950 text-slate-100 dark">
      <head>
        <link rel="stylesheet" href="/globals.compiled.css" />
      </head>
      <body className="h-full w-full flex flex-col font-sans antialiased overflow-hidden">
        {children}
      </body>
    </html>
  );
}

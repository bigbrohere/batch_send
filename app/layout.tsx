import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Batch Send",
  description: "Bulk native-token transfer tool",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <meta name="robots" content="noindex, nofollow" />
      </head>
      <body className="font-mono antialiased">{children}</body>
    </html>
  );
}

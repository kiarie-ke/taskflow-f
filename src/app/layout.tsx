import type { Metadata, Viewport } from "next";
import { Bebas_Neue } from "next/font/google";
import "./globals.css";

const bebasNeue = Bebas_Neue({
  subsets: ["latin"],
  weight: "400",
  display: "swap",
  variable: "--font-bebas-neue",
});

export const metadata: Metadata = {
  title: "Taskflow — Your personal task list",
  description: "A calmer way to organize your work and keep moving forward.",
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#1c241b",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body className={`${bebasNeue.variable} antialiased`}>{children}</body>
    </html>
  );
}

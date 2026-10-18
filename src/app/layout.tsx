import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { connection } from "next/server";
import { TooltipProvider } from "@/components/ui/tooltip";
import { siteConfig } from "@/config/site";
import { ToastProvider } from "@/prototype/toast";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: siteConfig.name, template: `%s · ${siteConfig.name}` },
  description: siteConfig.description,
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Render every page per request: the Content-Security-Policy nonce (set in proxy.ts) is applied
  // to Next.js scripts during rendering, which a statically prerendered page can't receive.
  await connection();
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full bg-background text-foreground">
        <ToastProvider>
          <TooltipProvider delay={300}>{children}</TooltipProvider>
        </ToastProvider>
      </body>
    </html>
  );
}

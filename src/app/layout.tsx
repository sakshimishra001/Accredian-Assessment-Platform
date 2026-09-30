import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import { siteConfig } from "@/config/site";
import { PrototypeProvider } from "@/prototype/store";
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

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full bg-background text-foreground">
        {/* Clickable prototype: all state lives in memory and resets on refresh. */}
        <PrototypeProvider>
          <ToastProvider>
            <TooltipProvider delay={300}>{children}</TooltipProvider>
          </ToastProvider>
        </PrototypeProvider>
      </body>
    </html>
  );
}

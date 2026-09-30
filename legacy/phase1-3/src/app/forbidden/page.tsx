import type { Metadata } from "next";
import Link from "next/link";
import { StatusPage } from "@/components/shared/status-page";
import { buttonVariants } from "@/components/ui/button";

export const metadata: Metadata = { title: "Access denied" };

export default function ForbiddenPage() {
  return (
    <StatusPage
      code="403"
      title="Access denied"
      description="Your account does not have permission to view that page."
    >
      <Link href="/" className={buttonVariants()}>
        Go to my dashboard
      </Link>
    </StatusPage>
  );
}

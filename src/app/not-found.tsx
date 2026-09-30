import Link from "next/link";
import { StatusPage } from "@/components/shared/status-page";
import { buttonVariants } from "@/components/ui/button";

export default function NotFound() {
  return (
    <StatusPage code="404" title="Page not found" description="The page you are looking for does not exist.">
      <Link href="/" className={buttonVariants()}>
        Go to dashboard
      </Link>
    </StatusPage>
  );
}

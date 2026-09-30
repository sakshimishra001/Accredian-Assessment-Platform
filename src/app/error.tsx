"use client";

import { useEffect } from "react";
import { StatusPage } from "@/components/shared/status-page";
import { Button } from "@/components/ui/button";

export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <StatusPage
      title="Something went wrong"
      description={
        error.digest
          ? `An unexpected error occurred. If it keeps happening, share this reference with support: ${error.digest}`
          : "An unexpected error occurred. Please try again."
      }
    >
      <Button onClick={() => retry()}>Try again</Button>
    </StatusPage>
  );
}

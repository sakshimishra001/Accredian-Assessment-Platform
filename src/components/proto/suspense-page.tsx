"use client";

import { Suspense, type ComponentType } from "react";
import { Skeleton } from "@/components/ui/skeleton";

export function PageSkeleton() {
  return (
    <div className="grid gap-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-96 max-w-full" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-72" />
    </div>
  );
}

/** Pages that read search params must render inside a Suspense boundary. */
export function withSuspense(Inner: ComponentType) {
  return function SuspensePage() {
    return (
      <Suspense fallback={<PageSkeleton />}>
        <Inner />
      </Suspense>
    );
  };
}

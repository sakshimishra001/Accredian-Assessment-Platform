"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { AuthUser } from "@/lib/auth/ui-role";

const AuthUserContext = createContext<AuthUser | null>(null);

/** Makes the server-verified user available to client components. */
export function AuthSessionProvider({ user, children }: { user: AuthUser; children: ReactNode }) {
  return <AuthUserContext.Provider value={user}>{children}</AuthUserContext.Provider>;
}

/** The signed-in user. Only usable inside a protected area (below AuthSessionProvider). */
export function useAuthUser(): AuthUser {
  const user = useContext(AuthUserContext);
  if (!user) throw new Error("useAuthUser must be used inside AuthSessionProvider");
  return user;
}

import { redirect } from "next/navigation";

/** The old marketing page is retired: sign-in is the entry point. */
export default function Landing() {
  redirect("/login");
}

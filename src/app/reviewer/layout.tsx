/** Old proctor area: every page redirects to /proctor (signed-in proctors only; see PROTECTED_ROUTES). */
export default function ReviewerLayout({ children }: LayoutProps<"/reviewer">) {
  return children;
}

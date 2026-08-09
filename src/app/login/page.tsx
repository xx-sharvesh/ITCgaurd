import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "@/components/LoginForm";

export const metadata: Metadata = {
  title: "Sign in — ITC Guard",
  description: "Sign in to ITC Guard.",
  // A login page has no business in a search index.
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  return (
    <main className="paper flex min-h-dvh items-center justify-center px-6 py-12">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}

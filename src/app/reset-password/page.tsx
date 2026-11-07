"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ResetPasswordForm } from "./reset-password-form";

function ResetPasswordPageContent() {
  const searchParams = useSearchParams();
  return <ResetPasswordForm token={searchParams.get("token") ?? ""} />;
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <main className="utility-page">
          <section className="utility-card">
            <p>Loading password reset...</p>
          </section>
        </main>
      }
    >
      <ResetPasswordPageContent />
    </Suspense>
  );
}

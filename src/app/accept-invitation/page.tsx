"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { AcceptInvitation } from "./accept-invitation";

function InvitationPageContent() {
  const searchParams = useSearchParams();
  return <AcceptInvitation token={searchParams.get("token") ?? ""} />;
}

export default function AcceptInvitationPage() {
  return (
    <Suspense
      fallback={
        <main className="utility-page">
          <section className="utility-card">
            <p>Loading invitation...</p>
          </section>
        </main>
      }
    >
      <InvitationPageContent />
    </Suspense>
  );
}

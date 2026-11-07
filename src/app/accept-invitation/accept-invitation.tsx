"use client";

import Link from "next/link";
import { useState } from "react";

const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000"
).replace(/\/$/, "");

type StoredSession = {
  accessToken: string;
  user?: { id: number };
};

function readSession(): StoredSession | null {
  const raw = window.sessionStorage.getItem("task-api-session");
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "accessToken" in parsed &&
      typeof parsed.accessToken === "string"
    ) {
      return parsed as StoredSession;
    }
    return null;
  } catch {
    return null;
  }
}

export function AcceptInvitation({ token }: { token: string }) {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function accept() {
    if (!token) {
      setError("This invitation link is missing its token.");
      return;
    }
    const session = readSession();
    if (!session) {
      window.sessionStorage.setItem("taskflow-pending-invite", token);
      setMessage("Sign in to accept this invitation. We’ll finish joining your workspace after sign-in.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `${API_BASE_URL}/workspaces/accept-invitation`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.accessToken}`,
          },
          body: JSON.stringify({ token }),
        },
      );
      if (!response.ok) {
        const body: unknown = await response.json();
        const message =
          typeof body === "object" &&
          body !== null &&
          "message" in body &&
          typeof body.message === "string"
            ? body.message
            : "Could not accept this invitation.";
        throw new Error(message);
      }
      window.sessionStorage.removeItem("taskflow-pending-invite");
      setMessage("You joined the workspace. Return to Taskflow to get started.");
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Could not accept this invitation.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="utility-page">
      <section className="utility-card">
        <span className="eyebrow">TEAM WORKSPACE</span>
        <h1>You’re invited.</h1>
        <p>Accept this invitation to collaborate with your team on Taskflow.</p>
        {error && <p className="form-alert" role="alert">{error}</p>}
        {message && <p className="form-success" role="status">{message}</p>}
        <button
          className="button button-primary auth-submit"
          disabled={busy}
          onClick={() => void accept()}
          type="button"
        >
          {busy ? "Joining..." : "Accept invitation"}
        </button>
        <Link className="auth-link" href="/">Go to sign in</Link>
      </section>
    </main>
  );
}

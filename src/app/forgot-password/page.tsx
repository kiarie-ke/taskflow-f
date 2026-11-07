"use client";

import Link from "next/link";
import { useState } from "react";
import type { FormEvent } from "react";

const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000"
).replace(/\/$/, "");

export default function ForgotPasswordPage() {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    const email = String(new FormData(event.currentTarget).get("email") ?? "");
    try {
      const response = await fetch(
        `${API_BASE_URL}/auth/password-reset/request`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        },
      );
      const body: unknown = await response.json();
      if (!response.ok) {
        throw new Error(
          typeof body === "object" &&
            body !== null &&
            "message" in body &&
            typeof body.message === "string"
            ? body.message
            : "Could not request a reset link.",
        );
      }
      setMessage(
        "If an account exists for this email, a password reset link has been sent.",
      );
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Could not request a reset link.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="utility-page">
      <section className="utility-card">
        <span className="eyebrow">ACCOUNT SECURITY</span>
        <h1>Reset your password.</h1>
        <p>Enter your email and we’ll send a time-limited reset link.</p>
        <form className="auth-form" onSubmit={submit}>
          <label className="field">
            <span>Email address</span>
            <input
              autoComplete="email"
              name="email"
              type="email"
              required
              maxLength={254}
            />
          </label>
          {error && <p className="form-alert" role="alert">{error}</p>}
          {message && <p className="form-success" role="status">{message}</p>}
          <button className="button button-primary auth-submit" disabled={busy}>
            {busy ? "Sending..." : "Send reset link"}
          </button>
        </form>
        <Link className="auth-link" href="/">Back to sign in</Link>
      </section>
    </main>
  );
}

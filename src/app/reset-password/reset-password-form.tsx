"use client";

import Link from "next/link";
import { useState } from "react";
import type { FormEvent } from "react";

const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000"
).replace(/\/$/, "");

export function ResetPasswordForm({ token }: { token: string }) {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    const password = String(new FormData(event.currentTarget).get("password") ?? "");
    try {
      const response = await fetch(
        `${API_BASE_URL}/auth/password-reset/confirm`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, password }),
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
            : "Could not reset the password.";
        throw new Error(message);
      }
      setMessage("Your password was updated. Sign in with the new password.");
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Could not reset the password.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="utility-page">
      <section className="utility-card">
        <span className="eyebrow">ACCOUNT SECURITY</span>
        <h1>Choose a new password.</h1>
        <p>Use at least 10 characters. This reset link can only be used once.</p>
        {token ? (
          <form className="auth-form" onSubmit={submit}>
            <label className="field">
              <span>New password</span>
              <input
                autoComplete="new-password"
                name="password"
                type="password"
                minLength={10}
                maxLength={128}
                required
              />
            </label>
            {error && <p className="form-alert" role="alert">{error}</p>}
            {message && <p className="form-success" role="status">{message}</p>}
            <button className="button button-primary auth-submit" disabled={busy}>
              {busy ? "Updating..." : "Update password"}
            </button>
          </form>
        ) : (
          <p className="form-alert" role="alert">
            This reset link is missing its token. Request a new one.
          </p>
        )}
        <Link className="auth-link" href="/">Back to sign in</Link>
      </section>
    </main>
  );
}

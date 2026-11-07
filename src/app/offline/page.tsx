import Link from "next/link";

export default function OfflinePage() {
  return (
    <main className="utility-page">
      <section className="utility-card">
        <span className="eyebrow">OFFLINE MODE</span>
        <h1>You’re still on track.</h1>
        <p>
          Taskflow can show your cached tasks and save changes while you’re
          offline. New data will sync when your connection returns.
        </p>
        <Link className="button button-primary auth-submit" href="/">
          Return to Taskflow
        </Link>
      </section>
    </main>
  );
}

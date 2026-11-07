"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { FormEvent } from "react";
import Link from "next/link";

type UserProfile = {
  id: number;
  username: string;
  email: string;
};

type AuthResponse = {
  accessToken: string;
  user: UserProfile;
};

type Task = {
  id: number;
  title: string;
  description?: string;
  completed: boolean;
  ownerId: number;
};

type TaskFilter = "all" | "active" | "completed";

class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000"
).replace(/\/$/, "");
const SESSION_KEY = "task-api-session";
let sessionSnapshot: AuthResponse | null = null;
let sessionLoaded = false;
const sessionListeners = new Set<() => void>();

function getSessionSnapshot(): AuthResponse | null {
  if (!sessionLoaded && typeof window !== "undefined") {
    sessionLoaded = true;
    const storedSession = window.sessionStorage.getItem(SESSION_KEY);
    if (storedSession) {
      try {
        const parsed: unknown = JSON.parse(storedSession);
        if (isAuthResponse(parsed)) {
          sessionSnapshot = parsed;
        } else {
          window.sessionStorage.removeItem(SESSION_KEY);
        }
      } catch {
        window.sessionStorage.removeItem(SESSION_KEY);
      }
    }
  }
  return sessionSnapshot;
}

function subscribeToSession(listener: () => void): () => void {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

function storeSession(session: AuthResponse | null): void {
  sessionLoaded = true;
  sessionSnapshot = session;
  if (typeof window !== "undefined") {
    if (session) {
      window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } else {
      window.sessionStorage.removeItem(SESSION_KEY);
    }
  }
  sessionListeners.forEach((listener) => listener());
}

function subscribeToHydration(): () => void {
  return () => {};
}

function getHydrationSnapshot(): boolean {
  return true;
}

function getServerHydrationSnapshot(): boolean {
  return false;
}

function isAuthResponse(value: unknown): value is AuthResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const session = value as Partial<AuthResponse>;
  return (
    typeof session.accessToken === "string" &&
    typeof session.user === "object" &&
    session.user !== null &&
    typeof session.user.id === "number" &&
    typeof session.user.username === "string" &&
    typeof session.user.email === "string"
  );
}

function getErrorMessage(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null || !("message" in body)) {
    return fallback;
  }

  const message = body.message;
  if (typeof message === "string") {
    return message;
  }
  if (Array.isArray(message) && message.every((item) => typeof item === "string")) {
    return message.join(", ");
  }
  return fallback;
}

async function apiRequest<T>(
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
  } = {},
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  const contentType = response.headers.get("content-type");
  const body: unknown = contentType?.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    throw new ApiRequestError(
      getErrorMessage(body, `Request failed (${response.status})`),
      response.status,
    );
  }

  return body as T;
}

function getInitials(username: string): string {
  return username
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
}

export default function Home() {
  const session = useSyncExternalStore(
    subscribeToSession,
    getSessionSnapshot,
    () => null,
  );
  const isHydrated = useSyncExternalStore(
    subscribeToHydration,
    getHydrationSnapshot,
    getServerHydrationSnapshot,
  );
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [taskError, setTaskError] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [taskBusyId, setTaskBusyId] = useState<number | null>(null);
  const [taskFormBusy, setTaskFormBusy] = useState(false);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!session) {
      return;
    }

    let active = true;
    apiRequest<Task[]>("/tasks", { token: session.accessToken })
      .then((loadedTasks) => {
        if (active) {
          setTasks(loadedTasks);
        }
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        if (error instanceof ApiRequestError && error.status === 401) {
          storeSession(null);
          setTasksLoading(false);
          setTaskError("Your session expired. Please sign in again.");
          return;
        }
        setTaskError(
          error instanceof Error ? error.message : "Could not load your tasks.",
        );
      })
      .finally(() => {
        if (active) {
          setTasksLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [session]);

  const visibleTasks = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return tasks
      .filter((task) => {
        if (filter === "active" && task.completed) {
          return false;
        }
        if (filter === "completed" && !task.completed) {
          return false;
        }
        return (
          !normalizedSearch ||
          task.title.toLowerCase().includes(normalizedSearch) ||
          task.description?.toLowerCase().includes(normalizedSearch)
        );
      })
      .sort((left, right) => right.id - left.id);
  }, [filter, search, tasks]);

  const completedCount = tasks.filter((task) => task.completed).length;
  const activeCount = tasks.length - completedCount;

  async function handleAuthSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthError("");
    setAuthBusy(true);

    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");

    try {
      const nextSession =
        authMode === "register"
          ? await apiRequest<AuthResponse>("/auth/register", {
              method: "POST",
              body: {
                username: String(form.get("username") ?? "").trim(),
                email,
                password,
              },
            })
          : await apiRequest<AuthResponse>("/auth/login", {
              method: "POST",
              body: { email, password },
            });

      setTasks([]);
      setTasksLoading(true);
      setTaskError("");
      storeSession(nextSession);
    } catch (error) {
      setAuthError(
        error instanceof Error ? error.message : "Authentication failed.",
      );
    } finally {
      setAuthBusy(false);
    }
  }

  function signOut() {
    storeSession(null);
    setTasks([]);
    setTasksLoading(false);
    setSearch("");
    setFilter("all");
    setAuthMode("login");
    setAuthError("");
    setTaskError("");
  }

  async function handleCreateTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) {
      return;
    }

    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const title = String(form.get("title") ?? "").trim();
    const description = String(form.get("description") ?? "").trim();
    if (!title) {
      setTaskError("Add a task title before saving.");
      return;
    }

    setTaskFormBusy(true);
    setTaskError("");
    try {
      const task = await apiRequest<Task>("/tasks", {
        method: "POST",
        token: session.accessToken,
        body: { title, ...(description ? { description } : {}) },
      });
      setTasks((current) => [...current, task]);
      formElement.reset();
    } catch (error) {
      setTaskError(
        error instanceof Error ? error.message : "Could not create the task.",
      );
    } finally {
      setTaskFormBusy(false);
    }
  }

  async function toggleTask(task: Task) {
    if (!session) {
      return;
    }

    setTaskBusyId(task.id);
    setTaskError("");
    try {
      const updatedTask = await apiRequest<Task>(`/tasks/${task.id}`, {
        method: "PATCH",
        token: session.accessToken,
        body: { completed: !task.completed },
      });
      setTasks((current) =>
        current.map((item) => (item.id === task.id ? updatedTask : item)),
      );
    } catch (error) {
      setTaskError(
        error instanceof Error ? error.message : "Could not update the task.",
      );
    } finally {
      setTaskBusyId(null);
    }
  }

  async function deleteTask(taskId: number) {
    if (!session) {
      return;
    }

    setTaskBusyId(taskId);
    setTaskError("");
    try {
      await apiRequest<Task>(`/tasks/${taskId}`, {
        method: "DELETE",
        token: session.accessToken,
      });
      setTasks((current) => current.filter((task) => task.id !== taskId));
    } catch (error) {
      setTaskError(
        error instanceof Error ? error.message : "Could not delete the task.",
      );
    } finally {
      setTaskBusyId(null);
    }
  }

  if (!isHydrated) {
    return <main className="app-loading" aria-label="Loading Taskflow" />;
  }

  if (!session) {
    return (
      <main className="auth-page">
        <section className="auth-story">
          <Link className="brand brand-light" href="/" aria-label="Taskflow home">
            <span className="brand-mark" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </span>
            <span>taskflow</span>
          </Link>
          <div className="story-copy">
            <span className="eyebrow eyebrow-light">A calmer way to work</span>
            <h1>Make room for the work that matters.</h1>
            <p>
              Keep your day clear, your priorities close, and every small win
              moving forward.
            </p>
          </div>
          <div className="story-footer">
            <span className="story-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>Simple plans. Steady progress.</span>
          </div>
        </section>

        <section className="auth-panel">
          <div className="auth-card">
            <div className="mobile-brand">
              <span className="brand-mark brand-mark-dark" aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
              </span>
              taskflow
            </div>
            <div className="auth-heading">
              <span className="eyebrow">
                {authMode === "login" ? "WELCOME BACK" : "GET STARTED"}
              </span>
              <h2>
                {authMode === "login"
                  ? "Good to see you."
                  : "Create your account."}
              </h2>
              <p>
                {authMode === "login"
                  ? "Sign in to pick up right where you left off."
                  : "A little more focus starts with one simple step."}
              </p>
            </div>

            <div className="auth-switch" role="tablist" aria-label="Account action">
              <button
                className={authMode === "login" ? "selected" : ""}
                type="button"
                role="tab"
                aria-selected={authMode === "login"}
                onClick={() => {
                  setAuthMode("login");
                  setAuthError("");
                }}
              >
                Sign in
              </button>
              <button
                className={authMode === "register" ? "selected" : ""}
                type="button"
                role="tab"
                aria-selected={authMode === "register"}
                onClick={() => {
                  setAuthMode("register");
                  setAuthError("");
                }}
              >
                Create account
              </button>
            </div>

            <form className="auth-form" onSubmit={handleAuthSubmit}>
              {authMode === "register" && (
                <label className="field">
                  <span>Your name</span>
                  <input
                    autoComplete="name"
                    name="username"
                    placeholder="e.g. Alex Morgan"
                    required
                    minLength={1}
                  />
                </label>
              )}
              <label className="field">
                <span>Email address</span>
                <input
                  autoComplete="email"
                  name="email"
                  type="email"
                  placeholder="you@example.com"
                  required
                />
              </label>
              <label className="field">
                <span>Password</span>
                <input
                  autoComplete={
                    authMode === "login" ? "current-password" : "new-password"
                  }
                  name="password"
                  type="password"
                  placeholder="At least 6 characters"
                  required
                  minLength={authMode === "register" ? 6 : 1}
                />
              </label>
              {authError && (
                <p className="form-alert" role="alert">
                  {authError}
                </p>
              )}
              {taskError && (
                <p className="form-alert" role="alert">
                  {taskError}
                </p>
              )}
              <button
                className="button button-primary auth-submit"
                disabled={authBusy}
                type="submit"
              >
                {authBusy ? (
                  <>
                    <span className="spinner" />
                    {authMode === "login" ? "Signing in..." : "Creating account..."}
                  </>
                ) : authMode === "login" ? (
                  "Sign in"
                ) : (
                  "Create account"
                )}
                {!authBusy && <span aria-hidden="true">→</span>}
              </button>
            </form>
            <p className="auth-note">
              By continuing, you agree to keep your account details secure.
            </p>
          </div>
          <span className="auth-copyright">© 2026 Taskflow</span>
        </section>
      </main>
    );
  }

  return (
    <main className="dashboard">
      <aside className="sidebar">
        <Link className="brand brand-dark" href="/" aria-label="Taskflow home">
          <span className="brand-mark brand-mark-dark" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </span>
          <span>taskflow</span>
        </Link>

        <div className="workspace-label">WORKSPACE</div>
        <div className="workspace-switcher">
          <span className="workspace-icon">P</span>
          <span className="workspace-name">
            Personal space
            <small>Free plan</small>
          </span>
          <span className="chevron" aria-hidden="true">⌄</span>
        </div>

        <nav className="side-nav" aria-label="Main navigation">
          <span className="nav-section-label">OVERVIEW</span>
          <a className="nav-item nav-item-active" href="#my-tasks">
            <span className="nav-icon nav-check" aria-hidden="true">✓</span>
            My tasks
            <span className="nav-count">{tasks.length}</span>
          </a>
        </nav>

        <div className="sidebar-bottom">
          <div className="sidebar-tip">
            <span className="tip-spark" aria-hidden="true">✦</span>
            <strong>One thing at a time.</strong>
            <p>Small steps add up to meaningful progress.</p>
          </div>
          <div className="profile-row">
            <span className="avatar">{getInitials(session.user.username)}</span>
            <span className="profile-copy">
              <strong>{session.user.username}</strong>
              <small>{session.user.email}</small>
            </span>
            <button
              className="sign-out-button"
              onClick={signOut}
              type="button"
              aria-label="Sign out"
              title="Sign out"
            >
              ↪
            </button>
          </div>
        </div>
      </aside>

      <section className="dashboard-main" id="my-tasks">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span>
            <span aria-hidden="true">/</span>
            <strong>My tasks</strong>
          </div>
          <div className="topbar-right">
            <span className="today-label">
              <span className="calendar-icon" aria-hidden="true">▦</span>
              Your personal task list
            </span>
            <span className="top-avatar">{getInitials(session.user.username)}</span>
          </div>
        </header>

        <div className="content-wrap">
          <div className="page-intro">
            <div>
              <div className="eyebrow">YOUR SPACE, YOUR PACE</div>
              <h1>My tasks<span className="title-period">.</span></h1>
              <p>A clear mind starts with a clear list.</p>
            </div>
            <div className="date-stamp">
              <span className="date-dot" />
              <span>PRIVATE WORKSPACE</span>
            </div>
          </div>

          <section className="stats-grid" aria-label="Task summary">
            <article className="stat-card stat-card-total">
              <div className="stat-icon total-icon" aria-hidden="true">▤</div>
              <div>
                <span className="stat-label">Total tasks</span>
                <strong className="stat-value">{tasks.length}</strong>
              </div>
              <span className="stat-foot">in your list</span>
            </article>
            <article className="stat-card">
              <div className="stat-icon active-icon" aria-hidden="true">◷</div>
              <div>
                <span className="stat-label">In progress</span>
                <strong className="stat-value">{activeCount}</strong>
              </div>
              <span className="stat-foot">still to do</span>
            </article>
            <article className="stat-card">
              <div className="stat-icon completed-icon" aria-hidden="true">✓</div>
              <div>
                <span className="stat-label">Completed</span>
                <strong className="stat-value">{completedCount}</strong>
              </div>
              <span className="stat-foot">nice work</span>
            </article>
          </section>

          <section className="tasks-section">
            <div className="section-heading">
              <div>
                <h2>Tasks <span className="task-count">{tasks.length}</span></h2>
                <p>Keep your next steps close.</p>
              </div>
              <label className="search-box">
                <span aria-hidden="true">⌕</span>
                <input
                  aria-label="Search tasks"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search tasks"
                  value={search}
                />
              </label>
            </div>

            <form className="new-task-form" onSubmit={handleCreateTask}>
              <div className="new-task-title-row">
                <span className="add-icon" aria-hidden="true">+</span>
                <input
                  aria-label="Task title"
                  name="title"
                  placeholder="What needs to get done?"
                  required
                />
                <button
                  className="button button-primary add-task-button"
                  disabled={taskFormBusy}
                  type="submit"
                >
                  {taskFormBusy ? "Adding..." : "Add task"}
                  {!taskFormBusy && <span aria-hidden="true">↗</span>}
                </button>
              </div>
              <input
                className="task-description-input"
                name="description"
                placeholder="Add a note (optional)"
              />
            </form>

            <div className="task-toolbar">
              <div className="filter-tabs" role="tablist" aria-label="Filter tasks">
                {(["all", "active", "completed"] as const).map((value) => (
                  <button
                    aria-selected={filter === value}
                    className={filter === value ? "filter-tab filter-active" : "filter-tab"}
                    key={value}
                    onClick={() => setFilter(value)}
                    role="tab"
                    type="button"
                  >
                    {value === "all"
                      ? "All tasks"
                      : value === "active"
                        ? "In progress"
                        : "Completed"}
                    {value === "all" && <span>{tasks.length}</span>}
                  </button>
                ))}
              </div>
              <span className="task-sort-label">
                <span aria-hidden="true">↕</span> Newest first
              </span>
            </div>

            {taskError && (
              <p className="task-alert" role="alert">
                <span aria-hidden="true">!</span>
                {taskError}
                <button
                  aria-label="Dismiss error"
                  onClick={() => setTaskError("")}
                  type="button"
                >
                  ×
                </button>
              </p>
            )}

            <div className="task-list" aria-live="polite">
              {tasksLoading ? (
                <div className="empty-state">
                  <span className="spinner spinner-dark" />
                  <p>Loading your tasks...</p>
                </div>
              ) : visibleTasks.length ? (
                visibleTasks.map((task) => (
                  <article
                    className={`task-row ${task.completed ? "task-row-complete" : ""}`}
                    key={task.id}
                  >
                    <button
                      aria-label={
                        task.completed
                          ? `Mark ${task.title} as in progress`
                          : `Mark ${task.title} as completed`
                      }
                      className={`task-checkbox ${task.completed ? "checked" : ""}`}
                      disabled={taskBusyId === task.id}
                      onClick={() => void toggleTask(task)}
                      type="button"
                    >
                      {task.completed && <span aria-hidden="true">✓</span>}
                    </button>
                    <div className="task-copy">
                      <strong>{task.title}</strong>
                      {task.description && <p>{task.description}</p>}
                    </div>
                    <span
                      className={`task-status ${task.completed ? "status-done" : "status-active"}`}
                    >
                      <i />
                      {task.completed ? "Completed" : "In progress"}
                    </span>
                    <button
                      aria-label={`Delete ${task.title}`}
                      className="delete-task"
                      disabled={taskBusyId === task.id}
                      onClick={() => void deleteTask(task.id)}
                      type="button"
                    >
                      <span aria-hidden="true">×</span>
                    </button>
                  </article>
                ))
              ) : (
                <div className="empty-state">
                  <span className="empty-illustration" aria-hidden="true">
                    <span>✓</span>
                  </span>
                  <strong>
                    {search
                      ? "No tasks match your search"
                      : filter === "completed"
                        ? "Nothing completed just yet"
                        : filter === "active"
                          ? "You’re all caught up"
                          : "Your list is a blank canvas"}
                  </strong>
                  <p>
                    {search
                      ? "Try another keyword or clear the search."
                      : "Add a task above and turn your plans into progress."}
                  </p>
                </div>
              )}
            </div>
            <footer className="list-footer">
              <span>
                Showing {visibleTasks.length} of {tasks.length}{" "}
                {tasks.length === 1 ? "task" : "tasks"}
              </span>
              <span>
                Made for focus <i aria-hidden="true">✦</i>
              </span>
            </footer>
          </section>
        </div>
      </section>
    </main>
  );
}

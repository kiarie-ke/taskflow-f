"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { FormEvent } from "react";
import Link from "next/link";
import { TaskEditDialog } from "./task-edit-dialog";
import type {
  Task,
  TaskPriority,
  TaskRecurrence,
  TaskSubtask,
  TaskUpdatePayload,
} from "./task-types";

type UserProfile = {
  id: number;
  username: string;
  email: string;
};

type AuthResponse = {
  accessToken: string;
  user: UserProfile;
};

type Workspace = {
  id: number;
  name: string;
  ownerId: number;
  role: "owner" | "admin" | "member";
};

type WorkspaceMember = {
  userId: number;
  username: string;
  email: string;
  role: "owner" | "admin" | "member";
};

type SavedView = {
  id: number;
  name: string;
  filters: {
    filter?: TaskFilter;
    dueFilter?: DueFilter;
    priorityFilter?: TaskPriority | "any";
    projectFilter?: string;
    labelFilter?: string;
    sort?: TaskSort;
    search?: string;
  };
};

type NotificationSettings = {
  timezone: string;
  reminderTime: string;
  channels: Array<"email" | "push">;
  pushEnabled: boolean;
  publicKey: string | null;
};

type TaskComment = {
  id: number;
  content: string;
  username: string;
  createdAt: string;
};

type TaskActivity = {
  id: number;
  action: string;
  username: string;
  createdAt: string;
};

type TaskFilter = "all" | "active" | "completed";
type DueFilter = "any" | "today" | "overdue";
type TaskSort = "newest" | "due-date" | "priority" | "title";

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

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
const OFFLINE_CACHE_PREFIX = "taskflow-tasks:";
const OFFLINE_QUEUE_PREFIX = "taskflow-queue:";
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
    allowOffline?: boolean;
  } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const taskRequest = path.startsWith("/tasks");
  if (
    taskRequest &&
    options.allowOffline !== false &&
    typeof navigator !== "undefined" &&
    !navigator.onLine
  ) {
    return applyOfflineTaskRequest<T>(path, method, options.body);
  }
  const send = (token?: string) =>
    fetch(`${API_BASE_URL}${path}`, {
      method,
      credentials: "include",
      headers: {
        ...(options.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
  try {
    let response = await send(options.token);
    if (
      response.status === 401 &&
      options.token &&
      !path.startsWith("/auth/")
    ) {
      try {
        const refreshed = await fetch(`${API_BASE_URL}/auth/refresh`, {
          method: "POST",
          credentials: "include",
        });
        if (!refreshed.ok) {
          throw new Error("Refresh session expired");
        }
        const nextSession: unknown = await refreshed.json();
        if (!isAuthResponse(nextSession)) {
          throw new Error("Invalid refresh response");
        }
        storeSession(nextSession);
        response = await send(nextSession.accessToken);
      } catch {
        storeSession(null);
      }
    }
    const contentType = response.headers.get("content-type");
    const responseBody: unknown = contentType?.includes("application/json")
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      throw new ApiRequestError(
        getErrorMessage(responseBody, `Request failed (${response.status})`),
        response.status,
      );
    }

    if (taskRequest && options.allowOffline !== false) {
      cacheOnlineTaskResponse(path, method, options.body, responseBody);
    }
    return responseBody as T;
  } catch (error) {
    if (
      taskRequest &&
      options.allowOffline !== false &&
      error instanceof TypeError
    ) {
      return applyOfflineTaskRequest<T>(path, method, options.body);
    }
    throw error;
  }
}

type OfflineMutation = {
  path: string;
  method: string;
  body?: unknown;
  temporaryTaskId?: number;
  temporarySubtaskId?: number;
};

function isTask(value: unknown): value is Task {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "number" &&
    "title" in value &&
    typeof value.title === "string" &&
    "subtasks" in value &&
    Array.isArray(value.subtasks)
  );
}

function offlineCacheKey(userId: number, workspaceId?: string | number): string {
  return `${OFFLINE_CACHE_PREFIX}${userId}:${workspaceId ?? "personal"}`;
}

function offlineQueueKey(userId: number): string {
  return `${OFFLINE_QUEUE_PREFIX}${userId}`;
}

function readTaskCache(key: string): Task[] | undefined {
  const raw = window.localStorage.getItem(key);
  if (!raw) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every(isTask)
      ? parsed
      : undefined;
  } catch {
    window.localStorage.removeItem(key);
    return undefined;
  }
}

function saveTaskCache(key: string, tasks: Task[]): void {
  window.localStorage.setItem(key, JSON.stringify(tasks));
}

function readOfflineQueue(userId: number): OfflineMutation[] {
  const raw = window.localStorage.getItem(offlineQueueKey(userId));
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as OfflineMutation[]) : [];
  } catch {
    window.localStorage.removeItem(offlineQueueKey(userId));
    return [];
  }
}

function writeOfflineQueue(userId: number, queue: OfflineMutation[]): void {
  const key = offlineQueueKey(userId);
  if (queue.length) {
    window.localStorage.setItem(key, JSON.stringify(queue));
  } else {
    window.localStorage.removeItem(key);
  }
}

function taskCacheEntries(userId: number): Array<[string, Task[]]> {
  const entries: Array<[string, Task[]]> = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key?.startsWith(`${OFFLINE_CACHE_PREFIX}${userId}:`)) {
      continue;
    }
    const tasks = readTaskCache(key);
    if (tasks) {
      entries.push([key, tasks]);
    }
  }
  return entries;
}

function cacheOnlineTaskResponse(
  path: string,
  method: string,
  requestBody: unknown,
  responseBody: unknown,
): void {
  const userId = sessionSnapshot?.user.id;
  if (!userId || typeof window === "undefined") {
    return;
  }
  const parsedPath = new URL(path, window.location.origin);
  if (parsedPath.pathname === "/tasks" && method === "GET") {
    if (Array.isArray(responseBody) && responseBody.every(isTask)) {
      saveTaskCache(
        offlineCacheKey(userId, parsedPath.searchParams.get("workspaceId") ?? undefined),
        responseBody,
      );
    }
    return;
  }

  if (method === "POST" && parsedPath.pathname === "/tasks" && isTask(responseBody)) {
    const workspaceId =
      typeof requestBody === "object" &&
      requestBody !== null &&
      "workspaceId" in requestBody &&
      typeof requestBody.workspaceId === "number"
        ? requestBody.workspaceId
        : undefined;
    const key = offlineCacheKey(userId, workspaceId);
    const cached = readTaskCache(key) ?? [];
    saveTaskCache(
      key,
      cached.some((task) => task.id === responseBody.id)
        ? cached
        : [...cached, responseBody],
    );
    return;
  }

  const taskMatch = parsedPath.pathname.match(/^\/tasks\/(-?\d+)/);
  if (!taskMatch) {
    return;
  }
  const taskId = Number(taskMatch[1]);
  if (method === "DELETE" && parsedPath.pathname === `/tasks/${taskId}`) {
    for (const [key, tasks] of taskCacheEntries(userId)) {
      saveTaskCache(key, tasks.filter((task) => task.id !== taskId));
    }
    return;
  }
  if (!isTask(responseBody)) {
    return;
  }
  for (const [key, tasks] of taskCacheEntries(userId)) {
    if (tasks.some((task) => task.id === responseBody.id)) {
      saveTaskCache(
        key,
        tasks.map((task) => (task.id === responseBody.id ? responseBody : task)),
      );
    }
  }
}

function applyOfflineTaskRequest<T>(
  path: string,
  method: string,
  requestBody: unknown,
): T {
  const userId = sessionSnapshot?.user.id;
  if (!userId) {
    throw new Error("Sign in before using offline task changes.");
  }
  const parsedPath = new URL(path, window.location.origin);
  const isList = parsedPath.pathname === "/tasks";
  const listKey = offlineCacheKey(
    userId,
    parsedPath.searchParams.get("workspaceId") ?? undefined,
  );
  const tasks = readTaskCache(listKey);
  if (isList && method === "GET") {
    if (!tasks) {
      throw new Error("No cached tasks are available while offline.");
    }
    return tasks as T;
  }

  const queue = readOfflineQueue(userId);
  if (isList && method === "POST") {
    if (typeof requestBody !== "object" || requestBody === null || !("title" in requestBody)) {
      throw new Error("Could not save this task offline.");
    }
    const temporaryTaskId = -Date.now() * 1000 - Math.floor(Math.random() * 1000);
    const body = requestBody as Partial<Task>;
    const task: Task = {
      id: temporaryTaskId,
      title: String(body.title),
      ...(body.description ? { description: body.description } : {}),
      completed: body.completed ?? false,
      ownerId: userId,
      ...(body.workspaceId ? { workspaceId: body.workspaceId } : {}),
      ...(body.assigneeId ? { assigneeId: body.assigneeId } : {}),
      ...(body.dueDate ? { dueDate: body.dueDate } : {}),
      priority: body.priority ?? "medium",
      ...(body.project ? { project: body.project } : {}),
      labels: body.labels ?? [],
      ...(body.recurrence ? { recurrence: body.recurrence } : {}),
      subtasks: [],
    };
    const workspaceCache = offlineCacheKey(userId, body.workspaceId);
    const current = readTaskCache(workspaceCache) ?? [];
    saveTaskCache(workspaceCache, [...current, task]);
    queue.push({
      path: "/tasks",
      method,
      body: requestBody,
      temporaryTaskId,
    });
    writeOfflineQueue(userId, queue);
    return task as T;
  }

  const taskMatch = parsedPath.pathname.match(/^\/tasks\/(-?\d+)/);
  const taskId = taskMatch ? Number(taskMatch[1]) : undefined;
  const cacheEntry = taskId === undefined
    ? undefined
    : taskCacheEntries(userId).find(([, list]) => list.some((task) => task.id === taskId));
  const task = cacheEntry?.[1].find((item) => item.id === taskId);
  if (!task || !cacheEntry || taskId === undefined) {
    throw new Error("This task is not available in the offline cache.");
  }

  if (parsedPath.pathname === `/tasks/${taskId}` && method === "PATCH") {
    const changes =
      typeof requestBody === "object" && requestBody !== null
        ? (requestBody as Partial<Task>)
        : {};
    const updated = { ...task, ...changes };
    saveTaskCache(
      cacheEntry[0],
      cacheEntry[1].map((item) => (item.id === taskId ? updated : item)),
    );
    queue.push({ path, method, body: requestBody });
    writeOfflineQueue(userId, queue);
    return updated as T;
  }
  if (parsedPath.pathname === `/tasks/${taskId}` && method === "DELETE") {
    saveTaskCache(cacheEntry[0], cacheEntry[1].filter((item) => item.id !== taskId));
    if (taskId < 0) {
      writeOfflineQueue(
        userId,
        queue.filter(
          (item) =>
            item.temporaryTaskId !== taskId &&
            !item.path.includes(`/tasks/${taskId}`),
        ),
      );
    } else {
      queue.push({ path, method });
      writeOfflineQueue(userId, queue);
    }
    return task as T;
  }

  const createSubtask = parsedPath.pathname === `/tasks/${taskId}/subtasks`;
  const subtaskMatch = parsedPath.pathname.match(
    /^\/tasks\/-?\d+\/subtasks\/(-?\d+)$/,
  );
  if (createSubtask && method === "POST") {
    const title =
      typeof requestBody === "object" &&
      requestBody !== null &&
      "title" in requestBody
        ? String(requestBody.title)
        : "";
    if (!title.trim()) {
      throw new Error("A subtask title is required.");
    }
    const temporarySubtaskId = -Date.now() * 1000 - Math.floor(Math.random() * 1000);
    const updated = {
      ...task,
      subtasks: [
        ...task.subtasks,
        { id: temporarySubtaskId, title: title.trim(), completed: false },
      ],
    };
    saveTaskCache(
      cacheEntry[0],
      cacheEntry[1].map((item) => (item.id === taskId ? updated : item)),
    );
    queue.push({
      path,
      method,
      body: requestBody,
      temporarySubtaskId,
      temporaryTaskId: taskId < 0 ? taskId : undefined,
    });
    writeOfflineQueue(userId, queue);
    return updated as T;
  }
  if (subtaskMatch && (method === "PATCH" || method === "DELETE")) {
    const subtaskId = Number(subtaskMatch[1]);
    const subtask = task.subtasks.find((item) => item.id === subtaskId);
    if (!subtask) {
      throw new Error("This subtask is not available in the offline cache.");
    }
    const subtasks =
      method === "DELETE"
        ? task.subtasks.filter((item) => item.id !== subtaskId)
        : task.subtasks.map((item) =>
            item.id === subtaskId
              ? { ...item, completed: Boolean((requestBody as { completed?: unknown }).completed) }
              : item,
          );
    const updated = { ...task, subtasks };
    saveTaskCache(
      cacheEntry[0],
      cacheEntry[1].map((item) => (item.id === taskId ? updated : item)),
    );
    if (taskId < 0 && subtaskId < 0 && method === "DELETE") {
      writeOfflineQueue(
        userId,
        queue.filter((item) => item.temporarySubtaskId !== subtaskId),
      );
    } else {
      queue.push({ path, method, body: requestBody });
      writeOfflineQueue(userId, queue);
    }
    return updated as T;
  }
  throw new Error("This task change is not supported while offline.");
}

async function syncOfflineQueue(userId: number, token: string): Promise<void> {
  const taskIds = new Map<number, number>();
  const subtaskIds = new Map<string, number>();
  let queue = readOfflineQueue(userId);

  while (queue.length) {
    const item = queue[0];
    const originalTaskMatch = item.path.match(/^\/tasks\/(-?\d+)/);
    const originalTaskId = originalTaskMatch
      ? Number(originalTaskMatch[1])
      : undefined;
    let path = item.path;
    if (originalTaskId !== undefined && originalTaskId < 0) {
      const actualTaskId = taskIds.get(originalTaskId);
      if (actualTaskId === undefined) {
        throw new Error("Offline changes are out of order and cannot sync.");
      }
      path = path.replace(`/tasks/${originalTaskId}`, `/tasks/${actualTaskId}`);
    }

    const subtaskMatch = item.path.match(
      /^\/tasks\/-?\d+\/subtasks\/(-?\d+)$/,
    );
    if (subtaskMatch && originalTaskId !== undefined) {
      const temporarySubtaskId = Number(subtaskMatch[1]);
      if (temporarySubtaskId < 0) {
        const actualSubtaskId = subtaskIds.get(
          `${originalTaskId}:${temporarySubtaskId}`,
        );
        if (actualSubtaskId === undefined) {
          throw new Error("An offline subtask change cannot be matched.");
        }
        path = path.replace(
          `/subtasks/${temporarySubtaskId}`,
          `/subtasks/${actualSubtaskId}`,
        );
      }
    }

    const result = await apiRequest<unknown>(path, {
      method: item.method,
      token,
      body: item.body,
      allowOffline: false,
    });
    if (item.temporaryTaskId !== undefined && isTask(result)) {
      taskIds.set(item.temporaryTaskId, result.id);
    }
    if (item.temporarySubtaskId !== undefined && isTask(result)) {
      const title =
        typeof item.body === "object" &&
        item.body !== null &&
        "title" in item.body
          ? String(item.body.title)
          : "";
      const created = result.subtasks
        .filter((subtask) => subtask.title === title)
        .sort((left, right) => right.id - left.id)[0];
      if (created && originalTaskId !== undefined) {
        subtaskIds.set(
          `${originalTaskId}:${item.temporarySubtaskId}`,
          created.id,
        );
      }
    }

    queue = queue.slice(1);
    writeOfflineQueue(userId, queue);
  }
}

function getInitials(username: string): string {
  return username
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
}

function getLocalDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getWeekDateKeys(today: string, offset: number): string[] {
  if (!today) {
    return [];
  }
  const [year, month, day] = today.split("-").map(Number);
  const start = new Date(year, month - 1, day);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7) + offset * 7);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return getLocalDateKey(date);
  });
}

function decodeVapidKey(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const result = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    result[index] = raw.charCodeAt(index);
  }
  return result;
}

function getClientDateKey(): string {
  return getLocalDateKey(new Date());
}

function getServerDateKey(): string {
  return "";
}

function subscribeToDate(listener: () => void): () => void {
  const timer = window.setInterval(listener, 60_000);
  return () => window.clearInterval(timer);
}

function formatDueDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(year, month - 1, day));
}

function parseLabels(value: FormDataEntryValue | null): string[] {
  return [
    ...new Set(
      String(value ?? "")
        .split(",")
        .map((label) => label.trim())
        .filter(Boolean),
    ),
  ];
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
  const [taskNotice, setTaskNotice] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [taskBusyId, setTaskBusyId] = useState<number | null>(null);
  const [taskFormBusy, setTaskFormBusy] = useState(false);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [dueFilter, setDueFilter] = useState<DueFilter>("any");
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority | "any">(
    "any",
  );
  const [projectFilter, setProjectFilter] = useState("any");
  const [labelFilter, setLabelFilter] = useState("any");
  const [sort, setSort] = useState<TaskSort>("newest");
  const [search, setSearch] = useState("");
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<number | null>(null);
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMember[]>([]);
  const [workspaceName, setWorkspaceName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [savedViewName, setSavedViewName] = useState("");
  const [selectedSavedViewId, setSelectedSavedViewId] = useState("");
  const [weekView, setWeekView] = useState(false);
  const [weekOffset, setWeekOffset] = useState(0);
  const [discussionTaskId, setDiscussionTaskId] = useState<number | null>(null);
  const [taskComments, setTaskComments] = useState<TaskComment[]>([]);
  const [taskActivity, setTaskActivity] = useState<TaskActivity[]>([]);
  const [commentText, setCommentText] = useState("");
  const [notificationSettings, setNotificationSettings] =
    useState<NotificationSettings | null>(null);
  const [reminders, setReminders] = useState<Array<{
    id: number;
    taskTitle: string;
    channel: string;
    sentAt: string | null;
  }>>([]);
  const [notificationTime, setNotificationTime] = useState("09:00");
  const [notificationTimezone, setNotificationTimezone] = useState("UTC");
  const [notificationChannels, setNotificationChannels] = useState<
    Array<"email" | "push">
  >(["email"]);
  const [isOnline, setIsOnline] = useState(true);
  const [pendingOfflineCount, setPendingOfflineCount] = useState(0);
  const syncingOffline = useRef(false);
  const today = useSyncExternalStore(
    subscribeToDate,
    getClientDateKey,
    getServerDateKey,
  );

  useEffect(() => {
    if (!session) {
      return;
    }

    let active = true;
    const taskPath = workspaceId
      ? `/tasks?workspaceId=${workspaceId}`
      : "/tasks";
    apiRequest<Task[]>(taskPath, { token: session.accessToken })
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
  }, [session, workspaceId]);

  useEffect(() => {
    if (!session) {
      return;
    }
    let active = true;
    Promise.all([
      apiRequest<Workspace[]>("/workspaces", { token: session.accessToken }),
      apiRequest<SavedView[]>("/saved-views", { token: session.accessToken }),
      apiRequest<NotificationSettings>("/notifications/settings", {
        token: session.accessToken,
      }),
      apiRequest<typeof reminders>("/notifications", {
        token: session.accessToken,
      }),
    ])
      .then(([loadedWorkspaces, loadedViews, settings, loadedReminders]) => {
        if (!active) {
          return;
        }
        setWorkspaces(loadedWorkspaces);
        setSavedViews(loadedViews);
        setNotificationSettings(settings);
        setNotificationTime(settings.reminderTime);
        setNotificationTimezone(settings.timezone);
        setNotificationChannels(settings.channels);
        setReminders(loadedReminders);
      })
      .catch((error: unknown) => {
        if (active) {
          setTaskError(
            error instanceof Error
              ? error.message
              : "Could not load your account settings.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [session]);

  useEffect(() => {
    if (!session) {
      return;
    }
    const token = window.sessionStorage.getItem("taskflow-pending-invite");
    if (!token) {
      return;
    }
    window.sessionStorage.removeItem("taskflow-pending-invite");
    apiRequest<Workspace>("/workspaces/accept-invitation", {
      method: "POST",
      token: session.accessToken,
      body: { token },
    })
      .then(async (workspace) => {
        setWorkspaces(
          await apiRequest<Workspace[]>("/workspaces", {
            token: session.accessToken,
          }),
        );
        setWorkspaceId(workspace.id);
        setTasksLoading(true);
        setTaskNotice(`You joined ${workspace.name}.`);
      })
      .catch((error: unknown) => {
        window.sessionStorage.setItem("taskflow-pending-invite", token);
        setTaskError(
          error instanceof Error
            ? error.message
            : "Could not accept the workspace invitation.",
        );
      });
  }, [session]);

  useEffect(() => {
    if (!session || !workspaceId) {
      return;
    }
    let active = true;
    apiRequest<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`, {
      token: session.accessToken,
    })
      .then((members) => {
        if (active) {
          setWorkspaceMembers(members);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setTaskError(
            error instanceof Error
              ? error.message
              : "Could not load workspace members.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [session, workspaceId]);

  useEffect(() => {
    if (!session) {
      return;
    }
    const refreshOfflineStatus = () => {
      setIsOnline(navigator.onLine);
      setPendingOfflineCount(readOfflineQueue(session.user.id).length);
    };
    const sync = () => {
      refreshOfflineStatus();
      if (!navigator.onLine || syncingOffline.current) {
        return;
      }
      syncingOffline.current = true;
      void syncOfflineQueue(session.user.id, session.accessToken)
        .then(async () => {
          const taskPath = workspaceId
            ? `/tasks?workspaceId=${workspaceId}`
            : "/tasks";
          setTasks(await apiRequest<Task[]>(taskPath, {
            token: session.accessToken,
            allowOffline: false,
          }));
          refreshOfflineStatus();
        })
        .catch((error: unknown) => {
          setTaskError(
            error instanceof Error
              ? `Offline changes could not sync: ${error.message}`
              : "Offline changes could not sync.",
          );
        })
        .finally(() => {
          syncingOffline.current = false;
          refreshOfflineStatus();
        });
    };
    const online = () => sync();
    const offline = () => refreshOfflineStatus();
    refreshOfflineStatus();
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    sync();
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, [session, workspaceId]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      return;
    }
    void navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      setTaskError(
        error instanceof Error
          ? `Offline app setup failed: ${error.message}`
          : "Offline app setup failed.",
      );
    });
  }, []);

  const projectNames = useMemo(
    () =>
      [
        ...new Set(
          tasks
            .map((task) => task.project)
            .filter((project): project is string => Boolean(project)),
        ),
      ].sort((left, right) => left.localeCompare(right)),
    [tasks],
  );
  const labelNames = useMemo(
    () =>
      [...new Set(tasks.flatMap((task) => task.labels))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [tasks],
  );

  const visibleTasks = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    const filtered = tasks
      .filter((task) => {
        if (filter === "active" && task.completed) {
          return false;
        }
        if (filter === "completed" && !task.completed) {
          return false;
        }
        if (
          dueFilter === "today" &&
          (task.completed || task.dueDate !== today)
        ) {
          return false;
        }
        if (
          dueFilter === "overdue" &&
          (task.completed || !task.dueDate || task.dueDate >= today)
        ) {
          return false;
        }
        if (priorityFilter !== "any" && task.priority !== priorityFilter) {
          return false;
        }
        if (projectFilter !== "any" && task.project !== projectFilter) {
          return false;
        }
        if (
          labelFilter !== "any" &&
          !task.labels.includes(labelFilter)
        ) {
          return false;
        }
        return (
          !normalizedSearch ||
          task.title.toLowerCase().includes(normalizedSearch) ||
          task.description?.toLowerCase().includes(normalizedSearch) ||
          task.project?.toLowerCase().includes(normalizedSearch) ||
          task.labels.some((label) =>
            label.toLowerCase().includes(normalizedSearch),
          )
        );
      });

    return filtered.sort((left, right) => {
      if (sort === "due-date") {
        return (
          (left.dueDate ?? "9999-12-31").localeCompare(
            right.dueDate ?? "9999-12-31",
          ) || right.id - left.id
        );
      }
      if (sort === "priority") {
        return (
          PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority] ||
          right.id - left.id
        );
      }
      if (sort === "title") {
        return left.title.localeCompare(right.title);
      }
      return right.id - left.id;
    });
  }, [
    dueFilter,
    filter,
    labelFilter,
    priorityFilter,
    projectFilter,
    search,
    sort,
    tasks,
    today,
  ]);

  const completedCount = tasks.filter((task) => task.completed).length;
  const activeCount = tasks.length - completedCount;
  const overdueCount = tasks.filter(
    (task) => !task.completed && task.dueDate && task.dueDate < today,
  ).length;
  const dueTodayCount = tasks.filter(
    (task) => !task.completed && task.dueDate === today,
  ).length;
  const weekDates = useMemo(
    () => getWeekDateKeys(today, weekOffset),
    [today, weekOffset],
  );
  const selectedWorkspace = workspaces.find(
    (workspace) => workspace.id === workspaceId,
  );

  async function handleCreateWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) {
      return;
    }
    try {
      const workspace = await apiRequest<Workspace>("/workspaces", {
        method: "POST",
        token: session.accessToken,
        body: { name: workspaceName },
      });
      setWorkspaces((current) => [...current, workspace]);
      setTasksLoading(true);
      setWorkspaceId(workspace.id);
      setWorkspaceName("");
      setTaskNotice(`Created ${workspace.name}.`);
    } catch (error) {
      setTaskError(
        error instanceof Error ? error.message : "Could not create workspace.",
      );
    }
  }

  async function handleInviteMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !workspaceId) {
      return;
    }
    try {
      await apiRequest(`/workspaces/${workspaceId}/invitations`, {
        method: "POST",
        token: session.accessToken,
        body: {
          email: inviteEmail,
          role: String(new FormData(event.currentTarget).get("role") ?? "member"),
        },
      });
      setInviteEmail("");
      setTaskNotice("Invitation sent.");
    } catch (error) {
      setTaskError(
        error instanceof Error ? error.message : "Could not send invitation.",
      );
    }
  }

  async function saveCurrentView(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) {
      return;
    }
    try {
      const view = await apiRequest<SavedView>("/saved-views", {
        method: "POST",
        token: session.accessToken,
        body: {
          name: savedViewName,
          filters: {
            filter,
            dueFilter,
            priorityFilter,
            projectFilter,
            labelFilter,
            sort,
            search,
          },
        },
      });
      setSavedViews((current) => [...current, view]);
      setSelectedSavedViewId(String(view.id));
      setSavedViewName("");
    } catch (error) {
      setTaskError(
        error instanceof Error ? error.message : "Could not save this view.",
      );
    }
  }

  function applySavedView(id: string) {
    setSelectedSavedViewId(id);
    const view = savedViews.find((item) => String(item.id) === id);
    if (!view) {
      return;
    }
    setFilter(view.filters.filter ?? "all");
    setDueFilter(view.filters.dueFilter ?? "any");
    setPriorityFilter(view.filters.priorityFilter ?? "any");
    setProjectFilter(view.filters.projectFilter ?? "any");
    setLabelFilter(view.filters.labelFilter ?? "any");
    setSort(view.filters.sort ?? "newest");
    setSearch(view.filters.search ?? "");
  }

  async function deleteSavedView() {
    if (!session || !selectedSavedViewId) {
      return;
    }
    try {
      await apiRequest(`/saved-views/${selectedSavedViewId}`, {
        method: "DELETE",
        token: session.accessToken,
      });
      setSavedViews((current) =>
        current.filter((view) => String(view.id) !== selectedSavedViewId),
      );
      setSelectedSavedViewId("");
    } catch (error) {
      setTaskError(
        error instanceof Error ? error.message : "Could not delete saved view.",
      );
    }
  }

  async function toggleDiscussion(taskId: number) {
    if (!session) {
      return;
    }
    if (discussionTaskId === taskId) {
      setDiscussionTaskId(null);
      return;
    }
    setDiscussionTaskId(taskId);
    try {
      const [comments, activity] = await Promise.all([
        apiRequest<TaskComment[]>(`/tasks/${taskId}/comments`, {
          token: session.accessToken,
        }),
        apiRequest<TaskActivity[]>(`/tasks/${taskId}/activity`, {
          token: session.accessToken,
        }),
      ]);
      setTaskComments(comments);
      setTaskActivity(activity);
    } catch (error) {
      setTaskError(
        error instanceof Error
          ? error.message
          : "Could not load task comments.",
      );
      setDiscussionTaskId(null);
    }
  }

  async function addTaskComment(
    taskId: number,
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    if (!session || !commentText.trim()) {
      return;
    }
    try {
      const comment = await apiRequest<TaskComment>(
        `/tasks/${taskId}/comments`,
        {
          method: "POST",
          token: session.accessToken,
          body: { content: commentText },
        },
      );
      setTaskComments((current) => [...current, comment]);
      setTaskActivity((current) => [
        {
          id: -Date.now(),
          action: "comment.created",
          username: session.user.username,
          createdAt: new Date().toISOString(),
        },
        ...current,
      ]);
      setCommentText("");
    } catch (error) {
      setTaskError(
        error instanceof Error ? error.message : "Could not add comment.",
      );
    }
  }

  async function saveNotificationSettings(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    if (!session) {
      return;
    }
    try {
      const settings = await apiRequest<NotificationSettings>(
        "/notifications/settings",
        {
          method: "PATCH",
          token: session.accessToken,
          body: {
            timezone: notificationTimezone,
            reminderTime: notificationTime,
            channels: notificationChannels,
          },
        },
      );
      setNotificationSettings(settings);
      setTaskNotice("Reminder settings saved.");
    } catch (error) {
      setTaskError(
        error instanceof Error
          ? error.message
          : "Could not save reminder settings.",
      );
    }
  }

  async function enablePushNotifications() {
    if (!session || !notificationSettings?.publicKey) {
      setTaskError("Web push is not configured for this app.");
      return;
    }
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setTaskError("This browser does not support web push notifications.");
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        throw new Error("Allow notifications in your browser to continue.");
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeVapidKey(notificationSettings.publicKey),
      });
      const serialized = subscription.toJSON();
      if (!serialized.endpoint || !serialized.keys?.p256dh || !serialized.keys.auth) {
        throw new Error("The browser returned an incomplete push subscription.");
      }
      await apiRequest("/notifications/push-subscriptions", {
        method: "POST",
        token: session.accessToken,
        body: {
          endpoint: serialized.endpoint,
          keys: serialized.keys,
        },
      });
      setTaskNotice("Push notifications enabled.");
    } catch (error) {
      setTaskError(
        error instanceof Error
          ? error.message
          : "Could not enable push notifications.",
      );
    }
  }

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

  async function signOut() {
    try {
      await apiRequest<void>("/auth/logout", { method: "POST" });
    } catch (error) {
      setTaskError(
        error instanceof Error ? error.message : "Could not revoke the session.",
      );
    }
    storeSession(null);
    setTasks([]);
    setTasksLoading(false);
    setWorkspaces([]);
    setWorkspaceMembers([]);
    setWorkspaceId(null);
    setSavedViews([]);
    setReminders([]);
    setNotificationSettings(null);
    setSearch("");
    setFilter("all");
    setDueFilter("any");
    setPriorityFilter("any");
    setProjectFilter("any");
    setLabelFilter("any");
    setSort("newest");
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
    const dueDate = String(form.get("dueDate") ?? "");
    const project = String(form.get("project") ?? "").trim();
    const priority = String(form.get("priority") ?? "medium") as TaskPriority;
    const recurrence = String(form.get("recurrence") ?? "") as
      | TaskRecurrence
      | "";
    if (recurrence && !dueDate) {
      setTaskError("Choose a due date for a recurring task.");
      return;
    }
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
        body: {
          title,
          ...(description ? { description } : {}),
          priority,
          labels: parseLabels(form.get("labels")),
          ...(dueDate ? { dueDate } : {}),
          ...(project ? { project } : {}),
          ...(recurrence ? { recurrence } : {}),
          ...(workspaceId
            ? {
                workspaceId,
                ...(form.get("assigneeId")
                  ? { assigneeId: Number(form.get("assigneeId")) }
                  : {}),
              }
            : {}),
        },
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
      if (!task.completed && updatedTask.completed && task.recurrence) {
        setTasks(
          await apiRequest<Task[]>(
            workspaceId ? `/tasks?workspaceId=${workspaceId}` : "/tasks",
            {
            token: session.accessToken,
            },
          ),
        );
      } else {
        setTasks((current) =>
          current.map((item) => (item.id === task.id ? updatedTask : item)),
        );
      }
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

  async function saveTask(taskId: number, changes: TaskUpdatePayload) {
    if (!session) {
      throw new Error("Please sign in again to edit this task.");
    }

    const updatedTask = await apiRequest<Task>(`/tasks/${taskId}`, {
      method: "PATCH",
      token: session.accessToken,
      body: changes,
    });
    setTasks((current) =>
      current.map((task) => (task.id === taskId ? updatedTask : task)),
    );
    setEditingTask(null);
  }

  async function addSubtask(
    taskId: number,
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    if (!session) {
      return;
    }

    const formElement = event.currentTarget;
    const title = String(new FormData(formElement).get("title") ?? "").trim();
    if (!title) {
      return;
    }

    setTaskBusyId(taskId);
    setTaskError("");
    try {
      const updatedTask = await apiRequest<Task>(`/tasks/${taskId}/subtasks`, {
        method: "POST",
        token: session.accessToken,
        body: { title },
      });
      setTasks((current) =>
        current.map((task) => (task.id === taskId ? updatedTask : task)),
      );
      formElement.reset();
    } catch (error) {
      setTaskError(
        error instanceof Error ? error.message : "Could not add the subtask.",
      );
    } finally {
      setTaskBusyId(null);
    }
  }

  async function toggleSubtask(taskId: number, subtask: TaskSubtask) {
    if (!session) {
      return;
    }

    setTaskBusyId(taskId);
    setTaskError("");
    try {
      const updatedTask = await apiRequest<Task>(
        `/tasks/${taskId}/subtasks/${subtask.id}`,
        {
          method: "PATCH",
          token: session.accessToken,
          body: { completed: !subtask.completed },
        },
      );
      setTasks((current) =>
        current.map((task) => (task.id === taskId ? updatedTask : task)),
      );
    } catch (error) {
      setTaskError(
        error instanceof Error
          ? error.message
          : "Could not update the subtask.",
      );
    } finally {
      setTaskBusyId(null);
    }
  }

  async function deleteSubtask(taskId: number, subtaskId: number) {
    if (!session) {
      return;
    }

    setTaskBusyId(taskId);
    setTaskError("");
    try {
      const updatedTask = await apiRequest<Task>(
        `/tasks/${taskId}/subtasks/${subtaskId}`,
        {
          method: "DELETE",
          token: session.accessToken,
        },
      );
      setTasks((current) =>
        current.map((task) => (task.id === taskId ? updatedTask : task)),
      );
    } catch (error) {
      setTaskError(
        error instanceof Error
          ? error.message
          : "Could not remove the subtask.",
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
              {authMode === "login" && (
                <Link className="auth-link" href="/forgot-password">
                  Forgot your password?
                </Link>
              )}
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
        <label className="workspace-select-label">
          <span className="sr-only">Choose a workspace</span>
          <select
            className="workspace-select"
            onChange={(event) =>
              {
                setWorkspaceMembers([]);
                setTasksLoading(true);
                setWorkspaceId(
                  event.target.value ? Number(event.target.value) : null,
                );
              }
            }
            value={workspaceId ?? ""}
          >
            <option value="">Personal space</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name} · {workspace.role}
              </option>
            ))}
          </select>
        </label>
        <form className="workspace-create-form" onSubmit={handleCreateWorkspace}>
          <input
            aria-label="New workspace name"
            maxLength={80}
            onChange={(event) => setWorkspaceName(event.target.value)}
            placeholder="New workspace..."
            required
            value={workspaceName}
          />
          <button aria-label="Create workspace" type="submit">+</button>
        </form>

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
              {isOnline ? "Online" : "Offline · changes saved on this device"}
            </span>
            {pendingOfflineCount > 0 && (
              <span className="offline-count">
                {pendingOfflineCount} pending
              </span>
            )}
            <span className="top-avatar">{getInitials(session.user.username)}</span>
          </div>
        </header>

        <div className="content-wrap">
          <div className="page-intro">
            <div>
              <div className="eyebrow">YOUR SPACE, YOUR PACE</div>
              <h1>{selectedWorkspace?.name ?? "My tasks"}<span className="title-period">.</span></h1>
              <p>
                {selectedWorkspace
                  ? `Shared space · ${selectedWorkspace.role}`
                  : "A clear mind starts with a clear list."}
              </p>
            </div>
            <div className="date-stamp">
              <span className="date-dot" />
              <span>{selectedWorkspace ? "TEAM WORKSPACE" : "PRIVATE WORKSPACE"}</span>
            </div>
          </div>

          {selectedWorkspace &&
            (selectedWorkspace.role === "owner" ||
              selectedWorkspace.role === "admin") && (
              <form className="invite-form" onSubmit={handleInviteMember}>
                <label>
                  <span>Invite a teammate</span>
                  <input
                    autoComplete="email"
                    maxLength={254}
                    onChange={(event) => setInviteEmail(event.target.value)}
                    placeholder="teammate@example.com"
                    required
                    type="email"
                    value={inviteEmail}
                  />
                </label>
                <label>
                  <span>Role</span>
                  <select defaultValue="member" name="role">
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                </label>
                <button className="button button-primary" type="submit">
                  Send invite
                </button>
                <small>
                  Invitees need a Taskflow account before joining.
                </small>
              </form>
            )}

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

          <section className="feature-panel">
            <details>
              <summary>Reminders &amp; notifications</summary>
              {notificationSettings ? (
                <>
                  <form
                    className="notification-settings"
                    onSubmit={saveNotificationSettings}
                  >
                    <label>
                      <span>Reminder time</span>
                      <input
                        onChange={(event) => setNotificationTime(event.target.value)}
                        type="time"
                        value={notificationTime}
                      />
                    </label>
                    <label>
                      <span>Time zone</span>
                      <input
                        maxLength={80}
                        onChange={(event) =>
                          setNotificationTimezone(event.target.value)
                        }
                        value={notificationTimezone}
                      />
                    </label>
                    <label className="checkbox-field">
                      <input
                        checked={notificationChannels.includes("email")}
                        onChange={(event) =>
                          setNotificationChannels((current) =>
                            event.target.checked
                              ? current.includes("email")
                                ? current
                                : [...current, "email"]
                              : current.filter((channel) => channel !== "email"),
                          )
                        }
                        type="checkbox"
                      />
                      Email
                    </label>
                    <label className="checkbox-field">
                      <input
                        checked={notificationChannels.includes("push")}
                        disabled={!notificationSettings.pushEnabled}
                        onChange={(event) =>
                          setNotificationChannels((current) =>
                            event.target.checked
                              ? current.includes("push")
                                ? current
                                : [...current, "push"]
                              : current.filter((channel) => channel !== "push"),
                          )
                        }
                        type="checkbox"
                      />
                      Web push
                    </label>
                    <button className="button button-primary" type="submit">
                      Save reminders
                    </button>
                    {notificationChannels.includes("push") && (
                      <button
                        className="button button-secondary"
                        onClick={() => void enablePushNotifications()}
                        type="button"
                      >
                        Enable this device
                      </button>
                    )}
                  </form>
                  {!notificationSettings.pushEnabled && (
                    <p className="feature-hint">
                      Push requires the server’s VAPID keys. Email reminders
                      work using the configured mail transport.
                    </p>
                  )}
                  {reminders.length > 0 && (
                    <ul className="reminder-history">
                      {reminders.slice(0, 5).map((reminder) => (
                        <li key={reminder.id}>
                          {reminder.taskTitle} · {reminder.channel}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <p className="feature-hint">Loading reminder settings...</p>
              )}
            </details>
          </section>

          {(overdueCount > 0 || dueTodayCount > 0) && (
            <section className="reminder-banner" aria-live="polite">
              <span className="reminder-icon" aria-hidden="true">!</span>
              <div>
                <strong>
                  {overdueCount > 0
                    ? `${overdueCount} overdue task${overdueCount === 1 ? "" : "s"}`
                    : `${dueTodayCount} task${dueTodayCount === 1 ? "" : "s"} due today`}
                </strong>
                <p>
                  {overdueCount > 0 && dueTodayCount > 0
                    ? `${dueTodayCount} more due today. Take a look at what needs your attention.`
                    : overdueCount > 0
                      ? "These tasks are past their due date."
                      : "Here are the tasks on your list for today."}
                </p>
              </div>
              <button
                onClick={() => {
                  setFilter("active");
                  setDueFilter(overdueCount > 0 ? "overdue" : "today");
                }}
                type="button"
              >
                Review tasks <span aria-hidden="true">→</span>
              </button>
            </section>
          )}

          {taskNotice && (
            <p className="task-notice" role="status">
              {taskNotice}
              <button
                aria-label="Dismiss message"
                onClick={() => setTaskNotice("")}
                type="button"
              >
                ×
              </button>
            </p>
          )}

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
              <details className="task-options">
                <summary>Plan and organize this task</summary>
                <div className="task-option-grid">
                  {workspaceId && (
                    <label>
                      <span>Assign to</span>
                      <select defaultValue="" name="assigneeId">
                        <option value="">Unassigned</option>
                        {workspaceMembers.map((member) => (
                          <option key={member.userId} value={member.userId}>
                            {member.username}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label>
                    <span>Due date</span>
                    <input aria-label="Due date" name="dueDate" type="date" />
                  </label>
                  <label>
                    <span>Priority</span>
                    <select aria-label="Priority" defaultValue="medium" name="priority">
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                  </label>
                  <label>
                    <span>Project</span>
                    <input
                      aria-label="Project"
                      list="task-projects"
                      maxLength={60}
                      name="project"
                      placeholder="Project name"
                    />
                    <datalist id="task-projects">
                      {projectNames.map((project) => (
                        <option key={project} value={project} />
                      ))}
                    </datalist>
                  </label>
                  <label>
                    <span>Labels</span>
                    <input
                      aria-label="Labels"
                      name="labels"
                      placeholder="design, review"
                    />
                  </label>
                  <label>
                    <span>Repeat</span>
                    <select aria-label="Repeat" defaultValue="" name="recurrence">
                      <option value="">Does not repeat</option>
                      <option value="daily">Every day</option>
                      <option value="weekly">Every week</option>
                      <option value="monthly">Every month</option>
                    </select>
                  </label>
                </div>
              </details>
            </form>

            {workspaceId && (
              <p className="feature-hint">
                New tasks will be visible to members of {selectedWorkspace?.name}.
              </p>
            )}

            <div className="planner-heading">
              <button
                className="button button-secondary"
                onClick={() => setWeekView((current) => !current)}
                type="button"
              >
                {weekView ? "Hide week planner" : "Open week planner"}
              </button>
              {weekView && (
                <div className="planner-navigation">
                  <button
                    aria-label="Previous week"
                    onClick={() => setWeekOffset((current) => current - 1)}
                    type="button"
                  >
                    ←
                  </button>
                  <span>
                    {formatDueDate(weekDates[0])} – {formatDueDate(weekDates[6])}
                  </span>
                  <button
                    aria-label="Next week"
                    onClick={() => setWeekOffset((current) => current + 1)}
                    type="button"
                  >
                    →
                  </button>
                </div>
              )}
            </div>
            {weekView && (
              <section className="week-planner" aria-label="Weekly task planner">
                {weekDates.map((date) => (
                  <article className="planner-day" key={date}>
                    <h3>
                      {new Intl.DateTimeFormat(undefined, {
                        weekday: "short",
                        month: "numeric",
                        day: "numeric",
                      }).format(new Date(`${date}T12:00:00`))}
                    </h3>
                    {tasks
                      .filter((task) => task.dueDate === date)
                      .map((task) => (
                        <button
                          className={`planner-task ${task.completed ? "planner-task-complete" : ""}`}
                          key={task.id}
                          onClick={() => setEditingTask(task)}
                          type="button"
                        >
                          {task.title}
                        </button>
                      ))}
                    {!tasks.some((task) => task.dueDate === date) && (
                      <p className="planner-empty">No tasks</p>
                    )}
                  </article>
                ))}
              </section>
            )}

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
              <div className="task-filters">
                <label>
                  <span className="sr-only">Due date filter</span>
                  <select
                    aria-label="Due date filter"
                    onChange={(event) =>
                      setDueFilter(event.target.value as DueFilter)
                    }
                    value={dueFilter}
                  >
                    <option value="any">Any due date</option>
                    <option value="today">Due today</option>
                    <option value="overdue">Overdue</option>
                  </select>
                </label>
                <label>
                  <span className="sr-only">Priority filter</span>
                  <select
                    aria-label="Priority filter"
                    onChange={(event) =>
                      setPriorityFilter(
                        event.target.value as TaskPriority | "any",
                      )
                    }
                    value={priorityFilter}
                  >
                    <option value="any">Any priority</option>
                    <option value="high">High priority</option>
                    <option value="medium">Medium priority</option>
                    <option value="low">Low priority</option>
                  </select>
                </label>
                <label>
                  <span className="sr-only">Project filter</span>
                  <select
                    aria-label="Project filter"
                    onChange={(event) => setProjectFilter(event.target.value)}
                    value={projectFilter}
                  >
                    <option value="any">All projects</option>
                    {projectNames.map((project) => (
                      <option key={project} value={project}>
                        {project}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="sr-only">Label filter</span>
                  <select
                    aria-label="Label filter"
                    onChange={(event) => setLabelFilter(event.target.value)}
                    value={labelFilter}
                  >
                    <option value="any">All labels</option>
                    {labelNames.map((label) => (
                      <option key={label} value={label}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="sr-only">Sort tasks</span>
                  <select
                    aria-label="Sort tasks"
                    onChange={(event) =>
                      setSort(event.target.value as TaskSort)
                    }
                    value={sort}
                  >
                    <option value="newest">Newest first</option>
                    <option value="due-date">Due date</option>
                    <option value="priority">Priority</option>
                    <option value="title">Title</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="saved-view-row">
              <label>
                <span>Saved view</span>
                <select
                  onChange={(event) => applySavedView(event.target.value)}
                  value={selectedSavedViewId}
                >
                  <option value="">Current filters</option>
                  {savedViews.map((view) => (
                    <option key={view.id} value={view.id}>
                      {view.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="button button-secondary"
                disabled={!selectedSavedViewId}
                onClick={() => void deleteSavedView()}
                type="button"
              >
                Delete view
              </button>
              <form className="save-view-form" onSubmit={saveCurrentView}>
                <input
                  aria-label="Saved view name"
                  maxLength={40}
                  onChange={(event) => setSavedViewName(event.target.value)}
                  placeholder="Name these filters"
                  required
                  value={savedViewName}
                />
                <button className="button button-secondary" type="submit">
                  Save view
                </button>
              </form>
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
                    className={`task-entry ${task.completed ? "task-entry-complete" : ""}`}
                    key={task.id}
                  >
                    <div className="task-row">
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
                      <div className="task-actions">
                        <button
                          aria-label={`Edit ${task.title}`}
                          className="edit-task"
                          onClick={() => setEditingTask(task)}
                          type="button"
                        >
                          Edit
                        </button>
                        <button
                          aria-label={`Delete ${task.title}`}
                          className="delete-task"
                          disabled={taskBusyId === task.id}
                          onClick={() => void deleteTask(task.id)}
                          type="button"
                        >
                          <span aria-hidden="true">×</span>
                        </button>
                      </div>
                    </div>
                    <div className="task-metadata">
                      <span className={`priority-chip priority-${task.priority}`}>
                        <i />
                        {task.priority} priority
                      </span>
                      {task.dueDate && (
                        <span
                          className={`due-chip ${
                            !task.completed && task.dueDate < today
                              ? "due-overdue"
                              : !task.completed && task.dueDate === today
                                ? "due-today"
                                : ""
                          }`}
                        >
                          <span aria-hidden="true">◷</span>
                          {!task.completed && task.dueDate < today
                            ? "Overdue · "
                            : !task.completed && task.dueDate === today
                              ? "Due today · "
                              : "Due "}
                          {formatDueDate(task.dueDate)}
                        </span>
                      )}
                      {task.project && (
                        <span className="project-chip">
                          <span aria-hidden="true">▦</span>
                          {task.project}
                        </span>
                      )}
                      {task.labels.map((label) => (
                        <span className="label-chip" key={label}>
                          {label}
                        </span>
                      ))}
                      {task.recurrence && (
                        <span className="recurrence-chip">
                          <span aria-hidden="true">↻</span>
                          {task.recurrence}
                        </span>
                      )}
                    </div>

                    {weekView && task.dueDate && (
                      <span className="sr-only">
                        Due {formatDueDate(task.dueDate)}
                      </span>
                    )}

                    <details
                      className="subtask-details"
                      open={task.subtasks.length > 0}
                    >
                      <summary>
                        <span>Subtasks</span>
                        <span className="subtask-progress">
                          {task.subtasks.filter((subtask) => subtask.completed).length}/
                          {task.subtasks.length}
                        </span>
                      </summary>
                      <div className="subtask-list">
                        {task.subtasks.map((subtask) => (
                          <div
                            className={`subtask-row ${subtask.completed ? "subtask-complete" : ""}`}
                            key={subtask.id}
                          >
                            <button
                              aria-label={
                                subtask.completed
                                  ? `Mark subtask ${subtask.title} as incomplete`
                                  : `Mark subtask ${subtask.title} as complete`
                              }
                              className={`subtask-checkbox ${subtask.completed ? "checked" : ""}`}
                              disabled={taskBusyId === task.id}
                              onClick={() =>
                                void toggleSubtask(task.id, subtask)
                              }
                              type="button"
                            >
                              {subtask.completed && "✓"}
                            </button>
                            <span>{subtask.title}</span>
                            <button
                              aria-label={`Remove subtask ${subtask.title}`}
                              className="remove-subtask"
                              disabled={taskBusyId === task.id}
                              onClick={() =>
                                void deleteSubtask(task.id, subtask.id)
                              }
                              type="button"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                        <form
                          className="subtask-add-form"
                          onSubmit={(event) =>
                            void addSubtask(task.id, event)
                          }
                        >
                          <input
                            aria-label={`Add subtask to ${task.title}`}
                            maxLength={120}
                            name="title"
                            placeholder="Add a subtask..."
                            required
                          />
                          <button
                            aria-label={`Save subtask for ${task.title}`}
                            disabled={taskBusyId === task.id}
                            type="submit"
                          >
                            +
                          </button>
                        </form>
                      </div>
                    </details>

                    <button
                      className="discussion-toggle"
                      onClick={() => void toggleDiscussion(task.id)}
                      type="button"
                    >
                      {discussionTaskId === task.id
                        ? "Hide comments & activity"
                        : "Comments & activity"}
                    </button>
                    {discussionTaskId === task.id && (
                      <div className="discussion-panel">
                        <section>
                          <h3>Comments</h3>
                          {taskComments.length ? (
                            taskComments.map((comment) => (
                              <article className="comment-item" key={comment.id}>
                                <strong>{comment.username}</strong>
                                <time dateTime={comment.createdAt}>
                                  {new Intl.DateTimeFormat(undefined, {
                                    dateStyle: "medium",
                                    timeStyle: "short",
                                  }).format(new Date(comment.createdAt))}
                                </time>
                                <p>{comment.content}</p>
                              </article>
                            ))
                          ) : (
                            <p className="feature-hint">No comments yet.</p>
                          )}
                          <form
                            className="comment-form"
                            onSubmit={(event) =>
                              void addTaskComment(task.id, event)
                            }
                          >
                            <input
                              aria-label="Write a comment"
                              maxLength={2000}
                              onChange={(event) =>
                                setCommentText(event.target.value)
                              }
                              placeholder="Write a comment..."
                              required
                              value={commentText}
                            />
                            <button className="button button-primary" type="submit">
                              Comment
                            </button>
                          </form>
                        </section>
                        <section>
                          <h3>Activity</h3>
                          {taskActivity.map((activity) => (
                            <p className="activity-item" key={activity.id}>
                              <strong>{activity.username}</strong>{" "}
                              {activity.action.replaceAll(".", " ")}
                            </p>
                          ))}
                        </section>
                      </div>
                    )}
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
                    {search ||
                    filter !== "all" ||
                    dueFilter !== "any" ||
                    priorityFilter !== "any" ||
                    projectFilter !== "any" ||
                    labelFilter !== "any"
                      ? "Try changing the search or filters."
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
      {editingTask && (
        <TaskEditDialog
            onCancel={() => setEditingTask(null)}
            onSave={saveTask}
            task={editingTask}
        />
      )}
    </main>
  );
}

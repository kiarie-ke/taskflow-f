export type TaskPriority = "low" | "medium" | "high";
export type TaskRecurrence = "daily" | "weekly" | "monthly";

export type TaskSubtask = {
  id: number;
  title: string;
  completed: boolean;
};

export type Task = {
  id: number;
  title: string;
  description?: string;
  completed: boolean;
  ownerId: number;
  workspaceId?: number;
  assigneeId?: number;
  dueDate?: string;
  priority: TaskPriority;
  project?: string;
  labels: string[];
  recurrence?: TaskRecurrence;
  subtasks: TaskSubtask[];
};

export type TaskUpdatePayload = {
  title: string;
  description: string;
  dueDate: string | null;
  priority: TaskPriority;
  project: string | null;
  labels: string[];
  recurrence: TaskRecurrence | null;
};

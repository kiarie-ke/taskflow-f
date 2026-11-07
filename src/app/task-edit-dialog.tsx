"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import type { Task, TaskPriority, TaskRecurrence, TaskUpdatePayload } from "./task-types";

type Props = {
  task: Task;
  onCancel: () => void;
  onSave: (taskId: number, changes: TaskUpdatePayload) => Promise<void>;
};

export function TaskEditDialog({ task, onCancel, onSave }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const dueDate = String(form.get("dueDate") ?? "");
    const recurrence = String(form.get("recurrence") ?? "");
    if (recurrence && !dueDate) {
      setError("Choose a due date for a recurring task.");
      return;
    }

    const priority = String(form.get("priority") ?? "medium") as TaskPriority;
    const recurrenceValue = recurrence
      ? (recurrence as TaskRecurrence)
      : null;
    const labels = [
      ...new Set(
        String(form.get("labels") ?? "")
          .split(",")
          .map((label) => label.trim())
          .filter(Boolean),
      ),
    ];

    setBusy(true);
    setError("");
    try {
      await onSave(task.id, {
        title: String(form.get("title") ?? "").trim(),
        description: String(form.get("description") ?? "").trim(),
        dueDate: dueDate || null,
        priority,
        project: String(form.get("project") ?? "").trim() || null,
        labels,
        recurrence: recurrenceValue,
      });
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Could not save your changes.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) {
          onCancel();
        }
      }}
    >
      <section
        aria-labelledby="edit-task-title"
        aria-modal="true"
        className="task-dialog"
        role="dialog"
      >
        <header className="dialog-header">
          <div>
            <span className="eyebrow">TASK DETAILS</span>
            <h2 id="edit-task-title">Edit task</h2>
          </div>
          <button
            aria-label="Close edit task dialog"
            className="dialog-close"
            disabled={busy}
            onClick={onCancel}
            type="button"
          >
            ×
          </button>
        </header>

        <form className="dialog-form" onSubmit={submit}>
          <label className="dialog-field dialog-field-wide">
            <span>Title</span>
            <input
              autoFocus
              defaultValue={task.title}
              maxLength={120}
              name="title"
              required
            />
          </label>
          <label className="dialog-field dialog-field-wide">
            <span>Description</span>
            <textarea
              defaultValue={task.description ?? ""}
              maxLength={1000}
              name="description"
              rows={3}
            />
          </label>
          <div className="dialog-field-grid">
            <label className="dialog-field">
              <span>Due date</span>
              <input
                defaultValue={task.dueDate ?? ""}
                name="dueDate"
                type="date"
              />
            </label>
            <label className="dialog-field">
              <span>Priority</span>
              <select defaultValue={task.priority} name="priority">
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
            <label className="dialog-field">
              <span>Project</span>
              <input
                defaultValue={task.project ?? ""}
                maxLength={60}
                name="project"
                placeholder="e.g. Product launch"
              />
            </label>
            <label className="dialog-field">
              <span>Repeat</span>
              <select defaultValue={task.recurrence ?? ""} name="recurrence">
                <option value="">Does not repeat</option>
                <option value="daily">Every day</option>
                <option value="weekly">Every week</option>
                <option value="monthly">Every month</option>
              </select>
            </label>
            <label className="dialog-field dialog-field-wide">
              <span>Labels</span>
              <input
                defaultValue={task.labels.join(", ")}
                name="labels"
                placeholder="Comma-separated, e.g. design, review"
              />
            </label>
          </div>

          {error && (
            <p className="form-alert" role="alert">
              {error}
            </p>
          )}

          <footer className="dialog-actions">
            <button
              className="button button-secondary"
              disabled={busy}
              onClick={onCancel}
              type="button"
            >
              Cancel
            </button>
            <button
              className="button button-primary"
              disabled={busy}
              type="submit"
            >
              {busy ? "Saving..." : "Save changes"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

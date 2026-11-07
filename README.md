# Taskflow frontend

The Next.js app provides account registration and sign-in, a private task
dashboard, team workspaces, collaboration, reminders, saved views, and a weekly
planner.

## Run locally

Start the NestJS API from the repository root with `JWT_SECRET` configured:

```bash
npm run start:dev
```

In another terminal:

```bash
cd frontend
cp .env.local.example .env.local
npm run dev
```

Open [http://localhost:3001](http://localhost:3001). The API defaults to
`http://localhost:3000`; set `NEXT_PUBLIC_API_URL` in `.env.local` if it runs
elsewhere. Configure the API's `FRONTEND_ORIGIN` to match the browser origin.

## Features

The dashboard supports task descriptions, due dates, priorities, projects,
labels, recurring tasks, subtasks, workspace assignment, comments, and task
activity. Use filters, sorting, saved views, and the week planner to organize
tasks. Workspace invitations and role management are available from the
workspace controls.

Reminder preferences include timezone, local reminder time, and email or push
channels. Email delivery requires the API's SMTP configuration; browser push
requires the API's VAPID configuration and browser support.

The app is installable as a PWA. It caches the application shell and stores
task data plus queued task/subtask changes in browser storage for offline use.
Queued changes replay when the browser is online; avoid editing the same task
concurrently on multiple devices while offline.

## Design and authentication

The interface uses the Bebas Neue display font and a Tailwind CSS theme based
on the provided palette: brown `#402212`, butter `#FFF99F`, oxblood `#850805`,
khaki `#84784E`, and forest `#1C241B`.

The access token is kept in the current browser session and sent as a bearer
token to protected API routes. The API also issues an HttpOnly refresh cookie
so the session can be renewed without storing a long-lived token in JavaScript.

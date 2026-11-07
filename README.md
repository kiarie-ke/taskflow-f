# Taskflow frontend

This Next.js app provides registration, login, and a private task dashboard for
the Task API.

## Run locally

1. Start the NestJS API from the repository root with `JWT_SECRET` configured:

   ```bash
   npm run start:dev
   ```

2. In another terminal, run the frontend:

   ```bash
   cd frontend
   cp .env.local.example .env.local
   npm run dev
   ```

3. Open [http://localhost:3001](http://localhost:3001).

The API defaults to `http://localhost:3000`; set `NEXT_PUBLIC_API_URL` in
`.env.local` if it runs elsewhere. The API allows the frontend origin
`http://localhost:3001` by default; configure `FRONTEND_ORIGIN` on the API for
another origin.

## Task features

The dashboard supports task descriptions, due dates, priorities, projects,
labels, recurring tasks, and subtasks. You can edit tasks, filter by status,
due date, priority, project, or label, and sort by newest, due date, priority,
or title. Due-today and overdue tasks are highlighted as in-app reminders;
notifications are not sent by email or push.

Recurring tasks require a due date. Completing one creates the next task in
its series, with the due date advanced by one day, week, or month.

## Design system

The interface uses the Bebas Neue display font and a Tailwind CSS theme based
on the provided palette: brown `#402212`, butter `#FFF99F`, oxblood `#850805`,
khaki `#84784E`, and forest `#1C241B`.

The access token is kept in the current browser session and sent as a bearer
token to protected API routes.

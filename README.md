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

The access token is kept in the current browser session and sent as a bearer
token to protected API routes.

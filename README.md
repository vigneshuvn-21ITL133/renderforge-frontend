# Renderforge Web

Bun + TypeScript + Three.js frontend for Renderforge. Upload a photo, the
request goes through this server to your FastAPI backend (which calls the GPU
inference service), and the generated 3D model appears in an interactive viewer.

```
browser ──/api/*──▶ Bun server (this project) ──▶ FastAPI backend ──▶ inference (local GPU)
   ▲                  serves the app,
   └── Three.js       holds the login in httpOnly cookies
```

## Run it

You need the backend (`renderforgebackend`) and the inference service running.

```bash
bun install
cp .env.example .env        # set RF_BACKEND_URL if the backend is not on :8000
bun run dev                 # http://localhost:3000, hot reload
bun run start               # production mode
bun run typecheck
```

## What it does

- **Accounts:** sign up / sign in. Tokens are stored in `httpOnly`, `SameSite=Lax`
  cookies, so page scripts never see them. The server refreshes the access token
  on a 401 by itself.
- **Upload:** drag and drop, click, or paste. PNG, JPG or WEBP up to 10 MB, checked
  in the browser and again at the server.
- **Settings:** quality (Fast / Balanced / Detailed) and format (GLB / OBJ).
- **Progress:** upload → queue → generate → load, with an elapsed timer. Failures
  show the backend's reason and a retry button.
- **History:** your past generations. Click one to reopen it, or to resume watching
  one that is still running.
- **Viewer:** orbit, zoom and pan; Shaded / Clay / Normals; wireframe; grid;
  auto-rotate; four backdrops; light slider; reset view; 90° rotate (for meshes
  that come out lying down); transparent PNG screenshot; open a local GLB/OBJ;
  download the model. Soft ground shadow and studio lighting. Vertex colours show
  automatically when the mesh has them.
- **Keys:** `R` reset view, `W` wireframe, `G` grid, `A` auto-rotate.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `RF_BACKEND_URL` | `http://localhost:8000` | FastAPI backend |
| `PORT` | `3000` | Web server port |
| `RF_COOKIE_SECURE` | `false` | Force the `Secure` flag on cookies (use behind HTTPS) |
| `RF_MAX_UPLOAD_MB` | `10` | Upload limit enforced at the proxy |

## What the proxy exposes

Only these paths are forwarded. Everything else under `/api` is a 404.

| Browser calls | Goes to backend |
|---|---|
| `POST /api/auth/login` (JSON) | `POST /auth/login` (converted to the form the backend expects) |
| `POST /api/auth/signup` | `POST /auth/signup` |
| `POST /api/auth/logout` | clears the cookies |
| `GET /api/auth/me` | `GET /auth/me` |
| `GET, POST /api/generations` | same path |
| `GET /api/generations/{uuid}` and `/download` | same path |

Cross-origin POSTs are rejected, and ids must be valid UUIDs.

## Project layout

```
server.ts          Bun server: static app + /api proxy + cookie sessions
index.html         page structure
src/main.ts        UI logic: upload, polling, history, auth
src/viewer.ts      Three.js scene, lighting, materials, camera
src/api.ts         typed client for /api
src/styles.css     theme
```

## How it was tested

Run against your real FastAPI backend (SQLite, with a stand-in for the GPU service
that returns a real GLB) and headless Chromium: 36 checks covering sign up and
login, cookies, upload, generation through the proxy, rendering, every viewer
control, download, session restore, failure handling, logout, proxy rules and
a phone-width layout.

**Not tested here:** real TripoSR / Hunyuan3D output, PostgreSQL, and a real GPU.
Meshes from your pipeline may appear in a different orientation or with different
colour intensity than the test model. Use the rotate button if one is lying down.

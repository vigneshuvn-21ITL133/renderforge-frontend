/** Typed client for the Bun proxy. The browser only ever calls /api/*. */

export type Quality = "low" | "medium" | "high";
export type OutputFormat = "glb" | "obj";
export type GenerationStatus = "pending" | "processing" | "completed" | "failed";

export interface User {
  id: string;
  email: string;
  full_name: string | null;
  created_at: string;
}

export interface Generation {
  id: string;
  status: GenerationStatus;
  quality: Quality;
  output_format: OutputFormat;
  source_filename: string;
  vertex_count: number | null;
  face_count: number | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  download_url: string | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** FastAPI sends `detail` as a string, or as a list of {msg} objects for validation errors. */
function describeError(body: unknown, fallback: string): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => (item && typeof item === "object" && "msg" in item ? String((item as { msg: unknown }).msg) : ""))
      .filter(Boolean);
    if (messages.length) return messages.join(". ");
  }
  return fallback;
}

async function send(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { credentials: "same-origin", ...init });
  } catch {
    throw new ApiError("Cannot reach the server. Check your connection.", 0);
  }
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(describeError(body, `Request failed (${res.status})`), res.status);
  }
  return res;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  async me(): Promise<User> {
    return (await send("/auth/me")).json();
  },
  async login(email: string, password: string): Promise<User> {
    return (await send("/auth/login", json({ email, password }))).json();
  },
  async signup(email: string, password: string, fullName: string): Promise<User> {
    return (await send("/auth/signup", json({ email, password, full_name: fullName || null }))).json();
  },
  async logout(): Promise<void> {
    await send("/auth/logout", { method: "POST" });
  },
  async createGeneration(image: File, quality: Quality, format: OutputFormat): Promise<Generation> {
    const form = new FormData();
    form.append("image", image);
    form.append("quality", quality);
    form.append("output_format", format);
    return (await send("/generations", { method: "POST", body: form })).json();
  },
  async getGeneration(id: string): Promise<Generation> {
    return (await send(`/generations/${id}`)).json();
  },
  async listGenerations(): Promise<Generation[]> {
    return (await send("/generations?limit=30")).json();
  },
  async downloadMesh(id: string): Promise<ArrayBuffer> {
    return (await send(`/generations/${id}/download`)).arrayBuffer();
  },
};

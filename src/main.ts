import { ApiError, api, type Generation, type OutputFormat, type Quality, type User } from "./api";
import { Viewer, type Backdrop, type MeshFormat, type ViewMode } from "./viewer";

// ------------------------------------------------------------------ helpers

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const MAX_MB = 10;
const ACCEPTED = ["image/png", "image/jpeg", "image/webp"];
const QUALITY_HINTS: Record<Quality, string> = {
  low: "Quickest. Good for checking the shape before a final run.",
  medium: "A balance of speed and detail. Start here.",
  high: "Highest detail. Takes the longest on your GPU.",
};

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The API may send timestamps without a timezone. Treat those as UTC, like the backend writes them. */
function parseServerDate(iso: string): Date {
  return new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`);
}

function timeAgo(iso: string): string {
  const seconds = Math.round((parseServerDate(iso).getTime() - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Radio-style button group. Returns a setter so state can also be changed from code. */
function segmented(group: HTMLElement, onChange: (value: string) => void, attr = "value"): (value: string) => void {
  const buttons = [...group.querySelectorAll<HTMLButtonElement>("button")];
  const select = (value: string) => {
    for (const b of buttons) {
      const active = b.dataset[attr] === value;
      b.setAttribute(group.getAttribute("role") === "tablist" ? "aria-selected" : "aria-checked", String(active));
      b.classList.toggle("active", active);
    }
  };
  for (const b of buttons) {
    b.addEventListener("click", () => {
      const value = b.dataset[attr];
      if (!value) return;
      select(value);
      onChange(value);
    });
  }
  return select;
}

function toggle(button: HTMLElement, onChange: (on: boolean) => void): (on: boolean) => void {
  const set = (on: boolean) => {
    button.setAttribute("aria-pressed", String(on));
    button.classList.toggle("active", on);
  };
  button.addEventListener("click", () => {
    const on = button.getAttribute("aria-pressed") !== "true";
    set(on);
    onChange(on);
  });
  set(button.getAttribute("aria-pressed") === "true");
  return set;
}

// -------------------------------------------------------------------- state

const state = {
  user: null as User | null,
  file: null as File | null,
  quality: "medium" as Quality,
  format: "glb" as OutputFormat,
  history: [] as Generation[],
  activeId: null as string | null,
  mesh: null as { data: ArrayBuffer; format: MeshFormat; name: string } | null,
};
let watchToken = 0;
let timer = 0;
let previewUrl: string | null = null;

// ----------------------------------------------------------------- elements

const el = {
  dropzone: $("dropzone"),
  fileInput: $<HTMLInputElement>("file-input"),
  dzEmpty: $("dz-empty"),
  dzPreview: $("dz-preview"),
  previewImg: $<HTMLImageElement>("preview-img"),
  fileName: $("file-name"),
  fileMeta: $("file-meta"),
  removeFile: $("remove-file"),
  qualityHint: $("quality-hint"),
  generate: $<HTMLButtonElement>("generate-btn"),
  generateLabel: $("generate-label"),
  historyList: $("history-list"),
  historyEmpty: $("history-empty"),
  refreshHistory: $("refresh-history"),
  userChip: $("user-chip"),
  userEmail: $("user-email"),
  userAvatar: $("user-avatar"),
  signin: $("signin-btn"),
  logout: $("logout-btn"),
  viewer: $("viewer"),
  overlay: $("overlay"),
  ovIdle: $("ov-idle"),
  ovWorking: $("ov-working"),
  ovError: $("ov-error"),
  ovNoGl: $("ov-nogl"),
  ovTitle: $("ov-title"),
  ovElapsed: $("ov-elapsed"),
  ovErrorText: $("ov-error-text"),
  stepper: $("stepper"),
  retry: $("retry-btn"),
  stats: $("stats"),
  statVerts: $("stat-verts"),
  statTris: $("stat-tris"),
  statColors: $("stat-colors"),
  btnDownload: $<HTMLButtonElement>("btn-download"),
  downloadLabel: $("download-label"),
  btnShot: $("btn-shot"),
  btnReset: $("btn-reset"),
  btnOrient: $("btn-orient"),
  btnOpen: $("btn-open"),
  openInput: $<HTMLInputElement>("open-input"),
  exposure: $<HTMLInputElement>("exposure"),
  toasts: $("toasts"),
  authDialog: $<HTMLDialogElement>("auth-dialog"),
  authForm: $<HTMLFormElement>("auth-form"),
  authTitle: $("auth-title"),
  authClose: $("auth-close"),
  authName: $<HTMLInputElement>("auth-name"),
  nameRow: $("name-row"),
  authEmail: $<HTMLInputElement>("auth-email"),
  authPassword: $<HTMLInputElement>("auth-password"),
  authError: $("auth-error"),
  authSubmit: $<HTMLButtonElement>("auth-submit"),
};

// ------------------------------------------------------------------- viewer

let viewer: Viewer | null = null;
try {
  viewer = new Viewer(el.viewer);
} catch (error) {
  console.error("WebGL init failed", error);
}

// -------------------------------------------------------------------- toasts

function toast(message: string, kind: "info" | "error" | "ok" = "info"): void {
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.textContent = message;
  el.toasts.append(node);
  setTimeout(() => {
    node.classList.add("leaving");
    setTimeout(() => node.remove(), 250);
  }, 4500);
}

// ------------------------------------------------------------------ overlay

type OverlayState = "idle" | "working" | "error" | null;

function showOverlay(which: OverlayState): void {
  el.ovIdle.hidden = which !== "idle";
  el.ovWorking.hidden = which !== "working";
  el.ovError.hidden = which !== "error";
  el.overlay.classList.toggle("visible", which !== null || !viewer);
  el.overlay.classList.toggle("blocking", which === "working");
  el.overlay.classList.toggle("idle", which === "idle");
}

function setStage(step: 0 | 1 | 2 | 3): void {
  const titles = ["Uploading your image…", "Waiting for the GPU…", "Building your 3D model…", "Loading the preview…"];
  el.ovTitle.textContent = titles[step] ?? "Working…";
  el.stepper.querySelectorAll("li").forEach((li, index) => {
    li.classList.toggle("done", index < step);
    li.classList.toggle("current", index === step);
  });
}

function startTimer(): void {
  stopTimer();
  const started = Date.now();
  el.ovElapsed.textContent = "0s";
  timer = window.setInterval(() => {
    el.ovElapsed.textContent = `${Math.floor((Date.now() - started) / 1000)}s`;
  }, 1000);
}

function stopTimer(): void {
  clearInterval(timer);
}

function showError(message: string): void {
  stopTimer();
  setBusy(false);
  el.ovErrorText.textContent = message;
  el.retry.hidden = !state.file;
  showOverlay("error");
}

function setBusy(busy: boolean): void {
  el.generate.disabled = busy;
  el.generate.classList.toggle("loading", busy);
  el.generateLabel.textContent = busy ? "Generating…" : "Generate model";
}

// -------------------------------------------------------------------- image

function validate(file: File): string | null {
  if (!ACCEPTED.includes(file.type)) return "Use a PNG, JPG or WEBP image.";
  if (file.size > MAX_MB * 1024 * 1024) return `That image is ${formatBytes(file.size)}. The limit is ${MAX_MB} MB.`;
  return null;
}

function setFile(file: File | null): void {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  state.file = file;
  el.dzEmpty.hidden = !!file;
  el.dzPreview.hidden = !file;
  el.dropzone.classList.toggle("has-file", !!file);
  if (!file) return;

  previewUrl = URL.createObjectURL(file);
  el.previewImg.src = previewUrl;
  el.fileName.textContent = file.name;
  el.fileMeta.textContent = formatBytes(file.size);
  el.previewImg.onload = () => {
    el.fileMeta.textContent = `${el.previewImg.naturalWidth}×${el.previewImg.naturalHeight} · ${formatBytes(file.size)}`;
  };
}

function acceptFile(file: File | undefined): void {
  if (!file) return;
  const problem = validate(file);
  if (problem) return toast(problem, "error");
  setFile(file);
}

el.dropzone.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("#remove-file")) return;
  el.fileInput.click();
});
el.dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    el.fileInput.click();
  }
});
el.fileInput.addEventListener("change", () => {
  acceptFile(el.fileInput.files?.[0]);
  el.fileInput.value = "";
});
el.removeFile.addEventListener("click", (e) => {
  e.stopPropagation();
  setFile(null);
});
for (const type of ["dragenter", "dragover"]) {
  el.dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    el.dropzone.classList.add("dragging");
  });
}
for (const type of ["dragleave", "drop"]) {
  el.dropzone.addEventListener(type, () => el.dropzone.classList.remove("dragging"));
}
el.dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  acceptFile((e as DragEvent).dataTransfer?.files?.[0]);
});
// Stop the browser from navigating to a file that is dropped outside the dropzone.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());
window.addEventListener("paste", (e) => {
  const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
  if (file) acceptFile(file);
});

// ----------------------------------------------------------------- settings

segmented($("quality-group"), (v) => {
  state.quality = v as Quality;
  el.qualityHint.textContent = QUALITY_HINTS[state.quality];
})(state.quality);
el.qualityHint.textContent = QUALITY_HINTS[state.quality];

segmented($("format-group"), (v) => (state.format = v as OutputFormat))(state.format);

// ------------------------------------------------------------ viewer toolbar

segmented($("mode-group"), (v) => viewer?.setMode(v as ViewMode), "mode")("shaded");
toggle($("btn-wire"), (on) => viewer?.setWireframe(on));
toggle($("btn-grid"), (on) => viewer?.setGrid(on));
const setRotate = toggle($("btn-rotate"), (on) => viewer?.setAutoRotate(on));
segmented($("bg-group"), (v) => viewer?.setBackdrop(v as Backdrop), "bg")("studio");
el.exposure.addEventListener("input", () => viewer?.setExposure(Number(el.exposure.value)));

el.btnReset.addEventListener("click", () => viewer?.resetView());
el.btnOrient.addEventListener("click", () => viewer?.rotateQuarter());
el.btnShot.addEventListener("click", async () => {
  if (!viewer) return;
  try {
    download(await viewer.screenshot(), "renderforge-view.png");
  } catch {
    toast("Could not capture the view.", "error");
  }
});

el.btnDownload.addEventListener("click", () => {
  const mesh = state.mesh;
  if (!mesh) return;
  const type = mesh.format === "glb" ? "model/gltf-binary" : "model/obj";
  download(new Blob([mesh.data], { type }), mesh.name);
});

el.btnOpen.addEventListener("click", () => el.openInput.click());
el.openInput.addEventListener("change", async () => {
  const file = el.openInput.files?.[0];
  el.openInput.value = "";
  if (!file) return;
  const format = file.name.toLowerCase().endsWith(".obj") ? "obj" : file.name.toLowerCase().endsWith(".glb") ? "glb" : null;
  if (!format) return toast("Open a .glb or .obj file.", "error");
  watchToken++;
  setBusy(false);
  state.activeId = null;
  renderHistory();
  await showMesh(await file.arrayBuffer(), format, file.name);
});

window.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement;
  if (e.metaKey || e.ctrlKey || e.altKey || el.authDialog.open) return;
  if (target.matches("input, textarea, select")) return;
  const click: Record<string, string> = { r: "btn-reset", w: "btn-wire", g: "btn-grid", a: "btn-rotate" };
  const id = click[e.key.toLowerCase()];
  if (id) $(id).click();
});

// --------------------------------------------------------------------- mesh

async function showMesh(data: ArrayBuffer, format: MeshFormat, name: string): Promise<void> {
  if (!viewer) return;
  try {
    const info = await viewer.load(data, format);
    state.mesh = { data, format, name };
    el.stats.hidden = false;
    el.statVerts.textContent = info.vertices.toLocaleString();
    el.statTris.textContent = info.triangles.toLocaleString();
    el.statColors.hidden = !info.hasColors;
    el.btnDownload.disabled = false;
    el.downloadLabel.textContent = `Download .${format}`;
    stopTimer();
    showOverlay(null);
  } catch (error) {
    console.error(error);
    showError("The model file could not be read. Try generating it again.");
  }
}

function clearMesh(): void {
  viewer?.clear();
  state.mesh = null;
  el.stats.hidden = true;
  el.btnDownload.disabled = true;
  el.downloadLabel.textContent = "Download";
}

// ------------------------------------------------------------ generation flow

function upsert(gen: Generation): void {
  const index = state.history.findIndex((g) => g.id === gen.id);
  if (index >= 0) state.history[index] = gen;
  else state.history.unshift(gen);
  renderHistory();
}

async function watch(id: string): Promise<void> {
  const token = ++watchToken;
  setBusy(true);
  showOverlay("working");
  startTimer();
  let delay = 1200;
  let failures = 0;

  while (token === watchToken) {
    let gen: Generation;
    try {
      gen = await api.getGeneration(id);
      failures = 0;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return handleUnauthorized();
      if (error instanceof ApiError && error.status === 404) return showError("That generation no longer exists.");
      if (++failures >= 4) return showError(error instanceof Error ? error.message : "Lost contact with the server.");
      await sleep(2000);
      continue;
    }
    if (token !== watchToken) return;
    upsert(gen);

    if (gen.status === "completed") return finish(gen, token);
    if (gen.status === "failed") return showError(gen.error_message || "The model could not be generated.");

    setStage(gen.status === "pending" ? 1 : 2);
    await sleep(delay);
    delay = Math.min(delay * 1.2, 3500);
  }
}

async function finish(gen: Generation, token: number): Promise<void> {
  setStage(3);
  try {
    const data = await api.downloadMesh(gen.id);
    if (token !== watchToken) return;
    await showMesh(data, gen.output_format, `renderforge-${gen.id.slice(0, 8)}.${gen.output_format}`);
    setBusy(false);
    toast("Model ready.", "ok");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return handleUnauthorized();
    showError(error instanceof Error ? error.message : "The model could not be downloaded.");
  }
}

async function generate(): Promise<void> {
  if (!state.user) return openAuth("login");
  if (!state.file) return toast("Choose an image first.", "info");

  watchToken++; // stop any earlier polling
  setBusy(true);
  showOverlay("working");
  setStage(0);
  startTimer();
  try {
    const gen = await api.createGeneration(state.file, state.quality, state.format);
    state.activeId = gen.id;
    upsert(gen);
    await watch(gen.id);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return handleUnauthorized();
    showError(error instanceof Error ? error.message : "Upload failed.");
  }
}

el.generate.addEventListener("click", () => void generate());
el.retry.addEventListener("click", () => void generate());

// ------------------------------------------------------------------ history

function renderHistory(): void {
  el.historyList.replaceChildren();
  el.historyEmpty.hidden = state.history.length > 0;
  if (state.user && state.history.length === 0) el.historyEmpty.textContent = "No models yet. Models you generate appear here.";

  for (const gen of state.history) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-item";
    button.classList.toggle("active", gen.id === state.activeId);

    const dot = Object.assign(document.createElement("span"), { className: `dot ${gen.status}` });
    const body = document.createElement("span");
    body.className = "history-body";
    const name = Object.assign(document.createElement("span"), { className: "history-name", textContent: gen.source_filename });
    const detail =
      gen.status === "completed"
        ? `${(gen.face_count ?? 0).toLocaleString()} triangles`
        : gen.status === "failed"
          ? "Failed"
          : gen.status === "processing"
            ? "Generating…"
            : "Queued";
    const meta = Object.assign(document.createElement("span"), {
      className: "history-meta",
      textContent: `${detail} · ${gen.quality} · ${gen.output_format.toUpperCase()} · ${timeAgo(gen.created_at)}`,
    });
    body.append(name, meta);
    button.append(dot, body);
    button.addEventListener("click", () => void openHistory(gen));
    item.append(button);
    el.historyList.append(item);
  }
}

async function openHistory(gen: Generation): Promise<void> {
  state.activeId = gen.id;
  renderHistory();
  if (gen.status === "failed") {
    watchToken++;
    return showError(gen.error_message || "This generation failed.");
  }
  await watch(gen.id); // completed ones resolve on the first poll, in-flight ones keep going
}

async function loadHistory(): Promise<void> {
  if (!state.user) return;
  try {
    state.history = await api.listGenerations();
    renderHistory();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return handleUnauthorized();
    toast("Could not load your history.", "error");
  }
}

el.refreshHistory.addEventListener("click", () => void loadHistory());

// --------------------------------------------------------------------- auth

let authTab: "login" | "signup" = "login";

const setAuthTab = segmented(
  $("auth-tabs"),
  (v) => applyAuthTab(v as "login" | "signup"),
  "tab",
);

function applyAuthTab(tab: "login" | "signup"): void {
  authTab = tab;
  el.nameRow.hidden = tab !== "signup";
  el.authSubmit.textContent = tab === "login" ? "Sign in" : "Create account";
  el.authPassword.autocomplete = tab === "login" ? "current-password" : "new-password";
  el.authError.hidden = true;
}

function openAuth(tab: "login" | "signup"): void {
  setAuthTab(tab);
  applyAuthTab(tab);
  if (!el.authDialog.open) el.authDialog.showModal();
  el.authEmail.focus();
}

function setUser(user: User | null): void {
  state.user = user;
  el.userChip.hidden = !user;
  el.signin.hidden = !!user;
  if (user) {
    el.userEmail.textContent = user.full_name || user.email;
    el.userAvatar.textContent = (user.full_name || user.email).charAt(0).toUpperCase();
  } else {
    state.history = [];
    state.activeId = null;
    el.historyEmpty.textContent = "Sign in to see your saved models.";
    renderHistory();
  }
}

function handleUnauthorized(): void {
  stopTimer();
  setBusy(false);
  showOverlay(state.mesh ? null : "idle");
  setUser(null);
  toast("Please sign in again.", "info");
  openAuth("login");
}

el.signin.addEventListener("click", () => openAuth("login"));
el.authClose.addEventListener("click", () => el.authDialog.close());
el.authDialog.addEventListener("click", (e) => {
  if (e.target === el.authDialog) el.authDialog.close(); // click on the backdrop
});

el.authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = el.authEmail.value.trim();
  const password = el.authPassword.value;
  const fail = (message: string) => {
    el.authError.textContent = message;
    el.authError.hidden = false;
  };
  if (!email || !el.authEmail.checkValidity()) return fail("Enter a valid email address.");
  if (authTab === "signup" && password.length < 8) return fail("Use at least 8 characters for your password.");
  if (!password) return fail("Enter your password.");

  el.authSubmit.disabled = true;
  el.authError.hidden = true;
  try {
    const user =
      authTab === "login" ? await api.login(email, password) : await api.signup(email, password, el.authName.value.trim());
    el.authPassword.value = "";
    el.authDialog.close();
    setUser(user);
    toast(authTab === "login" ? "Signed in." : "Account created.", "ok");
    await loadHistory();
  } catch (error) {
    fail(error instanceof Error ? error.message : "Could not sign in.");
  } finally {
    el.authSubmit.disabled = false;
  }
});

el.logout.addEventListener("click", async () => {
  try {
    await api.logout();
  } finally {
    watchToken++;
    setBusy(false);
    setUser(null);
    clearMesh();
    showOverlay("idle");
    toast("Signed out.");
  }
});

// -------------------------------------------------------------------- start

setRotate(false);
showOverlay(viewer ? "idle" : null);
if (!viewer) el.ovNoGl.hidden = false;

(async () => {
  try {
    setUser(await api.me());
    await loadHistory();
  } catch {
    setUser(null); // not signed in yet
  }
})();

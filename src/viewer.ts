/** Three.js viewer: orbit camera, studio lighting, soft shadow, shading modes, screenshots. */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

export type ViewMode = "shaded" | "clay" | "normals";
export type Backdrop = "studio" | "light" | "graphite" | "black";
export type MeshFormat = "glb" | "obj";

export interface ModelInfo {
  vertices: number;
  triangles: number;
  hasColors: boolean;
}

type Mat = THREE.Material | THREE.Material[];

const VIEW_DIRECTION = new THREE.Vector3(1, 0.55, 1.5).normalize();
const MODEL_SIZE = 2; // the longest side of every model is scaled to this

export class Viewer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(35, 1, 0.05, 200);
  private readonly controls: OrbitControls;
  private readonly clock = new THREE.Clock();
  private readonly resizeObserver: ResizeObserver;
  private readonly grid: THREE.GridHelper;
  private readonly floor: THREE.Mesh;
  private readonly clay = new THREE.MeshStandardMaterial({ color: 0xcfd2d6, roughness: 0.85, metalness: 0 });
  private readonly normals = new THREE.MeshNormalMaterial();
  private readonly originals = new Map<THREE.Mesh, Mat>();
  private readonly reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  private model: THREE.Object3D | null = null;
  private idle: THREE.Mesh | null = null;
  private mode: ViewMode = "shaded";
  private wireframe = false;
  private quarterTurns = 0;
  private dirty = true;
  private raf = 0;
  private goal: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private home = { position: new THREE.Vector3(3, 1.7, 4.5), target: new THREE.Vector3(0, 0.8, 0) };

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = "viewer-canvas";
    this.container.prepend(this.renderer.domElement);

    // Image-based light from a neutral studio room, plus one key light for the shadow.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(3, 5, 2.5);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = key.shadow.camera.bottom = -3;
    key.shadow.camera.right = key.shadow.camera.top = 3;
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 14;
    key.shadow.bias = -0.0004;
    key.shadow.radius = 5;
    this.scene.add(key);

    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(24, 24),
      new THREE.ShadowMaterial({ opacity: 0.38 }),
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);

    this.grid = new THREE.GridHelper(8, 16, 0xffffff, 0xffffff);
    const gridMaterial = this.grid.material as THREE.LineBasicMaterial;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.16;
    gridMaterial.depthWrite = false;
    this.grid.position.y = 0.002;
    this.scene.add(this.grid);
    this.setBackdrop("studio");

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.autoRotateSpeed = 2.2;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.addEventListener("start", () => (this.goal = null)); // user input cancels a camera move

    this.camera.position.copy(this.home.position);
    this.controls.target.copy(this.home.target);
    this.showIdle();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();
    this.raf = requestAnimationFrame(this.tick);
  }

  // ------------------------------------------------------------- loading

  async load(buffer: ArrayBuffer, format: MeshFormat): Promise<ModelInfo> {
    const object =
      format === "glb"
        ? (await new GLTFLoader().parseAsync(buffer, "")).scene
        : new OBJLoader().parse(new TextDecoder().decode(buffer));

    this.disposeModel();
    this.hideIdle();
    this.quarterTurns = 0;

    let vertices = 0;
    let triangles = 0;
    let hasColors = false;

    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const geometry = child.geometry as THREE.BufferGeometry;
      if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();

      const colored = !!geometry.getAttribute("color");
      hasColors ||= colored;
      vertices += geometry.getAttribute("position").count;
      triangles += (geometry.index ? geometry.index.count : geometry.getAttribute("position").count) / 3;

      child.material = this.normalizeMaterial(child.material, colored);
      child.castShadow = true;
      this.originals.set(child, child.material);
    });

    this.model = object;
    this.scene.add(object);
    this.layoutModel();
    this.applyMaterials();
    this.frameCamera(true);
    return { vertices, triangles, hasColors };
  }

  clear(): void {
    this.disposeModel();
    this.showIdle();
    this.goal = { position: this.home.position.clone(), target: this.home.target.clone() };
    this.dirty = true;
  }

  // ------------------------------------------------------------ controls

  setMode(mode: ViewMode): void {
    this.mode = mode;
    this.applyMaterials();
  }

  setWireframe(on: boolean): void {
    this.wireframe = on;
    this.applyMaterials();
  }

  setGrid(on: boolean): void {
    this.grid.visible = on;
    this.dirty = true;
  }

  setAutoRotate(on: boolean): void {
    this.controls.autoRotate = on && !this.reducedMotion;
    this.dirty = true;
  }

  setExposure(value: number): void {
    this.renderer.toneMappingExposure = value;
    this.dirty = true;
  }

  setBackdrop(backdrop: Backdrop): void {
    this.container.classList.remove("bg-studio", "bg-light", "bg-graphite", "bg-black");
    this.container.classList.add(`bg-${backdrop}`);
    const dark = backdrop === "graphite" || backdrop === "black";
    const gm = this.grid.material as THREE.LineBasicMaterial;
    gm.color.set(dark ? 0xffffff : 0x15202b);
    gm.opacity = dark ? 0.14 : backdrop === "studio" ? 0.16 : 0.12;
    (this.floor.material as THREE.ShadowMaterial).opacity = dark ? 0.5 : backdrop === "studio" ? 0.32 : 0.2;
    this.dirty = true;
  }

  /** Spin the model a quarter turn about X. TripoSR-style meshes sometimes come out lying down. */
  rotateQuarter(): void {
    if (!this.model) return;
    this.quarterTurns = (this.quarterTurns + 1) % 4;
    this.layoutModel();
    this.frameCamera(true);
  }

  resetView(): void {
    this.frameCamera(true);
  }

  screenshot(): Promise<Blob> {
    this.renderer.render(this.scene, this.camera); // toBlob must run in the same task as the render
    return new Promise((resolve, reject) =>
      this.renderer.domElement.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Screenshot failed"))), "image/png"),
    );
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.disposeModel();
    this.clay.dispose();
    this.normals.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ------------------------------------------------------------ internals

  /** Gives every mesh a physically based material that shows vertex colours when they exist. */
  private normalizeMaterial(material: Mat, hasColors: boolean): Mat {
    const convert = (m: THREE.Material): THREE.Material => {
      if (m instanceof THREE.MeshStandardMaterial) {
        m.side = THREE.DoubleSide;
        if (hasColors) m.vertexColors = true;
        return m;
      }
      const base = (m as THREE.MeshPhongMaterial).color ?? new THREE.Color(0xcfcbc4);
      m.dispose();
      return new THREE.MeshStandardMaterial({
        color: hasColors ? 0xffffff : base,
        vertexColors: hasColors,
        roughness: 0.7,
        metalness: 0.05,
        side: THREE.DoubleSide,
      });
    };
    return Array.isArray(material) ? material.map(convert) : convert(material);
  }

  private applyMaterials(): void {
    for (const [mesh, original] of this.originals) {
      const active: Mat = this.mode === "clay" ? this.clay : this.mode === "normals" ? this.normals : original;
      mesh.material = active;
      for (const m of Array.isArray(active) ? active : [active]) {
        (m as THREE.Material & { wireframe?: boolean }).wireframe = this.wireframe;
        m.needsUpdate = true;
      }
    }
    this.dirty = true;
  }

  /** Centres the model on the floor and scales it so its longest side is MODEL_SIZE. */
  private layoutModel(): void {
    const model = this.model;
    if (!model) return;
    model.rotation.set((this.quarterTurns * Math.PI) / 2, 0, 0);
    model.scale.setScalar(1);
    model.position.set(0, 0, 0);
    model.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const scale = MODEL_SIZE / Math.max(size.x, size.y, size.z, 1e-6);
    model.scale.setScalar(scale);
    model.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
    model.updateMatrixWorld(true);

    const fitted = new THREE.Box3().setFromObject(model);
    const fittedSize = fitted.getSize(new THREE.Vector3());
    const radius = fittedSize.length() / 2;
    const distance = (radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.05;
    const target = new THREE.Vector3(0, fittedSize.y / 2, 0);
    this.home = { position: target.clone().add(VIEW_DIRECTION.clone().multiplyScalar(distance)), target };
    this.controls.minDistance = radius * 0.7;
    this.controls.maxDistance = radius * 9;
    this.dirty = true;
  }

  private frameCamera(animate: boolean): void {
    if (animate && !this.reducedMotion) {
      this.goal = { position: this.home.position.clone(), target: this.home.target.clone() };
    } else {
      this.camera.position.copy(this.home.position);
      this.controls.target.copy(this.home.target);
    }
    this.dirty = true;
  }

  private showIdle(): void {
    if (this.idle) return;
    this.idle = new THREE.Mesh(
      new THREE.TorusKnotGeometry(0.55, 0.17, 160, 18),
      new THREE.MeshBasicMaterial({ color: 0x0b7a75, wireframe: true, transparent: true, opacity: 0.55 }),
    );
    this.idle.position.y = 0.95;
    this.scene.add(this.idle);
  }

  private hideIdle(): void {
    if (!this.idle) return;
    this.scene.remove(this.idle);
    this.idle.geometry.dispose();
    (this.idle.material as THREE.Material).dispose();
    this.idle = null;
  }

  private disposeModel(): void {
    if (!this.model) return;
    this.scene.remove(this.model);
    this.model.traverse((child) => {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    });
    for (const original of this.originals.values()) {
      for (const m of Array.isArray(original) ? original : [original]) m.dispose();
    }
    this.originals.clear();
    this.model = null;
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  private tick = (): void => {
    this.raf = requestAnimationFrame(this.tick);
    const dt = Math.min(this.clock.getDelta(), 0.1);

    if (this.goal) {
      const k = 1 - Math.exp(-7 * dt);
      this.camera.position.lerp(this.goal.position, k);
      this.controls.target.lerp(this.goal.target, k);
      if (this.camera.position.distanceTo(this.goal.position) < 0.002) this.goal = null;
      this.dirty = true;
    }
    if (this.idle && !this.reducedMotion) {
      this.idle.rotation.y += dt * 0.45;
      this.idle.rotation.x += dt * 0.12;
      this.dirty = true;
    }

    const moved = this.controls.update(dt);
    if (moved || this.dirty) {
      this.dirty = false;
      this.renderer.render(this.scene, this.camera);
    }
  };
}

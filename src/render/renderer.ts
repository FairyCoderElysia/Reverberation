import * as THREE from 'three';
import type { FacilitySnapshot, GraphicTier, OrbitState, SoundSource, XYZA } from '../types';
import { PIXEL_RATIO_HIGH_CAP, PIXEL_RATIO_LOW } from '../config';
import { BAND_COLORS, FACILITY_COLORS, hexToNumber, MATERIAL_COLORS } from '../theme';
import { blockIndex, WORLD_X, WORLD_Y, WORLD_Z } from '../world';
import type { World } from '../world';
import type { EnergyField } from '../acoustics';
import { sampleSoundView, soundViewStepForTier } from '../visualization';

export function detectWebGL2(): boolean {
  if (typeof window === 'undefined') return false;
  const query = window.location.search;
  if (query.indexOf('nogl=1') !== -1) return false;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    return gl !== null;
  } catch {
    return false;
  }
}

export class Renderer {
  available: boolean;
  tier: GraphicTier = 'high';
  instances = 0;
  drawCalls = 0;

  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private container: HTMLElement;
  private meshes: THREE.InstancedMesh[] = [];
  private facilityMeshes: THREE.Mesh[] = [];
  private markers: THREE.Object3D[] = [];
  private rafId = 0;
  private onFrame: (() => void) | null = null;

  /** S5：声场可视化点云（只读能量场采样，不参与模拟）。 */
  private soundPoints: THREE.Points | null = null;
  private soundPointVersion = -1;
  private soundPointTier: GraphicTier | null = null;
  private soundPointCount = 0;
  /** S5：当前声场可视化点数（state.perf.visualInstances 唯一来源）。 */
  visualInstances = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b1220);
    this.camera = new THREE.PerspectiveCamera(
      70,
      container.clientWidth / Math.max(1, container.clientHeight),
      0.1,
      500,
    );
    this.camera.position.set(32, 12, 32);

    this.available = detectWebGL2();
    if (!this.available) return;

    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true });
      this.renderer.setSize(container.clientWidth, container.clientHeight);
      this.applyPixelRatio(this.tier);
      this.renderer.domElement.style.display = 'block';
      this.renderer.domElement.style.cursor = 'crosshair';
      container.appendChild(this.renderer.domElement);

      const ambient = new THREE.AmbientLight(0xffffff, 0.7);
      const dir = new THREE.DirectionalLight(0xffffff, 1.2);
      dir.position.set(40, 80, 30);
      this.scene.add(ambient, dir);
    } catch {
      this.available = false;
      if (this.renderer) {
        this.renderer.dispose();
        this.renderer = null;
      }
    }
  }

  /** 像素比引用 config 单一来源（Code N1）：无 2 / 0.75 字面量双源。 */
  private applyPixelRatio(tier: GraphicTier): void {
    if (!this.renderer) return;
    const pr =
      tier === 'high'
        ? Math.min(window.devicePixelRatio || 1, PIXEL_RATIO_HIGH_CAP)
        : PIXEL_RATIO_LOW;
    this.renderer.setPixelRatio(pr);
  }

  /** 第一人称视图：由 game 每帧推送眼睛位置与朝向。 */
  setView(eye: [number, number, number], yaw: number, pitch: number): void {
    this.camera.position.set(eye[0], eye[1], eye[2]);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = yaw;
    this.camera.rotation.x = pitch;
  }

  /** 轨道俯瞰视图（F4B）：围绕 target 的球面相机，支持旋转/缩放/平移。 */
  setOrbitView(orbit: OrbitState): void {
    const horiz = Math.cos(orbit.pitch) * orbit.distance;
    const x = orbit.target[0] + Math.sin(orbit.yaw) * horiz;
    const y = orbit.target[1] + Math.sin(orbit.pitch) * orbit.distance;
    const z = orbit.target[2] + Math.cos(orbit.yaw) * horiz;
    this.camera.position.set(x, y, z);
    this.camera.lookAt(orbit.target[0], orbit.target[1], orbit.target[2]);
  }

  rebuildWorld(
    worldIds: Uint8Array,
    facilities: FacilitySnapshot[] = [],
    sources: SoundSource[] = [],
    spawn?: XYZA,
  ): void {
    if (!this.renderer) return;
    for (const m of this.meshes) {
      this.scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.meshes = [];
    for (const f of this.facilityMeshes) {
      this.scene.remove(f);
      f.geometry.dispose();
      (f.material as THREE.Material).dispose();
    }
    this.facilityMeshes = [];
    for (const mk of this.markers) {
      this.scene.remove(mk);
      const maybeMesh = mk as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
      maybeMesh.geometry?.dispose();
      if (Array.isArray(maybeMesh.material)) {
        for (const mat of maybeMesh.material) mat.dispose();
      } else {
        maybeMesh.material?.dispose();
      }
    }
    this.markers = [];

    // 索引公式与世界尺寸单一来源（Code-M2）：从 world.ts 导入，禁止在此硬编码
    const solid = (x: number, y: number, z: number): boolean => {
      if (x < 0 || x >= WORLD_X || y < 0 || y >= WORLD_Y || z < 0 || z >= WORLD_Z) return false;
      return worldIds[blockIndex(x, y, z)] !== 0;
    };

    const exposed: number[][][] = Array.from({ length: 7 }, () => []);
    for (let z = 0; z < WORLD_Z; z++) {
      for (let x = 0; x < WORLD_X; x++) {
        for (let y = 0; y < WORLD_Y; y++) {
          const id = worldIds[blockIndex(x, y, z)];
          if (id === 0 || id > 7) continue;
          if (
            !solid(x + 1, y, z) ||
            !solid(x - 1, y, z) ||
            !solid(x, y + 1, z) ||
            !solid(x, y - 1, z) ||
            !solid(x, y, z + 1) ||
            !solid(x, y, z - 1)
          ) {
            exposed[id - 1].push([x, y, z]);
          }
        }
      }
    }

    const geo = new THREE.BoxGeometry(1, 1, 1);
    const dummy = new THREE.Object3D();
    let total = 0;
    for (let id = 1; id <= 7; id++) {
      const list = exposed[id - 1];
      if (list.length === 0) continue;
      const mat = new THREE.MeshLambertMaterial({ color: hexToNumber(MATERIAL_COLORS[id - 1]) });
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      for (let i = 0; i < list.length; i++) {
        const x = list[i][0];
        const y = list[i][1];
        const z = list[i][2];
        dummy.position.set(x + 0.5, y + 0.5, z + 0.5);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.count = list.length;
      this.scene.add(mesh);
      this.meshes.push(mesh);
      total += list.length;
    }
    for (const f of facilities) {
      const [x, y, z] = f.cell;
      if (
        x < 0 || x >= WORLD_X ||
        y < 0 || y >= WORLD_Y ||
        z < 0 || z >= WORLD_Z
      ) continue;
      const geo = new THREE.BoxGeometry(0.9, 0.9, 0.9);
      const mat = new THREE.MeshLambertMaterial({
        color: hexToNumber(FACILITY_COLORS[f.kind] ?? '#ffffff'),
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
      mesh.rotation.y = f.yaw;
      this.scene.add(mesh);
      this.facilityMeshes.push(mesh);
    }
    this.instances = total;

    // Major #1：markers 与方块网格同属“世界重建”职责；在此统一重建可避免
    // 运行时首次 world revision 后声源/出生点标记消失，也避免 main.ts 散落两处。
    if (sources.length > 0 || spawn) {
      this.addSourceMarkers(sources, spawn ?? [0, 0, 0]);
    }
  }

  addSourceMarkers(sources: SoundSource[], spawn: XYZA): void {
    if (!this.renderer) return;

    for (const s of sources) {
      const geo = new THREE.OctahedronGeometry(0.7, 0);
      const mat = new THREE.MeshBasicMaterial({ color: hexToNumber(BAND_COLORS[s.dominantBand]) });
      const marker = new THREE.Mesh(geo, mat);
      marker.position.set(s.pos[0] + 0.5, s.pos[1] + 0.5, s.pos[2] + 0.5);
      this.scene.add(marker);
      this.markers.push(marker);
    }
    const geo = new THREE.SphereGeometry(0.4, 12, 12);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const marker = new THREE.Mesh(geo, mat);
    marker.position.set(spawn[0] + 0.5, spawn[1] + 0.5, spawn[2] + 0.5);
    this.scene.add(marker);
    this.markers.push(marker);
  }

  /** S5：设置声场视图可见性（只隐藏/显示点云，不改变任何能量/世界数据）。 */
  setSoundViewVisible(visible: boolean): void {
    if (this.soundPoints) this.soundPoints.visible = visible;
  }

  /**
   * S5：同源重建声场可视化点云。
   * 只在 energyField.version 或图形档变化时重采样；采样值直接来自 energyField.sample。
   */
  updateSoundView(
    field: Pick<EnergyField, 'sample'>,
    world: World,
    visible: boolean,
    version: number,
  ): void {
    if (!this.renderer) {
      this.visualInstances = 0;
      return;
    }
    if (!visible) {
      if (this.soundPoints) this.soundPoints.visible = false;
      this.visualInstances = 0;
      return;
    }
    if (
      this.soundPoints &&
      this.soundPointVersion === version &&
      this.soundPointTier === this.tier
    ) {
      this.soundPoints.visible = true;
      this.visualInstances = this.soundPointCount;
      return;
    }
    const step = soundViewStepForTier(this.tier);
    const sampled = sampleSoundView(field, world, step);
    if (this.soundPoints) {
      this.soundPoints.geometry.dispose();
      (this.soundPoints.material as THREE.Material).dispose();
      this.scene.remove(this.soundPoints);
      this.soundPoints = null;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(sampled.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(sampled.colors, 3));
    const mat = new THREE.PointsMaterial({
      size: this.tier === 'low' ? 0.3 : 0.38,
      vertexColors: true,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    });
    const pts = new THREE.Points(geo, mat);
    pts.visible = true;
    this.scene.add(pts);
    this.soundPoints = pts;
    this.soundPointVersion = version;
    this.soundPointTier = this.tier;
    this.soundPointCount = sampled.count;
    this.visualInstances = sampled.count;
  }

  start(onFrame: () => void): void {
    this.onFrame = onFrame;
    const loop = (): void => {
      if (!this.renderer) return;
      this.renderer.render(this.scene, this.camera);
      this.drawCalls = this.renderer.info.render.calls;
      if (this.onFrame) this.onFrame();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
  }

  setTier(tier: GraphicTier): void {
    this.tier = tier;
    if (!this.renderer) return;
    this.applyPixelRatio(tier);
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
  }

  getPixelRatio(): number {
    return this.renderer ? this.renderer.getPixelRatio() : 0;
  }

  /** 渲染画布 DOM（供输入绑定）。 */
  get domElement(): HTMLCanvasElement | null {
    return this.renderer ? this.renderer.domElement : null;
  }

  handleResize(): void {
    if (!this.renderer) return;
    this.camera.aspect = this.container.clientWidth / Math.max(1, this.container.clientHeight);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
  }
}

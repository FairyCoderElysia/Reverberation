import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { GraphicTier, SoundSource, XYZA } from '../types';

const MATERIAL_COLORS: number[] = [
  0xc9e265,
  0x8a5a2b,
  0x7fd4e0,
  0x8d8d93,
  0x9aa3ad,
  0xcfd6dd,
  0x6b4f2f,
];

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
  private controls: OrbitControls | null = null;
  private container: HTMLElement;
  private meshes: THREE.InstancedMesh[] = [];
  private markers: THREE.Object3D[] = [];
  private rafId = 0;
  private onFrame: (() => void) | null = null;

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
    this.camera.position.set(64, 30, -16);

    this.available = detectWebGL2();
    if (!this.available) return;

    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true });
      this.renderer.setSize(container.clientWidth, container.clientHeight);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      container.appendChild(this.renderer.domElement);

      this.controls = new OrbitControls(this.camera, this.renderer.domElement);
      this.controls.target.set(32, 9, 32);
      this.controls.enableDamping = true;
      this.controls.minDistance = 4;
      this.controls.maxDistance = 160;
      this.controls.maxPolarAngle = Math.PI * 0.49;
      this.controls.update();

      const ambient = new THREE.AmbientLight(0xffffff, 0.7);
      const dir = new THREE.DirectionalLight(0xffffff, 1.2);
      dir.position.set(40, 80, 30);
      this.scene.add(ambient, dir);
    } catch {
      this.available = false;
      if (this.renderer) {
        this.renderer.dispose();
        this.renderer = null;
        this.controls = null;
      }
    }
  }

  rebuildWorld(worldIds: Uint8Array): void {
    if (!this.renderer) return;
    for (const m of this.meshes) {
      this.scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.meshes = [];
    for (const mk of this.markers) this.scene.remove(mk);
    this.markers = [];

    const X = 64;
    const Y = 24;
    const Z = 64;
    const index = (x: number, y: number, z: number): number => x + 64 * (z + 64 * y);
    const solid = (x: number, y: number, z: number): boolean => {
      if (x < 0 || x >= X || y < 0 || y >= Y || z < 0 || z >= Z) return false;
      return worldIds[index(x, y, z)] !== 0;
    };

    const exposed: number[][][] = Array.from({ length: 7 }, () => []);
    for (let z = 0; z < Z; z++) {
      for (let x = 0; x < X; x++) {
        for (let y = 0; y < Y; y++) {
          const id = worldIds[index(x, y, z)];
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
      const mat = new THREE.MeshLambertMaterial({ color: MATERIAL_COLORS[id - 1] });
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
    this.instances = total;
  }

  addSourceMarkers(sources: SoundSource[], spawn: XYZA): void {
    if (!this.renderer) return;
    const bandColors = [0xff5d5d, 0xffd166, 0x5dd9ff];
    for (const s of sources) {
      const geo = new THREE.OctahedronGeometry(0.7, 0);
      const mat = new THREE.MeshBasicMaterial({ color: bandColors[s.dominantBand] });
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

  start(onFrame: () => void): void {
    this.onFrame = onFrame;
    const loop = (): void => {
      if (!this.renderer) return;
      if (this.controls) this.controls.update();
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
    const pr = tier === 'high' ? Math.min(window.devicePixelRatio || 1, 2) : 0.75;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
  }

  getPixelRatio(): number {
    return this.renderer ? this.renderer.getPixelRatio() : 0;
  }

  handleResize(): void {
    if (!this.renderer) return;
    this.camera.aspect = this.container.clientWidth / Math.max(1, this.container.clientHeight);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
  }
}

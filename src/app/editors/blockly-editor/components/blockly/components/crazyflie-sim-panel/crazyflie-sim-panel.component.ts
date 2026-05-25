import { AfterViewInit, Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  AmbientLight,
  BufferGeometry,
  BoxGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  DirectionalLight,
  GridHelper,
  HemisphereLight,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  Line,
  LineSegments,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  RepeatWrapping,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  TextureLoader,
  TorusGeometry,
  TubeGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Subscription } from 'rxjs';
import { CrazyflieSimService } from '../../../../../../services/crazyflie-sim.service';

@Component({
  selector: 'app-crazyflie-sim-panel',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './crazyflie-sim-panel.component.html',
  styleUrl: './crazyflie-sim-panel.component.scss',
})
export class CrazyflieSimPanelComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('canvasHost', { static: true }) private canvasHostRef!: ElementRef<HTMLDivElement>;
  @ViewChild('floorPlanInput', { static: true }) private floorPlanInputRef!: ElementRef<HTMLInputElement>;
  @ViewChild('sceneModelInput', { static: true }) private sceneModelInputRef!: ElementRef<HTMLInputElement>;

  running = false;
  paused = false;
  speed = 1;
  stepText = 'idle';
  logs: string[] = [];
  telemetry = { xCm: 0, yCm: 0, altitudeCm: 6 };
  gridVisible = true;
  flightPathVisible = true;
  sceneReady = false;

  private scene: Scene | null = null;
  private camera: PerspectiveCamera | null = null;
  private renderer: WebGLRenderer | null = null;
  private controls: OrbitControls | null = null;
  private animationFrameId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

  private droneGroup: Group | null = null;
  private propellerMeshes: Group[] = [];
  private propellerDirections: number[] = [];
  private roomWireframe: LineSegments | null = null;
  private gridHelper: GridHelper | null = null;
  private trailHistoryLine: Line | null = null;
  private trailLine: Line | null = null;
  private trailTubeMesh: Mesh | null = null;
  private trailEndpoint: Mesh | null = null;
  private trailPoints: Vector3[] = [];
  private lastTrailPoint: Vector3 | null = null;
  private floorMesh: Mesh | null = null;
  private sceneModelRoot: Group | null = null;
  private presetInteriorRoot: Group | null = null;
  private currentRoomSize = { width: 8, depth: 10, height: 3 };
  private readonly gltfLoader = new GLTFLoader();

  private targetPosition = new Vector3(0, 0.06, 0);
  private readonly trailMinDistance = 0.035;
  private readonly trailMaxPoints = 800;
  private readonly trailRecentPoints = 40;
  private readonly trailTubeRadius = 0.02;
  private readonly trailHistoryColor = '#0068d6';
  private readonly trailPrimaryColor = '#00a7ff';
  private readonly trailEndpointColor = '#ff2d55';
  private readonly defaultDroneYawOffset = Math.PI;
  private readonly defaultCameraPosition = new Vector3(5.2, 4.0, -3.2);
  private readonly defaultCameraTarget = new Vector3(0.2, 0.7, 0);
  private lastRenderTs = 0;
  private subscriptions: Subscription[] = [];

  constructor(public simService: CrazyflieSimService) {}

  ngOnInit(): void {
    this.setupSubscriptions();
  }

  ngAfterViewInit(): void {
    this.sceneReady = false;
    this.initThreeScene();
    this.observeResize();
    this.startRenderLoop();
    queueMicrotask(() => {
      this.sceneReady = true;
    });
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((sub) => sub.unsubscribe());
    this.subscriptions = [];

    if (this.animationFrameId != null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }

    if (this.controls) {
      this.controls.dispose();
      this.controls = null;
    }
  }

  setPreset(preset: 'classroom' | 'home'): void {
    this.simService.setRoomPreset(preset);
  }

  async onFloorPlanSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input?.files?.[0];
    if (!file) {
      return;
    }
    await this.simService.importFloorPlan(file);
    if (input) {
      input.value = '';
    }
  }

  openFloorPlanFilePicker(): void {
    this.floorPlanInputRef?.nativeElement?.click();
  }

  openSceneModelFilePicker(): void {
    this.sceneModelInputRef?.nativeElement?.click();
  }

  async onSceneModelSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input?.files?.[0];
    if (!file) {
      return;
    }
    await this.simService.importSceneModel(file);
    if (input) {
      input.value = '';
    }
  }

  clearFloorPlan(): void {
    this.simService.clearFloorPlan();
  }

  clearSceneModel(): void {
    this.simService.clearSceneModel();
  }

  resetDronePose(): void {
    this.simService.resetPose();
  }

  toggleGrid(): void {
    this.gridVisible = !this.gridVisible;
    if (this.gridHelper) {
      this.gridHelper.visible = this.gridVisible;
    }
  }

  toggleFlightPath(): void {
    this.flightPathVisible = !this.flightPathVisible;
    if (this.trailHistoryLine) {
      this.trailHistoryLine.visible = this.flightPathVisible;
    }
    if (this.trailLine) {
      this.trailLine.visible = this.flightPathVisible;
    }
    if (this.trailTubeMesh) {
      this.trailTubeMesh.visible = this.flightPathVisible && this.trailPoints.length > 1;
    }
    if (this.trailEndpoint) {
      this.trailEndpoint.visible = this.flightPathVisible && this.trailPoints.length > 0;
    }
  }

  togglePause(): void {
    this.simService.togglePause();
  }

  stepOnce(): void {
    this.simService.requestStepOnce();
  }

  onSpeedChanged(value: string): void {
    const speed = Number(value || 1);
    this.simService.setSpeed(speed);
  }

  resetCameraView(): void {
    if (!this.camera) {
      return;
    }
    this.camera.position.copy(this.defaultCameraPosition);
    this.camera.lookAt(this.defaultCameraTarget);
    if (this.controls) {
      this.controls.target.copy(this.defaultCameraTarget);
      this.controls.update();
    }
  }

  private initThreeScene(): void {
    const host = this.canvasHostRef.nativeElement;
    const width = Math.max(320, host.clientWidth || 420);
    const height = Math.max(220, host.clientHeight || 300);

    this.scene = new Scene();
    this.scene.background = new Color('#dfe8f2');

    this.camera = new PerspectiveCamera(58, width / height, 0.1, 100);
    this.camera.position.copy(this.defaultCameraPosition);
    this.camera.lookAt(this.defaultCameraTarget);

    this.renderer = new WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height);
    host.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = true;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 30;
    this.controls.minPolarAngle = 0;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.target.copy(this.defaultCameraTarget);
    this.controls.update();

    const ambientLight = new AmbientLight(0xffffff, 1.0);
    const hemiLight = new HemisphereLight('#f6f8ff', '#e0ddd2', 0.8);
    const directionalLight = new DirectionalLight(0xffffff, 1.15);
    directionalLight.position.set(5, 7, 3);
    const fillLight = new DirectionalLight('#fff6ea', 0.55);
    fillLight.position.set(-4, 4, -2);
    this.scene.add(ambientLight, hemiLight, directionalLight, fillLight);

    const floorGeometry = new PlaneGeometry(20, 20);
    const floorMaterial = new MeshStandardMaterial({ color: '#d4d9e1', roughness: 0.92, metalness: 0.01 });
    this.floorMesh = new Mesh(floorGeometry, floorMaterial);
    this.floorMesh.rotation.x = -Math.PI / 2;
    this.floorMesh.position.y = 0;
    this.scene.add(this.floorMesh);

    const grid = new GridHelper(20, 20, '#9fb3c9', '#c4d0df');
    grid.position.y = 0.001;
    this.gridHelper = grid;
    this.gridHelper.visible = this.gridVisible;
    this.scene.add(grid);

    this.droneGroup = this.createDroneMesh();
    this.scene.add(this.droneGroup);

    this.ensureTrailLine();

    const room = this.simService.roomSize$.value;
    this.currentRoomSize = room;
    this.rebuildRoomWireframe(room.width, room.depth, room.height);
    this.rebuildPresetInterior(this.simService.roomPreset$.value, room);
    this.applyFloorPlanTexture(this.simService.floorPlanUrl$.value);
    this.applySceneModel(this.simService.sceneModelUrl$.value);
  }

  private createDroneMesh(): Group {
    const group = new Group();

    const frameMaterial = new MeshStandardMaterial({ color: '#202b36', roughness: 0.5, metalness: 0.18 });
    const deckMaterial = new MeshStandardMaterial({ color: '#49c4d3', roughness: 0.42, metalness: 0.1 });
    const accentMaterial = new MeshStandardMaterial({ color: '#6f87a3', roughness: 0.5, metalness: 0.14 });

    const deck = new Mesh(new BoxGeometry(0.18, 0.02, 0.18), deckMaterial);
    deck.position.y = 0.057;
    group.add(deck);

    const iconTexture = typeof document !== 'undefined' ? this.createDroneIconTexture() : null;
    if (iconTexture) {
      const iconPlane = new Mesh(
        new PlaneGeometry(0.205, 0.205),
        new MeshStandardMaterial({
          map: iconTexture,
          transparent: true,
          alphaTest: 0.08,
          roughness: 0.42,
          metalness: 0.06,
        }),
      );
      iconPlane.rotation.x = -Math.PI / 2;
      iconPlane.position.y = 0.068;
      group.add(iconPlane);
    }

    const body = new Mesh(new BoxGeometry(0.22, 0.042, 0.22), frameMaterial);
    body.position.y = 0.03;
    group.add(body);

    const battery = new Mesh(new BoxGeometry(0.11, 0.018, 0.075), accentMaterial);
    battery.position.y = 0.078;
    battery.position.z = -0.02;
    group.add(battery);

    const stack = new Mesh(new BoxGeometry(0.09, 0.018, 0.09), new MeshStandardMaterial({ color: '#2b3949', roughness: 0.45, metalness: 0.18 }));
    stack.position.y = 0.07;
    group.add(stack);

    const antenna = new Mesh(new CylinderGeometry(0.004, 0.004, 0.06, 10), new MeshStandardMaterial({ color: '#1a1f24', roughness: 0.36, metalness: 0.22 }));
    antenna.position.set(0.04, 0.102, -0.06);
    group.add(antenna);

    const armMaterial = new MeshStandardMaterial({ color: '#364757', roughness: 0.46, metalness: 0.12 });
    const armCross = new Group();
    armCross.position.y = 0.045;
    armCross.rotation.y = Math.PI / 4;
    const arm1 = new Mesh(new BoxGeometry(0.54, 0.016, 0.032), armMaterial);
    const arm2 = new Mesh(new BoxGeometry(0.032, 0.016, 0.54), armMaterial);
    armCross.add(arm1, arm2);
    group.add(armCross);

    const skidMaterial = new MeshStandardMaterial({ color: '#2c353f', roughness: 0.55, metalness: 0.1 });
    const skidLeft = new Mesh(new BoxGeometry(0.2, 0.008, 0.018), skidMaterial);
    const skidRight = new Mesh(new BoxGeometry(0.2, 0.008, 0.018), skidMaterial);
    skidLeft.position.set(0, 0.016, -0.07);
    skidRight.position.set(0, 0.016, 0.07);
    group.add(skidLeft, skidRight);

    this.propellerMeshes = [];
    this.propellerDirections = [];
    const bladeMaterial = new MeshStandardMaterial({ color: '#111418', roughness: 0.32, metalness: 0.1, transparent: true, opacity: 0.95 });
    const motorMaterial = new MeshStandardMaterial({ color: '#2f4155', roughness: 0.5, metalness: 0.14 });
    const guardMaterial = new MeshStandardMaterial({ color: '#55687f', roughness: 0.55, metalness: 0.08, transparent: true, opacity: 0.6 });
    const ledColors = ['#2fd5ff', '#ff566d', '#72ffa1', '#ffd66e'];
    const propPositions: Array<[number, number]> = [
      [0.18, 0.18],
      [0.18, -0.18],
      [-0.18, 0.18],
      [-0.18, -0.18],
    ];

    propPositions.forEach(([x, z], index) => {
      const motor = new Mesh(new CylinderGeometry(0.02, 0.02, 0.035, 16), motorMaterial);
      motor.position.set(x, 0.065, z);
      group.add(motor);

      const guard = new Mesh(new TorusGeometry(0.102, 0.005, 12, 32), guardMaterial);
      guard.rotation.x = Math.PI / 2;
      guard.position.set(x, 0.088, z);
      group.add(guard);

      const propGroup = new Group();
      propGroup.position.set(x, 0.09, z);
      const hub = new Mesh(new CylinderGeometry(0.012, 0.012, 0.012, 14), motorMaterial);
      propGroup.add(hub);

      const blade1 = new Mesh(new BoxGeometry(0.16, 0.004, 0.018), bladeMaterial);
      const blade2 = new Mesh(new BoxGeometry(0.018, 0.004, 0.16), bladeMaterial);
      propGroup.add(blade1, blade2);
      group.add(propGroup);

      const led = new Mesh(new SphereGeometry(0.008, 10, 10), new MeshStandardMaterial({
        color: ledColors[index],
        emissive: ledColors[index],
        emissiveIntensity: 0.5,
        roughness: 0.2,
        metalness: 0.02,
      }));
      led.position.set(x * 0.68, 0.07, z * 0.68);
      group.add(led);

      this.propellerMeshes.push(propGroup);
      this.propellerDirections.push(index % 2 === 0 ? 1 : -1);
    });

    group.position.set(0, 0.06, 0);
    // Keep model forward aligned with simulation forward axis.
    group.rotation.y = this.defaultDroneYawOffset;
    return group;
  }

  private createDroneIconTexture(): CanvasTexture {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      const fallback = new CanvasTexture(canvas);
      fallback.colorSpace = SRGBColorSpace;
      return fallback;
    }

    ctx.clearRect(0, 0, size, size);
    const ink = '#1e2230';

    const drawProp = (cx: number, cy: number, radius: number, angle: number) => {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle);

      ctx.strokeStyle = ink;
      ctx.lineWidth = 9;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.ellipse(-radius * 0.38, 0, radius * 0.32, radius * 0.12, -0.25, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(radius * 0.38, 0, radius * 0.32, radius * 0.12, -0.25, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(0, 0, radius * 0.08, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };

    drawProp(size * 0.28, size * 0.28, size * 0.17, -0.7);
    drawProp(size * 0.72, size * 0.28, size * 0.17, 0.7);
    drawProp(size * 0.28, size * 0.72, size * 0.17, 0.7);
    drawProp(size * 0.72, size * 0.72, size * 0.17, -0.7);

    ctx.fillStyle = ink;
    ctx.beginPath();
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2 - Math.PI / 8;
      const r = i % 2 === 0 ? size * 0.12 : size * 0.1;
      const x = size * 0.5 + Math.cos(a) * r;
      const y = size * 0.5 + Math.sin(a) * r;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.closePath();
    ctx.fill();

    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }

  private updatePropellerAnimation(deltaSec: number): void {
    if (this.propellerMeshes.length === 0) {
      return;
    }

    const inFlight = this.droneGroup ? this.droneGroup.position.y > 0.07 : false;
    const shouldSpin = this.running && !this.paused && inFlight;
    if (!shouldSpin) {
      return;
    }

    const angularSpeed = MathUtils.degToRad(1200 * Math.max(0.2, this.speed));
    for (let i = 0; i < this.propellerMeshes.length; i += 1) {
      const prop = this.propellerMeshes[i];
      const dir = this.propellerDirections[i] || 1;
      prop.rotation.y += angularSpeed * dir * deltaSec;
    }
  }

  private setupSubscriptions(): void {
    this.subscriptions.push(
      this.simService.running$.subscribe((running) => {
        if (running && !this.running) {
          this.clearFlightPath();
        }
        this.running = running;
      }),
    );

    this.subscriptions.push(
      this.simService.paused$.subscribe((paused) => {
        this.paused = paused;
      }),
    );

    this.subscriptions.push(
      this.simService.speed$.subscribe((speed) => {
        this.speed = speed;
      }),
    );

    this.subscriptions.push(
      this.simService.step$.subscribe((step) => {
        if (!step) {
          this.stepText = this.running ? 'running...' : 'idle';
          return;
        }
        this.stepText = `step ${step.current}/${step.total}: ${step.label}`;
      }),
    );

    this.subscriptions.push(
      this.simService.logs$.subscribe((logs) => {
        this.logs = logs.slice(-6);
      }),
    );

    this.subscriptions.push(
      this.simService.pose$.subscribe((pose) => {
        this.targetPosition.set(pose.x, pose.y, pose.z);
        this.telemetry = {
          xCm: Math.round(pose.x * 100),
          yCm: Math.round(pose.z * 100),
          altitudeCm: Math.max(0, Math.round(pose.y * 100)),
        };
      }),
    );

    this.subscriptions.push(
      this.simService.roomSize$.subscribe((room) => {
        this.currentRoomSize = room;
        this.rebuildRoomWireframe(room.width, room.depth, room.height);
        this.rebuildPresetInterior(this.simService.roomPreset$.value, room);
      }),
    );

    this.subscriptions.push(
      this.simService.roomPreset$.subscribe((preset) => {
        this.rebuildPresetInterior(preset, this.currentRoomSize);
      }),
    );

    this.subscriptions.push(
      this.simService.floorPlanUrl$.subscribe((url) => {
        this.applyFloorPlanTexture(url);
      }),
    );

    this.subscriptions.push(
      this.simService.sceneModelUrl$.subscribe((url) => {
        this.applySceneModel(url);
      }),
    );
  }

  private applyFloorPlanTexture(url: string | null): void {
    if (!this.floorMesh) {
      return;
    }
    const material = this.floorMesh.material as MeshStandardMaterial;

    if (!url) {
      material.map = null;
      material.color = new Color('#27303a');
      material.needsUpdate = true;
      return;
    }

    const loader = new TextureLoader();
    loader.load(
      url,
      (texture) => {
        texture.wrapS = RepeatWrapping;
        texture.wrapT = RepeatWrapping;
        texture.repeat.set(1, 1);
        texture.colorSpace = SRGBColorSpace;
        material.map = texture;
        material.color = new Color('#ffffff');
        material.needsUpdate = true;
      },
      undefined,
      () => {
        material.map = null;
        material.color = new Color('#27303a');
        material.needsUpdate = true;
      },
    );
  }

  private applySceneModel(url: string | null): void {
    if (!this.scene) {
      return;
    }

    if (this.sceneModelRoot) {
      this.scene.remove(this.sceneModelRoot);
      this.sceneModelRoot.traverse((node: any) => {
        if (node.geometry?.dispose) {
          node.geometry.dispose();
        }
        if (node.material?.dispose) {
          if (Array.isArray(node.material)) {
            node.material.forEach((material: any) => material?.dispose?.());
          } else {
            node.material.dispose();
          }
        }
      });
      this.sceneModelRoot = null;
    }

    if (!url) {
      return;
    }

    this.gltfLoader.load(
      url,
      (gltf) => {
        if (!this.scene) {
          return;
        }
        const root = gltf.scene;
        root.position.set(0, 0, 0);
        root.scale.set(1, 1, 1);
        this.sceneModelRoot = root;
        this.scene.add(root);
      },
      undefined,
      () => {
        this.sceneModelRoot = null;
      },
    );
  }

  private rebuildRoomWireframe(width: number, depth: number, height: number): void {
    if (!this.scene) {
      return;
    }
    if (this.roomWireframe) {
      this.scene.remove(this.roomWireframe);
      this.roomWireframe.geometry.dispose();
      (this.roomWireframe.material as LineBasicMaterial).dispose();
      this.roomWireframe = null;
    }

    const geometry = new EdgesGeometry(new BoxGeometry(width, height, depth));
    const material = new LineBasicMaterial({ color: '#9eb2c7' });
    this.roomWireframe = new LineSegments(geometry, material);
    this.roomWireframe.position.set(0, height / 2, 0);
    this.scene.add(this.roomWireframe);
  }

  private ensureTrailLine(): void {
    if (!this.scene || this.trailLine) {
      return;
    }

    const historyGeometry = new BufferGeometry().setFromPoints([]);
    const historyMaterial = new LineBasicMaterial({ color: this.trailHistoryColor, transparent: true, opacity: 0.95, linewidth: 3 });
    this.trailHistoryLine = new Line(historyGeometry, historyMaterial);
    this.trailHistoryLine.visible = this.flightPathVisible;
    this.scene.add(this.trailHistoryLine);

    const geometry = new BufferGeometry().setFromPoints([]);
    const material = new LineBasicMaterial({ color: this.trailPrimaryColor, transparent: true, opacity: 1, linewidth: 4 });
    this.trailLine = new Line(geometry, material);
    this.trailLine.visible = this.flightPathVisible;
    this.scene.add(this.trailLine);

    const initialTubeCurve = new CatmullRomCurve3([
      new Vector3(0, 0.02, 0),
      new Vector3(0.001, 0.02, 0),
    ]);
    this.trailTubeMesh = new Mesh(
      new TubeGeometry(initialTubeCurve, 8, this.trailTubeRadius, 10, false),
      new MeshStandardMaterial({
        color: this.trailPrimaryColor,
        emissive: '#005ca8',
        emissiveIntensity: 0.35,
        roughness: 0.38,
        metalness: 0.08,
        transparent: true,
        opacity: 0.98,
      }),
    );
    this.trailTubeMesh.visible = false;
    this.scene.add(this.trailTubeMesh);

    this.trailEndpoint = new Mesh(
      new SphereGeometry(0.03, 14, 14),
      new MeshStandardMaterial({
        color: this.trailEndpointColor,
        emissive: this.trailEndpointColor,
        emissiveIntensity: 0.9,
        roughness: 0.28,
        metalness: 0.04,
      }),
    );
    this.trailEndpoint.visible = false;
    this.scene.add(this.trailEndpoint);
  }

  private clearFlightPath(): void {
    this.trailPoints = [];
    this.lastTrailPoint = null;
    if (this.trailHistoryLine) {
      this.trailHistoryLine.geometry.dispose();
      this.trailHistoryLine.geometry = new BufferGeometry().setFromPoints([]);
    }
    if (this.trailLine) {
      this.trailLine.geometry.dispose();
      this.trailLine.geometry = new BufferGeometry().setFromPoints([]);
    }
    if (this.trailTubeMesh) {
      this.trailTubeMesh.geometry.dispose();
      const resetCurve = new CatmullRomCurve3([
        new Vector3(0, 0.02, 0),
        new Vector3(0.001, 0.02, 0),
      ]);
      this.trailTubeMesh.geometry = new TubeGeometry(resetCurve, 8, this.trailTubeRadius, 10, false);
      this.trailTubeMesh.visible = false;
    }
    if (this.trailEndpoint) {
      this.trailEndpoint.visible = false;
    }
  }

  private updateFlightPath(currentPosition: Vector3): void {
    if (!this.trailLine || !this.trailTubeMesh) {
      return;
    }

    const p = new Vector3(currentPosition.x, Math.max(0.02, currentPosition.y), currentPosition.z);
    if (!this.lastTrailPoint || this.lastTrailPoint.distanceToSquared(p) >= this.trailMinDistance * this.trailMinDistance) {
      this.trailPoints.push(p);
      this.lastTrailPoint = p;
      if (this.trailPoints.length > this.trailMaxPoints) {
        this.trailPoints.splice(0, this.trailPoints.length - this.trailMaxPoints);
      }
      if (this.trailHistoryLine) {
        this.trailHistoryLine.geometry.dispose();
        this.trailHistoryLine.geometry = new BufferGeometry().setFromPoints(this.trailPoints);
      }
      const recentPoints = this.trailPoints.slice(-this.trailRecentPoints);
      this.trailLine.geometry.dispose();
      this.trailLine.geometry = new BufferGeometry().setFromPoints(recentPoints);
      if (recentPoints.length > 1) {
        const curve = new CatmullRomCurve3(recentPoints, false, 'catmullrom', 0.2);
        const segments = Math.max(16, recentPoints.length * 6);
        this.trailTubeMesh.geometry.dispose();
        this.trailTubeMesh.geometry = new TubeGeometry(curve, segments, this.trailTubeRadius, 10, false);
        this.trailTubeMesh.visible = this.flightPathVisible;
      }
      if (this.trailEndpoint) {
        this.trailEndpoint.position.copy(p);
        this.trailEndpoint.visible = this.flightPathVisible;
      }
    }
  }

  private rebuildPresetInterior(preset: 'classroom' | 'home' | 'custom', room: { width: number; depth: number; height: number }): void {
    if (!this.scene) {
      return;
    }

    this.disposePresetInterior();

    if (preset === 'custom') {
      return;
    }

    const group = new Group();
    const wallColor = preset === 'classroom' ? '#f6f0e3' : '#5a5148';
    const accentColor = preset === 'classroom' ? '#7fb3df' : '#c89266';

    const wallMat = new MeshStandardMaterial({ color: wallColor, roughness: 0.86, metalness: 0.01, transparent: true, opacity: preset === 'classroom' ? 0.78 : 0.35 });
    const wallThickness = 0.08;

    const backWall = new Mesh(new BoxGeometry(room.width, room.height, wallThickness), wallMat);
    backWall.position.set(0, room.height / 2, -room.depth / 2);
    group.add(backWall);

    const leftWall = new Mesh(new BoxGeometry(wallThickness, room.height, room.depth), wallMat);
    leftWall.position.set(-room.width / 2, room.height / 2, 0);
    group.add(leftWall);

    const rightWall = new Mesh(new BoxGeometry(wallThickness, room.height, room.depth), wallMat);
    rightWall.position.set(room.width / 2, room.height / 2, 0);
    group.add(rightWall);

    const frontWallTop = new Mesh(new BoxGeometry(room.width, room.height * 0.4, wallThickness), wallMat);
    frontWallTop.position.set(0, room.height * 0.8, room.depth / 2);
    group.add(frontWallTop);

    const frontWallLeft = new Mesh(new BoxGeometry(room.width * 0.38, room.height * 0.6, wallThickness), wallMat);
    frontWallLeft.position.set(-room.width * 0.31, room.height * 0.3, room.depth / 2);
    group.add(frontWallLeft);

    const frontWallRight = new Mesh(new BoxGeometry(room.width * 0.38, room.height * 0.6, wallThickness), wallMat);
    frontWallRight.position.set(room.width * 0.31, room.height * 0.3, room.depth / 2);
    group.add(frontWallRight);

    if (preset === 'classroom') {
      const trimMat = new MeshStandardMaterial({ color: '#83b8e5', roughness: 0.58, metalness: 0.04 });
      const floorTileDark = new MeshStandardMaterial({ color: '#cebba2', roughness: 0.9, metalness: 0.01 });
      const floorTileLight = new MeshStandardMaterial({ color: '#e2d3be', roughness: 0.88, metalness: 0.01 });
      const tilesX = 10;
      const tilesZ = 12;
      const tileW = room.width / tilesX;
      const tileD = room.depth / tilesZ;
      for (let tx = 0; tx < tilesX; tx += 1) {
        for (let tz = 0; tz < tilesZ; tz += 1) {
          const tile = new Mesh(
            new BoxGeometry(tileW - 0.02, 0.006, tileD - 0.02),
            (tx + tz) % 2 === 0 ? floorTileDark : floorTileLight,
          );
          tile.position.set(-room.width / 2 + tileW * (tx + 0.5), 0.003, -room.depth / 2 + tileD * (tz + 0.5));
          group.add(tile);
        }
      }

      const carpet = new Mesh(
        new BoxGeometry(room.width * 0.78, 0.008, room.depth * 0.58),
        new MeshStandardMaterial({ color: '#9fa8ad', roughness: 0.95, metalness: 0.0 }),
      );
      carpet.position.set(room.width * 0.06, 0.008, 0);
      group.add(carpet);

      const teachingStage = new Mesh(
        new BoxGeometry(1.35, 0.09, room.depth * 0.86),
        new MeshStandardMaterial({ color: '#e6d2b8', roughness: 0.86, metalness: 0.01 }),
      );
      teachingStage.position.set(-room.width / 2 + 0.95, 0.045, 0);
      group.add(teachingStage);

      const blackboardFrame = new Mesh(
        new BoxGeometry(0.06, 1.28, Math.max(2.7, room.depth * 0.58)),
        new MeshStandardMaterial({ color: '#b88e63', roughness: 0.72, metalness: 0.03 }),
      );
      blackboardFrame.position.set(-room.width / 2 + 0.07, Math.min(room.height - 0.85, 1.78), 0);
      blackboardFrame.rotation.y = 0;
      group.add(blackboardFrame);

      const board = new Mesh(
        new BoxGeometry(0.03, 1.12, Math.max(2.55, room.depth * 0.54)),
        new MeshStandardMaterial({ color: '#39584f', roughness: 0.7, metalness: 0.02 }),
      );
      board.position.set(-room.width / 2 + 0.095, Math.min(room.height - 0.85, 1.78), 0);
      board.rotation.y = 0;
      group.add(board);

      const chalkLineMat = new MeshStandardMaterial({ color: '#d9e3d8', roughness: 0.75, metalness: 0.01 });
      const chalkY = Math.min(room.height - 0.85, 1.78);
      const chalkX = -room.width / 2 + 0.112;
      const chalkLines: Array<[number, number, number, number]> = [
        [-0.38, 0.18, 0.42, 0.02],
        [0.14, 0.06, 0.34, 0.02],
        [-0.25, -0.08, 0.28, 0.018],
      ];
      chalkLines.forEach(([z, y, w, h]) => {
        const line = new Mesh(new BoxGeometry(0.008, h, w), chalkLineMat);
        line.position.set(chalkX, chalkY + y, z);
        group.add(line);
      });

      const chalkTray = new Mesh(
        new BoxGeometry(0.1, 0.04, Math.max(2.45, room.depth * 0.5)),
        new MeshStandardMaterial({ color: '#d9c7ad', roughness: 0.8, metalness: 0.01 }),
      );
      chalkTray.position.set(-room.width / 2 + 0.18, Math.min(room.height - 1.45, 1.18), 0);
      chalkTray.rotation.y = 0;
      group.add(chalkTray);

      const artFrame = new Mesh(
        new BoxGeometry(0.72, 0.5, 0.025),
        new MeshStandardMaterial({ color: '#d7b58c', roughness: 0.72, metalness: 0.02 }),
      );
      artFrame.position.set(-room.width / 2 + 0.065, 1.72, room.depth * 0.27);
      artFrame.rotation.y = Math.PI / 2;
      group.add(artFrame);

      const artInner = new Mesh(
        new BoxGeometry(0.62, 0.4, 0.02),
        new MeshStandardMaterial({ color: '#8ec1e7', roughness: 0.6, metalness: 0.01 }),
      );
      artInner.position.set(-room.width / 2 + 0.075, 1.72, room.depth * 0.27);
      artInner.rotation.y = Math.PI / 2;
      group.add(artInner);

      const teacherDesk = new Mesh(
        new BoxGeometry(1.4, 0.74, 0.62),
        new MeshStandardMaterial({ color: '#e0c39d', roughness: 0.78, metalness: 0.01 }),
      );
      teacherDesk.position.set(-room.width / 2 + 1.55, 0.37, -0.55);
      teacherDesk.rotation.y = Math.PI / 2;
      group.add(teacherDesk);

      const whiteboardStand = new Mesh(
        new BoxGeometry(1.1, 1.0, 0.04),
        new MeshStandardMaterial({ color: '#fcfbf6', roughness: 0.7, metalness: 0.01 }),
      );
      whiteboardStand.position.set(room.width / 2 - 0.24, 0.95, 0);
      whiteboardStand.rotation.y = Math.PI / 2;
      group.add(whiteboardStand);

      const whiteboardFrame = new Mesh(
        new BoxGeometry(1.18, 1.08, 0.03),
        new MeshStandardMaterial({ color: '#8ab6df', roughness: 0.62, metalness: 0.03 }),
      );
      whiteboardFrame.position.set(room.width / 2 - 0.2, 0.95, 0);
      whiteboardFrame.rotation.y = Math.PI / 2;
      group.add(whiteboardFrame);

      const podium = new Mesh(
        new BoxGeometry(0.48, 1.02, 0.42),
        new MeshStandardMaterial({ color: '#caa47d', roughness: 0.74, metalness: 0.01 }),
      );
      podium.position.set(-room.width / 2 + 1.36, 0.51, 1.02);
      podium.rotation.y = Math.PI / 2;
      group.add(podium);

      const podiumTop = new Mesh(
        new BoxGeometry(0.58, 0.06, 0.5),
        new MeshStandardMaterial({ color: '#d9b388', roughness: 0.72, metalness: 0.01 }),
      );
      podiumTop.position.set(-room.width / 2 + 1.36, 1.03, 1.02);
      podiumTop.rotation.y = Math.PI / 2;
      group.add(podiumTop);

      const podiumStep = new Mesh(
        new BoxGeometry(0.62, 0.12, 0.3),
        new MeshStandardMaterial({ color: '#d6b089', roughness: 0.76, metalness: 0.01 }),
      );
      podiumStep.position.set(-room.width / 2 + 1.62, 0.06, 1.02);
      podiumStep.rotation.y = Math.PI / 2;
      group.add(podiumStep);

      const windowMaterial = new MeshStandardMaterial({ color: '#f8fbff', roughness: 0.22, metalness: 0.02, transparent: true, opacity: 0.75 });
      for (let i = 0; i < 4; i += 1) {
        const panel = new Mesh(new BoxGeometry(0.03, 0.92, 1.0), windowMaterial);
        panel.position.set(room.width / 2 - 0.06, 1.62, -room.depth * 0.34 + i * 1.05);
        group.add(panel);

        const frame = new Mesh(new BoxGeometry(0.04, 1.0, 1.08), trimMat);
        frame.position.set(room.width / 2 - 0.075, 1.62, -room.depth * 0.34 + i * 1.05);
        group.add(frame);

        const curtain = new Mesh(
          new BoxGeometry(0.05, 0.18, 1.08),
          new MeshStandardMaterial({ color: '#98bde0', roughness: 0.8, metalness: 0.01 }),
        );
        curtain.position.set(room.width / 2 - 0.095, 2.02, -room.depth * 0.34 + i * 1.05);
        group.add(curtain);
      }

      const wallClock = new Mesh(
        new CylinderGeometry(0.12, 0.12, 0.02, 24),
        new MeshStandardMaterial({ color: '#f5f4ef', roughness: 0.35, metalness: 0.02 }),
      );
      wallClock.rotation.z = Math.PI / 2;
      wallClock.position.set(-room.width * 0.43, 2.0, -room.depth * 0.28);
      group.add(wallClock);

      const door = new Mesh(
        new BoxGeometry(0.78, 2.05, 0.035),
        new MeshStandardMaterial({ color: '#efe2cf', roughness: 0.8, metalness: 0.01 }),
      );
      door.position.set(-room.width * 0.26, 1.02, room.depth / 2 - 0.045);
      group.add(door);

      const doorFrame = new Mesh(new BoxGeometry(0.88, 2.16, 0.03), trimMat);
      doorFrame.position.set(-room.width * 0.26, 1.08, room.depth / 2 - 0.055);
      group.add(doorFrame);

      const storageCabinet = new Mesh(
        new BoxGeometry(0.5, 1.1, 1.8),
        new MeshStandardMaterial({ color: '#e2c6a4', roughness: 0.79, metalness: 0.01 }),
      );
      storageCabinet.position.set(-room.width / 2 + 0.32, 0.55, -0.2);
      group.add(storageCabinet);

      const lowShelf = new Mesh(
        new BoxGeometry(1.1, 0.7, 0.34),
        new MeshStandardMaterial({ color: '#dfc09b', roughness: 0.82, metalness: 0.01 }),
      );
      lowShelf.position.set(room.width * 0.34, 0.35, room.depth * 0.3);
      group.add(lowShelf);

      for (let i = 0; i < 4; i += 1) {
        const book = new Mesh(
          new BoxGeometry(0.08, 0.2 + i * 0.02, 0.18),
          new MeshStandardMaterial({ color: ['#8fb8df', '#e7a97e', '#92c997', '#d9c07f'][i], roughness: 0.7, metalness: 0.01 }),
        );
        book.position.set(room.width * 0.08 + i * 0.11, 0.52, room.depth * 0.3);
        group.add(book);
      }

      const aisle = new Mesh(
        new BoxGeometry(room.width * 0.62, 0.01, 0.74),
        new MeshStandardMaterial({ color: '#d5d9e0', roughness: 0.8, metalness: 0.01 }),
      );
      aisle.position.set(0.35, 0.006, 0);
      group.add(aisle);

      const deskTopMat = new MeshStandardMaterial({ color: '#edcfa8', roughness: 0.79, metalness: 0.01 });
      const deskBaseMat = new MeshStandardMaterial({ color: '#dfbe95', roughness: 0.84, metalness: 0.01 });
      const chairMat = new MeshStandardMaterial({ color: '#d8b489', roughness: 0.8, metalness: 0.01 });

      // 36-student standard matrix: 6 columns x 6 rows.
      // Desk size: 60cm x 40cm, row spacing >= 90cm, center aisle >= 60cm.
      const rows = 6;
      const cols = 6;
      const deskW = 0.6;
      const deskD = 0.4;
      const rowSpacing = 0.98;
      const colSpacing = 0.86;
      const totalColSpan = colSpacing * (cols - 1);
      const colStart = -totalColSpan / 2;
      const colCenters = Array.from({ length: cols }, (_, idx) => colStart + idx * colSpacing);

      let firstRowX = -room.width / 2 + 1.55;
      const lastRowX = firstRowX + rowSpacing * (rows - 1);
      const lastRowMax = room.width / 2 - 0.55;
      if (lastRowX > lastRowMax) {
        firstRowX -= (lastRowX - lastRowMax);
      }

      const helipadDeskCol = 2;
      const helipadDeskRow = 3;
      const helipadX = firstRowX + rowSpacing * helipadDeskRow;
      const helipadZ = colCenters[helipadDeskCol];

      for (let r = 0; r < rows; r += 1) {
        const x = firstRowX + r * rowSpacing;
        for (let c = 0; c < cols; c += 1) {
          const z = colCenters[c];

          const deskTop = new Mesh(new BoxGeometry(deskD, 0.055, deskW), deskTopMat);
          deskTop.position.set(x, 0.38, z);
          group.add(deskTop);

          const deskBase = new Mesh(new BoxGeometry(deskD - 0.06, 0.56, deskW - 0.08), deskBaseMat);
          deskBase.position.set(x, 0.1, z);
          group.add(deskBase);

          const chair = new Mesh(new BoxGeometry(0.24, 0.34, 0.24), chairMat);
          chair.position.set(x + deskD / 2 + 0.2, 0.17, z);
          group.add(chair);
        }
      }

      const deskSurfaceY = 0.38 + 0.055 / 2;
      const helipadDeskHighlight = new Mesh(
        new BoxGeometry(deskW + 0.1, 0.01, deskD + 0.1),
        new MeshStandardMaterial({
          color: '#b6d4ef',
          roughness: 0.5,
          metalness: 0.04,
          emissive: '#8fbde5',
          emissiveIntensity: 0.35,
          transparent: true,
          opacity: 0.86,
        }),
      );
      helipadDeskHighlight.position.set(helipadX, deskSurfaceY + 0.006, helipadZ);
      group.add(helipadDeskHighlight);

      const helipadBase = new Mesh(
        new CylinderGeometry(0.18, 0.18, 0.01, 40),
        new MeshStandardMaterial({ color: '#d6dadf', roughness: 0.86, metalness: 0.01 }),
      );
      helipadBase.position.set(helipadX, deskSurfaceY + 0.005, helipadZ);
      group.add(helipadBase);

      const helipadRing = new Mesh(
        new CylinderGeometry(0.16, 0.16, 0.012, 40),
        new MeshStandardMaterial({ color: '#7ea8cf', roughness: 0.68, metalness: 0.02 }),
      );
      helipadRing.position.set(helipadX, deskSurfaceY + 0.007, helipadZ);
      group.add(helipadRing);

      const hMat = new MeshStandardMaterial({ color: '#4f79a4', roughness: 0.64, metalness: 0.02 });
      const hBarL = new Mesh(new BoxGeometry(0.03, 0.008, 0.11), hMat);
      hBarL.position.set(helipadX - 0.045, deskSurfaceY + 0.013, helipadZ);
      group.add(hBarL);
      const hBarR = new Mesh(new BoxGeometry(0.03, 0.008, 0.11), hMat);
      hBarR.position.set(helipadX + 0.045, deskSurfaceY + 0.013, helipadZ);
      group.add(hBarR);
      const hBarM = new Mesh(new BoxGeometry(0.11, 0.008, 0.03), hMat);
      hBarM.position.set(helipadX, deskSurfaceY + 0.013, helipadZ);
      group.add(hBarM);

      const beaconMaterial = new MeshStandardMaterial({
        color: '#ffd778',
        roughness: 0.35,
        metalness: 0.04,
        emissive: '#ffdb82',
        emissiveIntensity: 0.6,
      });
      const beaconOffsets: Array<[number, number]> = [
        [-(deskD / 2 + 0.05), -(deskW / 2 + 0.05)],
        [deskD / 2 + 0.05, -(deskW / 2 + 0.05)],
        [-(deskD / 2 + 0.05), deskW / 2 + 0.05],
        [deskD / 2 + 0.05, deskW / 2 + 0.05],
      ];
      beaconOffsets.forEach(([ox, oz]) => {
        const beacon = new Mesh(new CylinderGeometry(0.012, 0.012, 0.035, 16), beaconMaterial);
        beacon.position.set(helipadX + ox, deskSurfaceY + 0.02, helipadZ + oz);
        group.add(beacon);
      });

      const nameplate = new Mesh(
        new BoxGeometry(0.012, 0.04, 0.24),
        new MeshStandardMaterial({
          color: '#6e95bc',
          roughness: 0.55,
          metalness: 0.05,
          emissive: '#87afd4',
          emissiveIntensity: 0.28,
        }),
      );
      nameplate.position.set(helipadX - deskD / 2 - 0.065, deskSurfaceY + 0.02, helipadZ);
      group.add(nameplate);

    } else {
      const sofa = new Mesh(
        new BoxGeometry(1.8, 0.7, 0.8),
        new MeshStandardMaterial({ color: accentColor, roughness: 0.85, metalness: 0.01 }),
      );
      sofa.position.set(-room.width * 0.2, 0.35, room.depth * 0.15);
      group.add(sofa);

      const table = new Mesh(
        new BoxGeometry(0.9, 0.45, 0.55),
        new MeshStandardMaterial({ color: '#847568', roughness: 0.78, metalness: 0.01 }),
      );
      table.position.set(0.65, 0.225, room.depth * 0.05);
      group.add(table);
    }

    this.presetInteriorRoot = group;
    this.scene.add(group);
  }

  private disposePresetInterior(): void {
    if (!this.scene || !this.presetInteriorRoot) {
      return;
    }

    this.scene.remove(this.presetInteriorRoot);
    this.presetInteriorRoot.traverse((node: any) => {
      if (node.geometry?.dispose) {
        node.geometry.dispose();
      }
      if (node.material?.dispose) {
        if (Array.isArray(node.material)) {
          node.material.forEach((material: any) => material?.dispose?.());
        } else {
          node.material.dispose();
        }
      }
    });
    this.presetInteriorRoot = null;
  }

  private observeResize(): void {
    const host = this.canvasHostRef.nativeElement;
    this.resizeObserver = new ResizeObserver(() => {
      if (!this.camera || !this.renderer) {
        return;
      }
      const width = Math.max(320, host.clientWidth || 420);
      const height = Math.max(220, host.clientHeight || 300);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height);
      if (this.controls) {
        this.controls.update();
      }
    });
    this.resizeObserver.observe(host);
  }

  private startRenderLoop(): void {
    const animate = () => {
      if (!this.scene || !this.camera || !this.renderer || !this.droneGroup) {
        return;
      }

      const now = performance.now();
      const deltaSec = this.lastRenderTs > 0 ? (now - this.lastRenderTs) / 1000 : 1 / 60;
      this.lastRenderTs = now;

      this.droneGroup.position.x = MathUtils.lerp(this.droneGroup.position.x, this.targetPosition.x, 0.16);
      this.droneGroup.position.y = MathUtils.lerp(this.droneGroup.position.y, this.targetPosition.y, 0.16);
      this.droneGroup.position.z = MathUtils.lerp(this.droneGroup.position.z, this.targetPosition.z, 0.16);
      this.updatePropellerAnimation(deltaSec);
      this.updateFlightPath(this.droneGroup.position);
      this.controls?.update();

      this.renderer.render(this.scene, this.camera);
      this.animationFrameId = requestAnimationFrame(animate);
    };

    this.animationFrameId = requestAnimationFrame(animate);
  }
}

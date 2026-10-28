import { AfterViewInit, Component, ElementRef, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  ACESFilmicToneMapping,
  AmbientLight,
  ArrowHelper,
  Box3,
  BufferGeometry,
  BoxGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  CurvePath,
  DirectionalLight,
  Float32BufferAttribute,
  GridHelper,
  HemisphereLight,
  EdgesGeometry,
  ExtrudeGeometry,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineDashedMaterial,
  Line,
  LineCurve3,
  LineSegments,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NoToneMapping,
  Object3D,
  Plane,
  PerspectiveCamera,
  PlaneGeometry,
  Path,
  QuadraticBezierCurve3,
  RepeatWrapping,
  Raycaster,
  Scene,
  Shape,
  SphereGeometry,
  Spherical,
  SRGBColorSpace,
  TextureLoader,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import * as Blockly from 'blockly';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Subscription } from 'rxjs';
import { CrazyflieSimService } from '../../../../../../services/crazyflie-sim.service';
import { getClassroomDeskLayout } from '../../../../../../services/crazyflie-classroom';
import { CrazyflieConnectionService, CrazyflieDeckType } from '../../../../../../services/crazyflie-connection.service';
import { BlocklyService } from '../../../../services/blockly.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { AttitudeReception, attitudeQuaternion, CRAZYFLIE_BODY_AXES } from '../../../../../../services/crazyflie-attitude';
import { CrazyflieAttitudePreview } from '../../../../../../services/crazyflie-attitude-preview';

const CLASSROOM_WOOD_FINISHES = {
  floor: { tint: '#eee5d3', opacity: 0.68, roughness: 0.88 },
  desk: { tint: '#efd0a0', opacity: 0.32, roughness: 0.74 },
  chair: { tint: '#b7c9bd', opacity: 0.82, roughness: 0.82 },
} as const;
type ClassroomWoodFinish = 'honey' | keyof typeof CLASSROOM_WOOD_FINISHES;

@Component({
  selector: 'app-crazyflie-sim-panel',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './crazyflie-sim-panel.component.html',
  styleUrl: './crazyflie-sim-panel.component.scss',
})
export class CrazyflieSimPanelComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('canvasHost', { static: true }) private canvasHostRef!: ElementRef<HTMLDivElement>;
  @ViewChild('attitudeViewport', { static: true }) private attitudeViewportRef!: ElementRef<HTMLDivElement>;

  running = false;
  paused = false;
  speed = 1;
  stepText = '就绪';
  logs: string[] = [];
  telemetry = { xCm: 0, yCm: 0, altitudeCm: 6, yawDeg: 0 };
  gridVisible = false;
  flightPathVisible = true;
  sceneReady = false;
  measureMode = false;
  measureStatus = '';
  detectedDeckLabels: string[] = [];
  axesVisible = true;
  selectedView = 'iso';
  attitudeMetrics: ReturnType<AttitudeReception['metrics']>;
  private attitudePreview: CrazyflieAttitudePreview | null = null;
  private attitudeViewport = { x: 0, y: 0, width: 0, height: 0 };
  private destroyed = false;
  private lastAttitudeMetricsTs = 0;
  private flightAxes: Group | null = null;
  private aircraftYaw = 0;
  private readonly flightDirections = CRAZYFLIE_BODY_AXES;

  private scene: Scene | null = null;
  private camera: PerspectiveCamera | null = null;
  private renderer: WebGLRenderer | null = null;
  private defaultLighting: Group | null = null;
  private controls: OrbitControls | null = null;
  private animationFrameId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

  private droneGroup: Group | null = null;
  private propellerMeshes: Group[] = [];
  private propellerDirections: number[] = [];
  private deckMountGroup: Group | null = null;
  private detectedDeckTypes: CrazyflieDeckType[] = [];
  private readonly deckLabels: Record<CrazyflieDeckType, string> = {
    'flow-v2': 'Flow v2',
    multiranger: 'Multiranger',
    'led-ring': 'LED-ring',
    buzzer: 'Buzzer',
  };
  private readonly deckShellAssets: Partial<Record<CrazyflieDeckType, string>> = {};
  private readonly deckShellRoots = new Map<CrazyflieDeckType, { root: Object3D; url: string }>();
  private readonly deckLoadTokens = new Map<CrazyflieDeckType, number>();
  private roomWireframe: LineSegments | null = null;
  private gridHelper: GridHelper | null = null;
  private trailHistoryLine: Line | null = null;
  private trailLine: Line | null = null;
  private trailTubeMesh: Mesh | null = null;
  private trailPoints: Vector3[] = [];
  private lastTrailPoint: Vector3 | null = null;
  private floorMesh: Mesh | null = null;
  private sceneModelRoot: Group | null = null;
  private presetInteriorRoot: Group | null = null;
  private currentRoomSize = { width: 8, depth: 10, height: 3 };
  private readonly gltfLoader = new GLTFLoader();
  private readonly colladaLoader = new ColladaLoader();
  private classroomDeskAssetPromise: Promise<{ geometry: BufferGeometry; material: MeshStandardMaterial }> | null = null;
  private readonly classroomProtoAssetPromises = new Map<string, Promise<Group>>();
  private varnishedPineMaterialPromise: Promise<MeshStandardMaterial> | null = null;
  private readonly classroomWoodMaterialPromises = new Map<ClassroomWoodFinish, Promise<MeshStandardMaterial>>();
  private readonly measureRaycaster = new Raycaster();
  private readonly measurePointer = new Vector2();
  private readonly measureFloor = new Plane(new Vector3(0, 1, 0), 0);
  private measureStart: Vector3 | null = null;
  private measureLine: Line | null = null;
  private measureMarkers: Mesh[] = [];

  private targetPosition = new Vector3(0, 0.06, 0);
  private readonly trailMinDistance = 0.035;
  private readonly trailMaxPoints = 800;
  private readonly trailRecentPoints = 40;
  private readonly trailTubeRadius = 0.014;
  private readonly trailThemes = [
    { label: '红', history: '#ff8a8a', primary: '#ff3b30', endpoint: '#ffd166', tubeEmissive: '#8d1e17' },
    { label: '青', history: '#8edbf0', primary: '#17b7d8', endpoint: '#b5f3ff', tubeEmissive: '#0d5e6f' },
    { label: '黄', history: '#ffe49a', primary: '#ffbe0b', endpoint: '#fff1b8', tubeEmissive: '#805d05' },
  ];
  private trailThemeIndex = 0;
  private readonly defaultDroneYawOffset = Math.PI;
  private readonly defaultCameraPosition = new Vector3(5.2, 4.0, -3.2);
  private readonly defaultCameraTarget = new Vector3(0.2, 0.7, 0);
  private lastRenderTs = 0;
  private subscriptions: Subscription[] = [];

  constructor(
    public simService: CrazyflieSimService,
    private connectionService: CrazyflieConnectionService,
    private blocklyService: BlocklyService,
    private message: NzMessageService,
    private zone: NgZone,
  ) {
    this.attitudeMetrics = connectionService.attitudeReception.metrics(performance.now());
  }

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
    this.destroyed = true;
    this.attitudePreview?.dispose();
    this.attitudePreview = null;
    this.subscriptions.forEach((sub) => sub.unsubscribe());
    this.subscriptions = [];
    this.flightAxes?.children.forEach((axis) => {
      if (axis instanceof ArrowHelper) {
        axis.dispose();
      }
    });
    this.flightAxes = null;

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
    this.clearMeasurement();
  }

  setPreset(preset: 'classroom' | 'home'): void {
    if (this.running) {
      this.message.error('请先结束当前流程再切换场景');
      return;
    }
    this.simService.setRoomPreset(preset);
  }

  onPresetSelected(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (value === 'classroom' || value === 'home') this.setPreset(value);
    else this.message.error('不支持的场景模型');
  }

  get realPoseShown(): boolean {
    return this.simService.poseSource$.value === 'real';
  }

  get displayedAttitude() {
    return this.realPoseShown ? this.simService.realAttitude$.value
      : this.attitudeActive ? this.liveAttitude : null;
  }

  get attitudeActive(): boolean {
    return this.connectionService.state$.value.status === 'ready' && !this.running;
  }

  get liveAttitude() { return this.connectionService.attitude$.value; }

  get attitudePreviewState(): 'connecting' | 'disconnected' | 'waiting' | 'error' | 'stale' | 'live' {
    const state = this.connectionService.state$.value;
    if (state.status === 'checking') return 'connecting';
    if (state.status !== 'ready') return 'disconnected';
    if (this.connectionService.attitudeError$.value) return 'error';
    if (!this.liveAttitude) return 'waiting';
    return this.attitudeMetrics.stale ? 'stale' : 'live';
  }

  get attitudeStatus(): string {
    switch (this.attitudePreviewState) {
      case 'connecting': return '连接中';
      case 'disconnected': return '未连接';
      case 'waiting': return '等待姿态';
      case 'error': return '姿态异常';
      case 'stale': return '数据过期';
      case 'live': return '实时';
    }
  }

  get attitudePreviewMessage(): string {
    if (this.attitudePreviewState === 'error') return this.connectionService.attitudeError$.value || '姿态数据异常';
    if (this.attitudePreviewState === 'disconnected') return '点击顶部连接按钮后自动读取真机姿态；预览不控制电机';
    if (this.attitudePreviewState === 'stale') return '超过 500 ms 未收到新姿态，保持末次实测值';
    return `${this.connectionService.state$.value.message}；仅显示姿态，不代表真实位置`;
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
  }

  toggleMeasureMode(): void {
    this.measureMode = !this.measureMode;
    this.measureStart = null;
    if (this.measureMode) {
      this.clearMeasurement();
      this.measureStatus = '测距中：点击场景中的两个位置';
    } else if (!this.measureLine) {
      this.clearMeasurement();
      this.measureStatus = '';
    }
  }

  onCanvasClick(event: MouseEvent): void {
    this.canvasHostRef.nativeElement.focus({ preventScroll: true });
    if (!this.measureMode || !this.renderer || !this.camera || !this.scene) {
      return;
    }
    if (event.target !== this.renderer.domElement) {
      return;
    }

    const bounds = this.renderer.domElement.getBoundingClientRect();
    this.measurePointer.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    this.measureRaycaster.setFromCamera(this.measurePointer, this.camera);
    const point = this.measureRaycaster.ray.intersectPlane(this.measureFloor, new Vector3());
    if (!point) {
      return;
    }
    point.y = 0.018;

    if (!this.measureStart) {
      this.measureStart = point.clone();
      this.addMeasureMarker(point);
      this.measureStatus = '已选起点：再点击一个位置';
      return;
    }

    this.addMeasureMarker(point);
    this.measureLine = new Line(
      new BufferGeometry().setFromPoints([this.measureStart, point]),
      new LineBasicMaterial({ color: '#39c9dc', depthTest: false }),
    );
    this.measureLine.renderOrder = 4;
    this.scene.add(this.measureLine);
    const distanceCm = Math.round(Math.hypot(point.x - this.measureStart.x, point.z - this.measureStart.z) * 100);
    this.measureStatus = `水平距离：${distanceCm} cm`;
    this.measureMode = false;
    this.measureStart = null;
  }

  insertStarterFlow(): void {
    if (this.running) {
      this.message.error('请先结束当前流程再新建示例');
      return;
    }
    const linkType = 'cf_crazyflie_link';
    const takeoffType = 'cf_takeoff';
    const landType = 'cf_land';
    if (!Blockly.Blocks[linkType] || !Blockly.Blocks[takeoffType] || !Blockly.Blocks[landType]) {
      this.message.error('Crazyflie 起飞/降落积木尚未加载，请先打开 Crazyflie 工程。');
      return;
    }

    this.blocklyService.createPage('Crazyflie 起飞降落示例');
    const workspace: any = this.blocklyService.workspace;
    try {
      const link = workspace.newBlock(linkType);
      const takeoff = workspace.newBlock(takeoffType);
      const land = workspace.newBlock(landType);
      link.initSvg();
      takeoff.initSvg();
      land.initSvg();
      if (!link.nextConnection || !takeoff.previousConnection || !takeoff.nextConnection || !land.previousConnection) {
        throw new Error('积木连接口不可用');
      }
      link.nextConnection.connect(takeoff.previousConnection);
      takeoff.nextConnection.connect(land.previousConnection);
      link.moveBy(80, 80);
      link.render();
      takeoff.render();
      land.render();
      workspace.centerOnBlock?.(link.id);
      this.message.success('示例已插入新页面；默认仅模拟，不会自动起飞。');
    } catch (error) {
      console.error('插入 Crazyflie 示例失败:', error);
      this.message.error('插入示例失败，请确认 Crazyflie 积木库已加载。');
    }
  }

  get trailThemeLabel(): string {
    return this.trailThemes[this.trailThemeIndex]?.label || '红';
  }

  cycleTrailTheme(): void {
    this.trailThemeIndex = (this.trailThemeIndex + 1) % this.trailThemes.length;
    this.applyTrailTheme();
  }

  resetCameraView(): void {
    if (!this.camera) {
      return;
    }
    this.settleCameraControls();
    this.camera.position.copy(this.defaultCameraPosition);
    this.camera.lookAt(this.defaultCameraTarget);
    if (this.controls) {
      this.controls.target.copy(this.defaultCameraTarget);
      this.controls.update();
    }
    this.selectedView = 'iso';
  }

  private settleCameraControls(): void {
    if (this.controls) {
      const damping = this.controls.enableDamping;
      this.controls.enableDamping = false;
      this.controls.update();
      this.controls.enableDamping = damping;
    }
  }

  zoomCamera(factor: number): void {
    if (!this.camera || !this.controls) {
      return;
    }
    this.settleCameraControls();
    const offset = this.camera.position.clone().sub(this.controls.target);
    const distance = MathUtils.clamp(offset.length() * factor, this.controls.minDistance, this.controls.maxDistance);
    this.camera.position.copy(this.controls.target).add(offset.normalize().multiplyScalar(distance));
    this.controls.update();
  }

  fitCameraToScene(): void {
    const room = this.currentRoomSize;
    const bounds = new Box3(new Vector3(-room.width / 2, 0, -room.depth / 2), new Vector3(room.width / 2, room.height, room.depth / 2));
    if (this.sceneModelRoot) {
      bounds.expandByObject(this.sceneModelRoot);
    }
    if (this.droneGroup) {
      bounds.expandByObject(this.droneGroup);
    }
    this.frameCameraBounds(bounds);
  }

  focusAircraft(): void {
    if (this.droneGroup) {
      this.frameCameraBounds(new Box3().setFromObject(this.droneGroup), 0.2);
    }
  }

  private frameCameraBounds(bounds: Box3, minimumSize = 0): void {
    if (!this.camera || !this.controls || bounds.isEmpty()) {
      return;
    }
    this.settleCameraControls();
    const center = bounds.getCenter(new Vector3());
    const size = bounds.getSize(new Vector3());
    const verticalFov = MathUtils.degToRad(this.camera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * this.camera.aspect);
    const diameter = Math.max(size.length(), minimumSize);
    const distance = diameter / (2 * Math.sin(Math.min(verticalFov, horizontalFov) / 2)) * 1.1;
    this.controls.maxDistance = Math.max(30, distance * 1.5);
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    if (direction.lengthSq() === 0) {
      direction.set(1, 1, -1).normalize();
    }
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.camera.far = Math.max(100, distance * 4);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  setCameraView(view: string): void {
    if (!this.camera || !this.controls) {
      return;
    }
    const directions: Record<string, Vector3> = {
      front: new Vector3(-1, 0, 0), back: new Vector3(1, 0, 0),
      left: new Vector3(0, 0, 1), right: new Vector3(0, 0, -1),
      top: new Vector3(-0.0001, 1, 0), bottom: new Vector3(-0.0001, -1, 0),
      iso: new Vector3(1, 0.8, -1),
    };
    const direction = directions[view];
    if (!direction) {
      return;
    }
    this.settleCameraControls();
    const distance = this.camera.position.distanceTo(this.controls.target);
    direction.applyAxisAngle(new Vector3(0, 1, 0), this.aircraftYaw);
    this.camera.position.copy(this.controls.target).addScaledVector(direction.normalize(), distance);
    this.selectedView = view;
    this.controls.update();
  }

  orbitCamera(horizontal: number, vertical = 0): void {
    if (!this.camera || !this.controls) {
      return;
    }
    this.settleCameraControls();
    const spherical = new Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    spherical.theta += MathUtils.degToRad(horizontal);
    spherical.phi = MathUtils.clamp(spherical.phi + MathUtils.degToRad(vertical), 0.001, Math.PI - 0.001);
    this.camera.position.copy(this.controls.target).add(new Vector3().setFromSpherical(spherical));
    this.selectedView = '';
    this.controls.update();
  }

  toggleFlightAxes(): void {
    this.axesVisible = !this.axesVisible;
    if (this.flightAxes) {
      this.flightAxes.visible = this.axesVisible;
    }
  }

  captureScene(): void {
    if (!this.renderer || !this.scene || !this.camera) {
      return;
    }
    this.renderer.render(this.scene, this.camera);
    const link = document.createElement('a');
    link.download = `crazyflie-scene-${Date.now()}.png`;
    link.href = this.renderer.domElement.toDataURL('image/png');
    link.click();
  }

  onViewportKeydown(event: KeyboardEvent): void {
    if (event.target !== event.currentTarget) {
      return;
    }
    const actions: Record<string, () => void> = {
      '+': () => this.zoomCamera(0.7), '=': () => this.zoomCamera(0.7), '-': () => this.zoomCamera(1.4),
      Home: () => this.fitCameraToScene(), f: () => this.focusAircraft(), F: () => this.focusAircraft(),
      ArrowLeft: () => this.orbitCamera(-15), ArrowRight: () => this.orbitCamera(15),
      ArrowUp: () => this.orbitCamera(0, -15), ArrowDown: () => this.orbitCamera(0, 15),
    };
    if (actions[event.key]) {
      event.preventDefault();
      actions[event.key]();
    }
  }

  private initThreeScene(): void {
    const host = this.canvasHostRef.nativeElement;
    const width = Math.max(1, host.clientWidth || 420);
    const height = Math.max(220, host.clientHeight || 300);

    this.scene = new Scene();
    this.scene.background = new Color('#dfe8f2');

    this.camera = new PerspectiveCamera(58, width / height, 0.005, 100);
    this.camera.position.copy(this.defaultCameraPosition);
    this.camera.lookAt(this.defaultCameraTarget);

    this.renderer = new WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = false;
    host.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener('start', () => { this.selectedView = ''; });
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = true;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 0.08;
    this.controls.maxDistance = 30;
    this.controls.minPolarAngle = 0;
    this.controls.maxPolarAngle = Math.PI - 0.001;
    this.controls.target.copy(this.defaultCameraTarget);
    this.controls.update();

    const ambientLight = new AmbientLight(0xffffff, 1.0);
    const hemiLight = new HemisphereLight('#f6f8ff', '#e0ddd2', 0.8);
    this.defaultLighting = new Group();
    this.defaultLighting.add(ambientLight, hemiLight);
    this.scene.add(this.defaultLighting);

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
    this.attitudePreview = new CrazyflieAttitudePreview();
    this.attitudePreview.setModel(this.droneGroup);
    this.flightAxes = new Group();
    this.flightAxes.name = 'Aircraft coordinates: X forward, Y left, Z up';
    for (const axis of this.flightDirections) {
      this.flightAxes.add(new ArrowHelper(axis.direction, new Vector3(), 0.16, axis.color, 0.03, 0.015));
    }
    this.scene.add(this.flightAxes);

    this.ensureTrailLine();

    const room = this.simService.roomSize$.value;
    this.currentRoomSize = room;
    this.rebuildRoomWireframe(room.width, room.depth, room.height);
    this.rebuildPresetInterior(this.simService.roomPreset$.value, room);
    this.applyFloorPlanTexture(this.simService.floorPlanUrl$.value);
    this.applySceneModel(this.simService.sceneModelUrl$.value);
    this.updateAttitudeViewport();
  }

  private createDroneMesh(): Group {
    const group = this.createProceduralDroneMesh();
    this.loadBitcrazeAssembly(group);
    return group;
  }

  private createProceduralDroneMesh(): Group {
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

  registerDeckShellAsset(deck: CrazyflieDeckType, url: string): void {
    this.deckShellAssets[deck] = url;
    if (this.detectedDeckTypes.includes(deck)) {
      this.loadDetectedDeckShell(deck, url);
    }
  }
  private updateDetectedDeckShells(decks: CrazyflieDeckType[]): void {
    this.detectedDeckTypes = [...decks];
    this.detectedDeckLabels = decks.map((deck) => this.deckLabels[deck]);
    for (const [deck, loaded] of this.deckShellRoots) {
      if (!decks.includes(deck)) {
        this.deckMountGroup?.remove(loaded.root);
        this.disposeObject3D(loaded.root);
        this.deckShellRoots.delete(deck);
        this.deckLoadTokens.set(deck, (this.deckLoadTokens.get(deck) || 0) + 1);
      }
    }
    if (this.droneGroup) this.attitudePreview?.setModel(this.droneGroup);
    if (!this.deckMountGroup) {
      return;
    }
    decks.forEach((deck) => {
      const url = this.deckShellAssets[deck];
      const loaded = this.deckShellRoots.get(deck);
      if (loaded?.url === url) {
        if (loaded.root.parent !== this.deckMountGroup) {
          this.deckMountGroup.add(loaded.root);
        }
      } else if (url) {
        this.loadDetectedDeckShell(deck, url);
      }
    });
  }

  private loadDetectedDeckShell(deck: CrazyflieDeckType, url: string): void {
    const loadToken = (this.deckLoadTokens.get(deck) || 0) + 1;
    this.deckLoadTokens.set(deck, loadToken);
    const assetUrl = new URL(url, window.location.href).href;
    this.gltfLoader.load(
      assetUrl,
      (gltf) => {
        if (this.deckLoadTokens.get(deck) !== loadToken
          || !this.detectedDeckTypes.includes(deck)
          || this.deckShellAssets[deck] !== url) {
          this.disposeObject3D(gltf.scene);
          return;
        }
        const previous = this.deckShellRoots.get(deck);
        if (previous) {
          this.deckMountGroup?.remove(previous.root);
          this.disposeObject3D(previous.root);
        }
        this.deckMountGroup?.add(gltf.scene);
        this.deckShellRoots.set(deck, { root: gltf.scene, url });
        if (this.droneGroup) this.attitudePreview?.setModel(this.droneGroup);
      },
      undefined,
      (error) => {
        if (this.deckLoadTokens.get(deck) === loadToken) {
          console.warn(`Failed to load detected ${this.deckLabels[deck]} deck shell:`, error);
        }
      },
    );
  }

  private loadBitcrazeAssembly(group: Group): void {
    const assemblyUrl = new URL('./models/crazyflie/cf2_assembly.dae', window.location.href).href;
    this.colladaLoader.load(
      assemblyUrl,
      (collada) => {
        if (this.destroyed || !this.scene || this.droneGroup !== group) {
          return;
        }

        group.children.slice().forEach((child) => {
          group.remove(child);
          this.disposeObject3D(child);
        });

        const visualRoot = collada.scene;
        visualRoot.name = 'Bitcraze Crazyflie 2 assembly';
        const assemblyRoot = new Group();
        assemblyRoot.position.y = -0.015;
        assemblyRoot.add(visualRoot);
        group.add(assemblyRoot);

        this.deckMountGroup = new Group();
        this.deckMountGroup.name = 'Crazyflie deck attachment mount';
        this.deckMountGroup.position.y = -0.015;
        group.add(this.deckMountGroup);
        this.updateDetectedDeckShells(this.detectedDeckTypes);
        this.attitudePreview?.setModel(group);
        this.loadBitcrazePropellers(group);
      },
      undefined,
      (error) => console.warn('Failed to load Bitcraze Crazyflie assembly:', error),
    );
  }

  private loadBitcrazePropellers(group: Group): void {
    const propellerUrl = new URL('./models/crazyflie/ccw_prop.dae', window.location.href).href;
    this.colladaLoader.load(
      propellerUrl,
      (collada) => {
        if (this.destroyed || !this.scene || this.droneGroup !== group) {
          return;
        }
        const positions: Array<{ x: number; z: number; direction: number }> = [
          { x: 0.031, z: 0.031, direction: -1 },
          { x: -0.031, z: 0.031, direction: 1 },
          { x: -0.031, z: -0.031, direction: -1 },
          { x: 0.031, z: -0.031, direction: 1 },
        ];
        this.propellerMeshes = [];
        this.propellerDirections = [];
        positions.forEach(({ x, z, direction }) => {
          const rotor = new Group();
          rotor.name = 'Crazyflie propeller';
          rotor.position.set(x, 0.008, z);
          rotor.add(collada.scene.clone(true));
          group.add(rotor);
          this.propellerMeshes.push(rotor);
          this.propellerDirections.push(direction);
        });
        this.attitudePreview?.setModel(group);
      },
      undefined,
      (error) => console.warn('Failed to load Bitcraze Crazyflie propeller:', error),
    );
  }

  private disposeObject3D(root: Object3D): void {
    root.traverse((node) => {
      const mesh = node as Mesh;
      if (!mesh.isMesh) {
        return;
      }
      mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((material) => {
        Object.values(material).forEach((value: any) => {
          if (value?.isTexture) {
            value.dispose();
          }
        });
        material.dispose();
      });
    });
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
      this.connectionService.detectedDecks$.subscribe((decks) => {
        this.updateDetectedDeckShells(decks);
      }),
    );

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
          this.stepText = this.running ? '运行中…' : '就绪';
          return;
        }
        this.stepText = `步骤 ${step.current}/${step.total}: ${step.label}`;
      }),
    );

    this.subscriptions.push(
      this.simService.logs$.subscribe((logs) => {
        this.logs = logs.slice(-6);
      }),
    );

    this.subscriptions.push(
      this.simService.pose$.subscribe((pose) => {
        if (this.realPoseShown || !this.attitudeActive) this.aircraftYaw = pose.yaw;
        this.targetPosition.set(pose.x, pose.y, pose.z);
        this.telemetry = {
          xCm: Math.round(-pose.x * 100),
          yCm: Math.round(pose.z * 100),
          altitudeCm: Math.max(0, Math.round(pose.y * 100)),
          yawDeg: Math.round(MathUtils.radToDeg(pose.yaw)),
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

  private addMeasureMarker(position: Vector3): void {
    if (!this.scene) {
      return;
    }
    const marker = new Mesh(
      new SphereGeometry(0.045, 12, 8),
      new MeshBasicMaterial({ color: '#39c9dc', depthTest: false }),
    );
    marker.position.copy(position);
    marker.renderOrder = 5;
    this.scene.add(marker);
    this.measureMarkers.push(marker);
  }

  private clearMeasurement(): void {
    if (this.measureLine) {
      this.scene?.remove(this.measureLine);
      this.measureLine.geometry.dispose();
      (this.measureLine.material as LineBasicMaterial).dispose();
      this.measureLine = null;
    }
    this.measureMarkers.forEach((marker) => {
      this.scene?.remove(marker);
      marker.geometry.dispose();
      (marker.material as MeshBasicMaterial).dispose();
    });
    this.measureMarkers = [];
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

  private loadClassroomDeskAsset(): Promise<{ geometry: BufferGeometry; material: MeshStandardMaterial }> {
    if (!this.classroomDeskAssetPromise) {
      const protoUrl = new URL('./models/classroom/Desk.proto', window.location.href).href;
      const extractArray = (source: string, pattern: RegExp, label: string): number[] => {
        const match = pattern.exec(source);
        if (!match) {
          throw new Error(`Desk.proto is missing ${label}`);
        }
        return match[1].trim().split(/\s+/).map(Number);
      };
      const splitFaces = (indices: number[]): number[][] => {
        const faces: number[][] = [];
        let face: number[] = [];
        indices.forEach((index) => {
          if (index === -1) {
            if (face.length >= 3) {
              faces.push(face);
            }
            face = [];
          } else {
            face.push(index);
          }
        });
        if (face.length >= 3) {
          faces.push(face);
        }
        return faces;
      };

      const loadPromise = fetch(protoUrl)
        .then((response) => {
          if (!response.ok) {
            throw new Error(`Desk.proto request failed with status ${response.status}`);
          }
          return response.text();
        })
        .then(async (source) => {
          const coordinates = extractArray(source, /coord Coordinate\s*\{\s*point\s*\[([\s\S]*?)\]/, 'coordinates');
          const textureCoordinates = extractArray(source, /texCoord TextureCoordinate\s*\{\s*point\s*\[([\s\S]*?)\]/, 'texture coordinates');
          const coordinateFaces = splitFaces(extractArray(source, /coordIndex\s*\[([\s\S]*?)\]/, 'coordinate indices'));
          const textureFaces = splitFaces(extractArray(source, /texCoordIndex\s*\[([\s\S]*?)\]/, 'texture indices'));
          if (coordinateFaces.length !== textureFaces.length) {
            throw new Error('Desk.proto coordinate and texture face counts do not match');
          }

          const positions: number[] = [];
          const uvs: number[] = [];
          coordinateFaces.forEach((face, faceIndex) => {
            const uvFace = textureFaces[faceIndex];
            if (face.length !== uvFace.length) {
              throw new Error(`Desk.proto face ${faceIndex} has mismatched UV coordinates`);
            }
            for (let triangle = 1; triangle < face.length - 1; triangle += 1) {
              // Swapping the Y/Z axes reverses handedness, so reverse the face winding too.
              [0, triangle + 1, triangle].forEach((corner) => {
                const vertex = face[corner];
                const uv = uvFace[corner];
                positions.push(coordinates[vertex * 3], coordinates[vertex * 3 + 2], coordinates[vertex * 3 + 1]);
                uvs.push(textureCoordinates[uv * 2], textureCoordinates[uv * 2 + 1]);
              });
            }
          });

          const geometry = new BufferGeometry();
          geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
          geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
          geometry.computeVertexNormals();
          geometry.computeBoundingBox();
          geometry.computeBoundingSphere();

          const textureLoader = new TextureLoader();
          const textureUrl = (name: string) => new URL(`./models/classroom/${name}`, window.location.href).href;
          const [woodMaterial, roughnessMap, metalnessMap, normalMap] = await Promise.all([
            this.loadVarnishedPineMaterial('desk'),
            textureLoader.loadAsync(textureUrl('desk_roughness.jpg')),
            textureLoader.loadAsync(textureUrl('desk_metalness.jpg')),
            textureLoader.loadAsync(textureUrl('desk_normal.jpg')),
          ]);
          if (!woodMaterial.map) {
            throw new Error('Varnished pine material is missing its wood color texture');
          }
          const lightMap = this.createLightClassroomTexture(woodMaterial.map, '#ffffff', 0);
          const context = lightMap.image.getContext('2d')!;
          const maskCanvas = document.createElement('canvas');
          maskCanvas.width = lightMap.image.width;
          maskCanvas.height = lightMap.image.height;
          const maskContext = maskCanvas.getContext('2d')!;
          maskContext.drawImage(metalnessMap.image, 0, 0, maskCanvas.width, maskCanvas.height);
          const maskPixels = maskContext.getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
          const colorPixels = context.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
          for (let pixel = 0; pixel < colorPixels.data.length; pixel += 4) {
            const metalWeight = maskPixels[pixel] / 255;
            for (let channel = 0; channel < 3; channel += 1) {
              const silver = [195, 203, 207][channel];
              colorPixels.data[pixel + channel] = colorPixels.data[pixel + channel] * (1 - metalWeight) + silver * metalWeight;
            }
          }
          context.putImageData(colorPixels, 0, 0);
          lightMap.needsUpdate = true;
          const material = new MeshStandardMaterial({ map: lightMap, roughnessMap, metalnessMap, normalMap, roughness: 0.7, metalness: 0.5 });
          return { geometry, material };
        });

      this.classroomDeskAssetPromise = loadPromise;
      void loadPromise.catch(() => {
        if (this.classroomDeskAssetPromise === loadPromise) {
          this.classroomDeskAssetPromise = null;
        }
      });
    }
    return this.classroomDeskAssetPromise;
  }

  private createLightClassroomTexture(source: { image: CanvasImageSource }, tint: string, opacity: number): CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 1024;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Unable to create classroom texture canvas');
    }
    context.drawImage(source.image, 0, 0, canvas.width, canvas.height);
    context.fillStyle = tint;
    context.globalAlpha = opacity;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    return texture;
  }

  private createClassroomWoodFloor(group: Group, room: { width: number; depth: number }): void {
    const geometry = new PlaneGeometry(room.width, room.depth);
    geometry.setAttribute('uv2', geometry.getAttribute('uv').clone());
    const material = new MeshStandardMaterial({
      color: CLASSROOM_WOOD_FINISHES.floor.tint, roughness: CLASSROOM_WOOD_FINISHES.floor.roughness, metalness: 0,
    });
    const floor = new Mesh(geometry, material);
    floor.name = 'Webots pine classroom floor';
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.012;
    floor.receiveShadow = true;
    group.add(floor);

    this.applyVarnishedPineFinish(floor, 'floor');
  }

  private extractVrmlBlocks(source: string, pattern: RegExp): string[] {
    const blocks: string[] = [];
    let offset = 0;
    while (offset < source.length) {
      pattern.lastIndex = 0;
      const match = pattern.exec(source.slice(offset));
      if (!match) {
        break;
      }
      const start = offset + match.index;
      const openBrace = source.indexOf('{', start);
      if (openBrace < 0) {
        break;
      }
      let depth = 0;
      let end = openBrace;
      for (; end < source.length; end += 1) {
        if (source[end] === '{') {
          depth += 1;
        } else if (source[end] === '}') {
          depth -= 1;
          if (depth === 0) {
            break;
          }
        }
      }
      if (depth !== 0) {
        break;
      }
      blocks.push(source.slice(openBrace + 1, end));
      offset = end + 1;
    }
    return blocks;
  }

  private extractVrmlArray(source: string, field: string): number[] {
    const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`${escapedField}\\s*\\[([\\s\\S]*?)\\]`).exec(source);
    return match ? match[1].trim().split(/\s+/).filter(Boolean).map(Number) : [];
  }

  private splitVrmlFaces(indices: number[]): number[][] {
    const faces: number[][] = [];
    let face: number[] = [];
    indices.forEach((index) => {
      if (index === -1) {
        if (face.length >= 3) {
          faces.push(face);
        }
        face = [];
      } else {
        face.push(index);
      }
    });
    if (face.length >= 3) {
      faces.push(face);
    }
    return faces;
  }

  private loadVarnishedPineMaterial(finish: ClassroomWoodFinish = 'honey'): Promise<MeshStandardMaterial> {
    if (finish !== 'honey') {
      const cached = this.classroomWoodMaterialPromises.get(finish);
      if (cached) return cached;
      const loadPromise = this.loadVarnishedPineMaterial().then((template) => {
        if (!template.map) {
          throw new Error('Varnished pine material is missing its wood color texture');
        }
        const palette = CLASSROOM_WOOD_FINISHES[finish];
        const map = this.createLightClassroomTexture(template.map, palette.tint, palette.opacity);
        map.repeat.copy(template.map.repeat);
        const material = template.clone();
        material.map = map;
        material.roughness = palette.roughness;
        return material;
      });
      this.classroomWoodMaterialPromises.set(finish, loadPromise);
      void loadPromise.catch(() => {
        if (this.classroomWoodMaterialPromises.get(finish) === loadPromise) {
          this.classroomWoodMaterialPromises.delete(finish);
        }
      });
      return loadPromise;
    }
    if (!this.varnishedPineMaterialPromise) {
      const protoUrl = new URL('./models/classroom/appearances/protos/VarnishedPine.proto', window.location.href).href;
      const loadPromise = fetch(protoUrl)
        .then((response) => {
          if (!response.ok) {
            throw new Error(`VarnishedPine.proto request failed with status ${response.status}`);
          }
          return response.text();
        })
        .then(async (source) => {
          const textureUrl = (appearance: string) => {
            const pattern = new RegExp(`${appearance}\\s+ImageTexture\\s*\\{\\s*url\\s*\\[\\s*"([^"]+)"`);
            const match = pattern.exec(source);
            if (!match) {
              throw new Error(`VarnishedPine.proto is missing ${appearance} texture`);
            }
            return new URL(match[1], protoUrl).href;
          };
          const textureLoader = new TextureLoader();
          const [map, roughnessMap, normalMap, aoMap] = await Promise.all([
            textureLoader.loadAsync(textureUrl('baseColorMap')),
            textureLoader.loadAsync(textureUrl('roughnessMap')),
            textureLoader.loadAsync(textureUrl('normalMap')),
            textureLoader.loadAsync(textureUrl('occlusionMap')),
          ]);
          map.colorSpace = SRGBColorSpace;
          [map, roughnessMap, normalMap, aoMap].forEach((texture) => {
            texture.wrapS = RepeatWrapping;
            texture.wrapT = RepeatWrapping;
            texture.repeat.set(3, 3);
          });
          const lightMap = this.createLightClassroomTexture(map, '#dfb270', 0.42);
          lightMap.repeat.copy(map.repeat);
          map.dispose();
          return new MeshStandardMaterial({
            color: '#ffffff',
            map: lightMap,
            roughnessMap,
            normalMap,
            aoMap,
            roughness: 0.7,
            normalScale: new Vector2(0.3, 0.3),
            aoMapIntensity: 0.35,
            metalness: 0,
            side: 2,
          });
        });
      this.varnishedPineMaterialPromise = loadPromise;
      void loadPromise.catch(() => {
        if (this.varnishedPineMaterialPromise === loadPromise) {
          this.varnishedPineMaterialPromise = null;
        }
      });
    }
    return this.varnishedPineMaterialPromise;
  }
  private applyVarnishedPineFinish(root: Object3D, finish: ClassroomWoodFinish = 'honey'): void {
    void this.loadVarnishedPineMaterial(finish).then((template) => {
      if (!this.presetInteriorRoot || !this.presetInteriorRoot.children.includes(root)) {
        let isInCurrentPreset = false;
        this.presetInteriorRoot?.traverse((node) => {
          if (node === root) {
            isInCurrentPreset = true;
          }
        });
        if (!isInCurrentPreset) {
          return;
        }
      }

      const material = template.clone();
      root.traverse((node) => {
        const mesh = node as Mesh;
        if (!mesh.isMesh) {
          return;
        }
        if (mesh.geometry.getAttribute('uv') && !mesh.geometry.getAttribute('uv2')) {
          mesh.geometry.setAttribute('uv2', mesh.geometry.getAttribute('uv').clone());
        }
        const oldMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        oldMaterials.forEach((oldMaterial) => oldMaterial.dispose());
        mesh.material = material;
        mesh.userData.sharedClassroomTextures = true;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      });
    }).catch((error) => console.error('Failed to apply Webots varnished pine material:', error));
  }

  private loadClassroomProtoAsset(protoPath: string): Promise<Group> {
    const cached = this.classroomProtoAssetPromises.get(protoPath);
    if (cached) {
      return cached;
    }

    const protoUrl = new URL(`./models/classroom/${protoPath}`, window.location.href).href;
    const loadPromise = fetch(protoUrl)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`${protoPath} request failed with status ${response.status}`);
        }
        return response.text();
      })
      .then(async (source) => {
        const shapes = this.extractVrmlBlocks(source, /\bShape\s*\{/g);
        const root = new Group();
        const textureLoader = new TextureLoader();
        for (let shapeIndex = 0; shapeIndex < shapes.length; shapeIndex += 1) {
          const shape = shapes[shapeIndex];
          const geometryBlock = this.extractVrmlBlocks(shape, /\bgeometry\s+IndexedFaceSet\s*\{/g)[0];
          if (!geometryBlock) {
            continue;
          }
          const coordinateBlock = this.extractVrmlBlocks(geometryBlock, /\bcoord\s+Coordinate\s*\{/g)[0];
          const textureCoordinateBlock = this.extractVrmlBlocks(geometryBlock, /\btexCoord\s+TextureCoordinate\s*\{/g)[0];
          const coordinates = this.extractVrmlArray(coordinateBlock || '', 'point');
          const textureCoordinates = this.extractVrmlArray(textureCoordinateBlock || '', 'point');
          const coordinateFaces = this.splitVrmlFaces(this.extractVrmlArray(geometryBlock, 'coordIndex'));
          const textureFaces = this.splitVrmlFaces(this.extractVrmlArray(geometryBlock, 'texCoordIndex'));
          if (coordinates.length < 9 || coordinateFaces.length === 0) {
            continue;
          }
          if (textureCoordinates.length > 0 && coordinateFaces.length !== textureFaces.length) {
            throw new Error(`${protoPath} shape ${shapeIndex} has mismatched texture faces`);
          }
          const imageMatch = /ImageTexture\s*\{\s*url\s*\[\s*"([^"]+)"/.exec(shape);
          const protoTextureMatch = /field\s+MFString\s+textureUrl\s+"([^"]+)"/.exec(source);
          const imagePath = imageMatch?.[1] || protoTextureMatch?.[1] || null;
          const projectionAxes = [0, 1, 2].map((axis) => {
            let min = Number.POSITIVE_INFINITY;
            let max = Number.NEGATIVE_INFINITY;
            for (let vertex = axis; vertex < coordinates.length; vertex += 3) {
              min = Math.min(min, coordinates[vertex]);
              max = Math.max(max, coordinates[vertex]);
            }
            return { axis, min, range: Math.max(max - min, 1e-6) };
          }).sort((left, right) => right.range - left.range).slice(0, 2);

          const transformMatch = /TextureTransform\s*\{\s*scale\s+([-+\d.eE]+)\s+([-+\d.eE]+)/.exec(shape);
          const textureScaleU = transformMatch ? Number(transformMatch[1]) : 1;
          const textureScaleV = transformMatch ? Number(transformMatch[2]) : 1;
          const positions: number[] = [];
          const uvs: number[] = [];
          coordinateFaces.forEach((face, faceIndex) => {
            const uvFace = textureFaces[faceIndex] || face;
            if (textureCoordinates.length > 0 && face.length !== uvFace.length) {
              throw new Error(`${protoPath} shape ${shapeIndex} face ${faceIndex} has mismatched UVs`);
            }
            for (let triangle = 1; triangle < face.length - 1; triangle += 1) {
              [0, triangle, triangle + 1].forEach((corner) => {
                const vertex = face[corner];
                positions.push(coordinates[vertex * 3], coordinates[vertex * 3 + 2], -coordinates[vertex * 3 + 1]);
                if (textureCoordinates.length > 0) {
                  const uv = uvFace[corner];
                  uvs.push(textureCoordinates[uv * 2] * textureScaleU, textureCoordinates[uv * 2 + 1] * textureScaleV);
                } else if (imagePath) {
                  const uAxis = projectionAxes[0];
                  const vAxis = projectionAxes[1];
                  uvs.push(
                    ((coordinates[vertex * 3 + uAxis.axis] - uAxis.min) / uAxis.range) * textureScaleU,
                    ((coordinates[vertex * 3 + vAxis.axis] - vAxis.min) / vAxis.range) * textureScaleV,
                  );
                }
              });
            }
          });

          const geometry = new BufferGeometry();
          geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
          if (uvs.length > 0) {
            const uvAttribute = new Float32BufferAttribute(uvs, 2);
            geometry.setAttribute('uv', uvAttribute);
            geometry.setAttribute('uv2', uvAttribute.clone());
          }
          geometry.computeVertexNormals();
          geometry.computeBoundingBox();
          geometry.computeBoundingSphere();

          let material: MeshStandardMaterial;
          if (/\bVarnishedPine\b/.test(shape)) {
            material = (await this.loadVarnishedPineMaterial()).clone();
          } else {
            if (imagePath) {
              const map = await textureLoader.loadAsync(new URL(imagePath, protoUrl).href);
              map.colorSpace = SRGBColorSpace;
              map.wrapS = RepeatWrapping;
              map.wrapT = RepeatWrapping;
              material = new MeshStandardMaterial({ map, roughness: 1, side: 2 });
            } else {
              material = new MeshStandardMaterial({ color: '#73736e', roughness: 0.9, side: 2 });
            }
          }
          const mesh = new Mesh(geometry, material);
          mesh.name = `${protoPath} shape ${shapeIndex}`;
          mesh.userData.sharedClassroomAsset = true;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          root.add(mesh);
        }
        if (root.children.length === 0) {
          throw new Error(`${protoPath} contains no supported IndexedFaceSet shapes`);
        }
        return root;
      });

    this.classroomProtoAssetPromises.set(protoPath, loadPromise);
    void loadPromise.catch(() => this.classroomProtoAssetPromises.delete(protoPath));
    return loadPromise;
  }

  private ensureTrailLine(): void {
    if (!this.scene || this.trailLine) {
      return;
    }

    const theme = this.trailThemes[this.trailThemeIndex];

    const historyGeometry = new BufferGeometry().setFromPoints([]);
    const historyMaterial = new LineDashedMaterial({ color: theme.history, transparent: true, opacity: 0.45, linewidth: 2, dashSize: 0.08, gapSize: 0.05 });
    this.trailHistoryLine = new Line(historyGeometry, historyMaterial);
    this.trailHistoryLine.visible = this.flightPathVisible;
    this.trailHistoryLine.computeLineDistances();
    this.scene.add(this.trailHistoryLine);

    const geometry = new BufferGeometry().setFromPoints([]);
    const material = new LineBasicMaterial({ color: theme.primary, transparent: true, opacity: 0.95, linewidth: 3 });
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
        color: theme.primary,
        emissive: theme.tubeEmissive,
        emissiveIntensity: 0.35,
        roughness: 0.38,
        metalness: 0.08,
        transparent: true,
        opacity: 0.98,
      }),
    );
    this.trailTubeMesh.visible = false;
    this.scene.add(this.trailTubeMesh);

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
        const historyPoints = this.trailPoints.slice(0, Math.max(0, this.trailPoints.length - this.trailRecentPoints + 1));
        this.trailHistoryLine.geometry.dispose();
        this.trailHistoryLine.geometry = new BufferGeometry().setFromPoints(historyPoints);
        this.trailHistoryLine.computeLineDistances();
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
    }
  }

  private applyTrailTheme(): void {
    const theme = this.trailThemes[this.trailThemeIndex];

    if (this.trailHistoryLine) {
      const mat = this.trailHistoryLine.material as LineDashedMaterial;
      mat.color.set(theme.history);
      mat.needsUpdate = true;
    }

    if (this.trailLine) {
      const mat = this.trailLine.material as LineBasicMaterial;
      mat.color.set(theme.primary);
      mat.needsUpdate = true;
    }

    if (this.trailTubeMesh) {
      const mat = this.trailTubeMesh.material as MeshStandardMaterial;
      mat.color.set(theme.primary);
      mat.emissive.set(theme.tubeEmissive);
      mat.needsUpdate = true;
    }

  }

  private createAircraftBulletinTexture(group: Group): CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 2400;
    canvas.height = 960;
    const context = canvas.getContext('2d');
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    if (!context) {
      return texture;
    }
    context.fillStyle = '#244a43';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#f5e6a0';
    context.font = 'bold 64px "Microsoft YaHei", sans-serif';
    context.fillText('认识飞行器与扩展甲板  |  Crazyflie & Decks', 65, 100);
    context.strokeStyle = '#8aafa2';
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(65, 132);
    context.lineTo(2335, 132);
    context.stroke();

    const exhibits = [
      { file: 'crazyflie-2-1-plus.jpg', title: 'Crazyflie 2.1+', lines: ['29 g 掌上开源飞行开发平台', '支持无线通信与自动识别扩展甲板'], x: 65, y: 180, imageSize: 530, textX: 65, textY: 780 },
      { file: 'flow-v2.jpg', title: 'Flow deck v2', lines: ['光流测量水平位移', '向下 ToF 测量离地距离'], x: 780, y: 190, imageSize: 235, textX: 1050, textY: 240 },
      { file: 'multiranger.jpg', title: 'Multiranger deck', lines: ['测量前、后、左、右、上', '五个方向的物体距离'], x: 1570, y: 190, imageSize: 235, textX: 1840, textY: 240 },
      { file: 'led-ring.jpg', title: 'LED-ring deck', lines: ['12 颗朝下 RGB 彩灯', '可编程颜色与灯光效果'], x: 780, y: 540, imageSize: 235, textX: 1050, textY: 590 },
      { file: 'buzzer.jpg', title: 'Buzzer deck', lines: ['压电蜂鸣器', '播放提示音、音调与旋律'], x: 1570, y: 540, imageSize: 235, textX: 1840, textY: 590 },
    ];
    for (const exhibit of exhibits) {
      context.fillStyle = '#ffffff';
      context.fillRect(exhibit.x, exhibit.y, exhibit.imageSize, exhibit.imageSize);
      context.fillStyle = '#f6e8ba';
      context.font = 'bold 40px "Microsoft YaHei", sans-serif';
      context.fillText(exhibit.title, exhibit.textX, exhibit.textY);
      context.fillStyle = '#e3eee8';
      context.font = '32px "Microsoft YaHei", sans-serif';
      exhibit.lines.forEach((line, index) => {
        context.fillText(line, exhibit.textX, exhibit.textY + 54 + index * 46);
      });
      const image = new Image();
      image.onload = () => {
        if (this.presetInteriorRoot !== group) {
          return;
        }
        const inset = 8;
        const available = exhibit.imageSize - inset * 2;
        const scale = Math.min(available / image.naturalWidth, available / image.naturalHeight);
        const width = image.naturalWidth * scale;
        const height = image.naturalHeight * scale;
        context.drawImage(image, exhibit.x + (exhibit.imageSize - width) / 2, exhibit.y + (exhibit.imageSize - height) / 2, width, height);
        texture.needsUpdate = true;
      };
      image.onerror = () => console.warn(`Failed to load bulletin photograph: ${exhibit.file}`);
      image.src = new URL(`./models/classroom/bitcraze/${exhibit.file}`, window.location.href).href;
    }
    context.fillStyle = '#bacfc6';
    context.font = '24px "Microsoft YaHei", sans-serif';
    context.fillText('产品照片及资料来源：Bitcraze  ·  store.bitcraze.io  ·  Deck 组合需核对官方兼容性说明', 65, 932);
    texture.needsUpdate = true;
    return texture;
  }

  private createClassroomGround(room: { width: number; depth: number }): Group {
    const ground = new Group();
    ground.name = 'Classroom outdoor ground';
    const width = Math.max(60, room.width + 40);
    const depth = Math.max(60, room.depth + 40);
    const soil = new Mesh(
      new BoxGeometry(width, 0.3, depth),
      new MeshStandardMaterial({ color: '#927b58', roughness: 1 }),
    );
    soil.position.y = -0.17;
    ground.add(soil);

    const strips = [
      { width, depth: (depth - room.depth) / 2, x: 0, z: -(depth + room.depth) / 4 },
      { width, depth: (depth - room.depth) / 2, x: 0, z: (depth + room.depth) / 4 },
      { width: (width - room.width) / 2, depth: room.depth, x: -(width + room.width) / 4, z: 0 },
      { width: (width - room.width) / 2, depth: room.depth, x: (width + room.width) / 4, z: 0 },
    ];
    for (const strip of strips) {
      const grass = new Mesh(
        new PlaneGeometry(strip.width, strip.depth),
        new MeshStandardMaterial({ color: '#91ad73', roughness: 1 }),
      );
      grass.name = 'Outdoor grass';
      grass.rotation.x = -Math.PI / 2;
      grass.position.set(strip.x, 0.004, strip.z);
      grass.receiveShadow = true;
      ground.add(grass);
    }
    return ground;
  }

  private createParkingLot(room: { width: number }): Group {
    const parking = new Group();
    parking.name = 'Outdoor parking lot';
    parking.position.set(-room.width / 2 - 11, 0, 0);
    const asphalt = new Mesh(
      new BoxGeometry(18, 0.08, 24),
      new MeshStandardMaterial({ color: '#555d65', roughness: 0.98 }),
    );
    asphalt.position.y = 0.05;
    asphalt.receiveShadow = true;
    parking.add(asphalt);

    const stripeMaterial = new MeshStandardMaterial({ color: '#f4f0df', roughness: 0.9 });
    const curbMaterial = new MeshStandardMaterial({ color: '#c6c9c6', roughness: 0.95 });
    for (const side of [-1, 1]) {
      const curb = new Mesh(new BoxGeometry(0.2, 0.18, 24), curbMaterial);
      curb.position.set(side * 8.8, 0.18, 0);
      parking.add(curb);
      for (let index = 0; index <= 8; index += 1) {
        const divider = new Mesh(new BoxGeometry(5, 0.006, 0.08), stripeMaterial);
        divider.name = 'Parking bay divider';
        divider.position.set(side * 5.5, 0.094, -10 + index * 2.5);
        parking.add(divider);
      }
      const backLine = new Mesh(new BoxGeometry(0.08, 0.006, 20), stripeMaterial);
      backLine.position.set(side * 8, 0.094, 0);
      parking.add(backLine);
      for (let index = 0; index < 8; index += 1) {
        const stop = new Mesh(new BoxGeometry(0.16, 0.12, 1.6), curbMaterial);
        stop.name = 'Parking wheel stop';
        stop.position.set(side * 7.5, 0.15, -8.75 + index * 2.5);
        parking.add(stop);
      }
    }

    const arrowMaterial = new MeshStandardMaterial({ color: '#f4cf63', roughness: 0.9 });
    for (const direction of [-1, 1]) {
      const arrow = new Group();
      arrow.name = 'Parking lane direction';
      arrow.position.set(-direction * 1.4, 0.094, direction * 6);
      arrow.rotation.y = direction === 1 ? 0 : Math.PI;
      const shaft = new Mesh(new BoxGeometry(0.12, 0.006, 1.4), arrowMaterial);
      arrow.add(shaft);
      for (const side of [-1, 1]) {
        const head = new Mesh(new BoxGeometry(0.12, 0.006, 0.75), arrowMaterial);
        head.position.set(side * 0.24, 0, 0.46);
        head.rotation.y = -side * Math.PI / 4;
        arrow.add(head);
      }
      parking.add(arrow);
    }
    const parkedBays = [
      { side: -1, bay: 0, color: '#8fa9bb' },
      { side: -1, bay: 3, color: '#eee6d9' },
      { side: -1, bay: 6, color: '#a55947' },
      { side: 1, bay: 0, color: '#477caa' },
      { side: 1, bay: 2, color: '#556e63' },
      { side: 1, bay: 5, color: '#e1c38b' },
    ];
    for (const { side, bay, color } of parkedBays) {
      const car = this.createParkedCar(color);
      car.position.set(side * 5.5, 0.07, -8.75 + bay * 2.5);
      car.rotation.y = side === 1 ? 0 : Math.PI;
      parking.add(car);
    }
    for (const side of [-1, 1]) {
      for (const end of [-1, 1]) {
        const pole = new Mesh(new CylinderGeometry(0.055, 0.085, 3.7, 10), curbMaterial);
        pole.name = 'Parking lamp post';
        pole.position.set(side * 8.5, 1.94, end * 11.25);
        parking.add(pole);
        const lamp = new Mesh(new BoxGeometry(0.65, 0.1, 0.3), curbMaterial);
        lamp.position.set(side * 8.3, 3.82, end * 11.25);
        parking.add(lamp);
        const lens = new Mesh(new PlaneGeometry(0.52, 0.22),
          new MeshStandardMaterial({ color: '#fff2cd', emissive: '#fff2cd', emissiveIntensity: 0.25 }));
        lens.rotation.x = Math.PI / 2;
        lens.position.set(side * 8.3, 3.765, end * 11.25);
        parking.add(lens);
        const bollard = new Mesh(new CylinderGeometry(0.08, 0.08, 0.7, 10), arrowMaterial);
        bollard.name = 'Parking entry bollard';
        bollard.position.set(side * 3.25, 0.44, end * 11.3);
        parking.add(bollard);
      }
      for (let stripe = 0; stripe < 8; stripe += 1) {
        const crossing = new Mesh(new BoxGeometry(0.45, 0.006, 1.1), stripeMaterial);
        crossing.name = 'Parking pedestrian crossing';
        crossing.position.set(-2.45 + stripe * 0.7, 0.094, side * 10.4);
        parking.add(crossing);
      }
    }
    return parking;
  }

  private createParkedCar(color: string): Group {
    const car = new Group();
    car.name = 'Parked car';
    const paint = new MeshStandardMaterial({ color, roughness: 0.32, metalness: 0.3 });
    const glass = new MeshStandardMaterial({ color: '#334c5a', roughness: 0.2, metalness: 0.35 });
    const rubber = new MeshStandardMaterial({ color: '#303437', roughness: 0.95 });
    const alloy = new MeshStandardMaterial({ color: '#b8c1c5', roughness: 0.3, metalness: 0.75 });
    const body = new Mesh(new RoundedBoxGeometry(4.15, 0.65, 1.72, 2, 0.16), paint);
    body.position.y = 0.67;
    car.add(body);
    const cabin = new Mesh(new RoundedBoxGeometry(2.1, 0.63, 1.5, 2, 0.16), glass);
    cabin.position.set(-0.05, 1.16, 0);
    car.add(cabin);
    const roof = new Mesh(new RoundedBoxGeometry(1.72, 0.075, 1.42, 2, 0.035), paint);
    roof.position.set(-0.05, 1.49, 0);
    car.add(roof);
    for (const side of [-1, 1]) {
      const pillar = new Mesh(new BoxGeometry(0.08, 0.56, 0.035), paint);
      pillar.position.set(0.05, 1.17, side * 0.75);
      car.add(pillar);
      const mirror = new Mesh(new RoundedBoxGeometry(0.18, 0.12, 0.16, 2, 0.045), paint);
      mirror.position.set(-0.8, 1.04, side * 0.87);
      car.add(mirror);
      for (const axle of [-1, 1]) {
        const tire = new Mesh(new CylinderGeometry(0.3, 0.3, 0.19, 16), rubber);
        tire.name = 'Car tire';
        tire.rotation.x = Math.PI / 2;
        tire.position.set(axle * 1.3, 0.32, side * 0.82);
        car.add(tire);
        const rim = new Mesh(new CylinderGeometry(0.18, 0.18, 0.012, 12), alloy);
        rim.rotation.x = Math.PI / 2;
        rim.position.set(axle * 1.3, 0.32, side * 0.923);
        car.add(rim);
      }
      for (const end of [-1, 1]) {
        const headlight = new Mesh(new RoundedBoxGeometry(0.025, 0.14, 0.38, 2, 0.008),
          new MeshStandardMaterial({ color: end === -1 ? '#f6ebc9' : '#a84336', roughness: 0.3 }));
        headlight.position.set(end * 2.066, 0.75, side * 0.55);
        car.add(headlight);
      }
    }
    for (const end of [-1, 1]) {
      const bumper = new Mesh(new BoxGeometry(0.025, 0.14, 1.4), rubber);
      bumper.position.set(end * 2.07, 0.49, 0);
      car.add(bumper);
      const plate = new Mesh(new BoxGeometry(0.03, 0.1, 0.34), alloy);
      plate.position.set(end * 2.087, 0.64, 0);
      car.add(plate);
    }
    car.traverse((node) => {
      if (node instanceof Mesh) {
        node.castShadow = true;
        node.receiveShadow = true;
      }
    });
    return car;
  }

  private createBleachers(room: { width: number }): Group {
    const stand = new Group();
    stand.name = 'Basketball spectator stand';
    stand.position.set(room.width / 2 + 10.5, 0, 17);
    const concrete = new MeshStandardMaterial({ color: '#bcc3c7', roughness: 0.95 });
    const seatMaterial = new MeshStandardMaterial({ color: '#4287aa', roughness: 0.75 });
    const steel = new MeshStandardMaterial({ color: '#667986', roughness: 0.5, metalness: 0.55 });
    for (let row = 0; row < 4; row += 1) {
      const height = (row + 1) * 0.35;
      for (const side of [-1, 1]) {
        const tier = new Mesh(new BoxGeometry(6.4, height, 0.9), concrete);
        tier.name = 'Spectator tier';
        tier.position.set(side * 3.8, 0.004 + height / 2, row * 0.9 + 0.45);
        tier.receiveShadow = true;
        stand.add(tier);
        const bench = new Mesh(new BoxGeometry(5.8, 0.08, 0.4), seatMaterial);
        bench.name = 'Spectator bench';
        bench.position.set(side * 3.6, height + 0.2, row * 0.9 + 0.55);
        stand.add(bench);
        for (const x of [-2.4, 2.4]) {
          const leg = new Mesh(new BoxGeometry(0.08, 0.16, 0.28), steel);
          leg.position.set(side * 3.6 + x, height + 0.084, row * 0.9 + 0.55);
          stand.add(leg);
        }
      }
      const step = new Mesh(new BoxGeometry(1.2, 0.175, 0.45), concrete);
      step.name = 'Central aisle step';
      step.position.set(0, height - 0.0835, row * 0.9 + 0.225);
      stand.add(step);
      const landing = new Mesh(new BoxGeometry(1.2, height, 0.45), concrete);
      landing.position.set(0, 0.004 + height / 2, row * 0.9 + 0.675);
      stand.add(landing);
    }
    for (const x of [-6.9, -3.45, 0, 3.45, 6.9]) {
      const post = new Mesh(new BoxGeometry(0.06, 1.1, 0.06), steel);
      post.position.set(x, 1.954, 3.55);
      stand.add(post);
    }
    for (const y of [1.95, 2.48]) {
      const rail = new Mesh(new BoxGeometry(13.86, 0.06, 0.06), steel);
      rail.position.set(0, y, 3.55);
      stand.add(rail);
    }
    return stand;
  }

  private createBasketballCourt(room: { width: number }): Group {
    const court = new Group();
    court.name = 'Outdoor basketball court';
    court.position.set(room.width / 2 + 10.5, 0, 0);
    const surface = new Mesh(
      new BoxGeometry(17, 0.08, 30),
      new MeshStandardMaterial({ color: '#b36b50', roughness: 0.95 }),
    );
    surface.position.y = 0.05;
    surface.receiveShadow = true;
    court.add(surface);
    const playingArea = new Mesh(
      new PlaneGeometry(15, 28),
      new MeshStandardMaterial({ color: '#548b88', roughness: 0.95 }),
    );
    playingArea.rotation.x = -Math.PI / 2;
    playingArea.position.y = 0.091;
    court.add(playingArea);

    const lineMaterial = new LineBasicMaterial({ color: '#fff5df' });
    const addLine = (points: Vector3[]) => {
      const line = new Line(new BufferGeometry().setFromPoints(points), lineMaterial);
      court.add(line);
    };
    const point = (x: number, z: number) => new Vector3(x, 0.096, z);
    const arc = (x: number, z: number, radius: number, start: number, end: number) => {
      const points = Array.from({ length: 65 }, (_, index) => {
        const angle = start + (end - start) * index / 64;
        return point(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius);
      });
      addLine(points);
    };
    addLine([point(-7.5, -14), point(7.5, -14), point(7.5, 14), point(-7.5, 14), point(-7.5, -14)]);
    addLine([point(-7.5, 0), point(7.5, 0)]);
    arc(0, 0, 1.8, 0, Math.PI * 2);

    for (const side of [-1, 1]) {
      const end = side * 14;
      const freeThrow = side * 8.2;
      const key = new Mesh(
        new PlaneGeometry(4.9, 5.8),
        new MeshStandardMaterial({ color: '#ba785b', roughness: 0.95 }),
      );
      key.rotation.x = -Math.PI / 2;
      key.position.set(0, 0.093, side * 11.1);
      court.add(key);
      addLine([point(-2.45, end), point(-2.45, freeThrow), point(2.45, freeThrow), point(2.45, end)]);
      arc(0, freeThrow, 1.8, 0, Math.PI * 2);
      const basketZ = side * 12.425;
      const cornerAngle = Math.acos(6.6 / 6.75);
      arc(0, basketZ, 6.75,
        side === 1 ? -Math.PI + cornerAngle : cornerAngle,
        side === 1 ? -cornerAngle : Math.PI - cornerAngle);
      const cornerZ = basketZ - side * Math.sin(cornerAngle) * 6.75;
      for (const x of [-6.6, 6.6]) addLine([point(x, end), point(x, cornerZ)]);

      const hoop = new Group();
      hoop.name = 'Basketball hoop';
      const steel = new MeshStandardMaterial({ color: '#566a78', roughness: 0.55, metalness: 0.5 });
      const post = new Mesh(new CylinderGeometry(0.09, 0.12, 3.7, 10), steel);
      post.position.set(0, 1.94, side * 14.6);
      hoop.add(post);
      const arm = new Mesh(new BoxGeometry(0.12, 0.12, 1.4), steel);
      arm.position.set(0, 3.6, side * 13.9);
      hoop.add(arm);
      const board = new Mesh(
        new BoxGeometry(1.8, 1.05, 0.06),
        new MeshStandardMaterial({ color: '#f1f3ed', roughness: 0.65 }),
      );
      board.position.set(0, 3.665, side * 13.2);
      hoop.add(board);
      const target = [
        new Vector3(-0.295, 3.14, side * 13.16),
        new Vector3(-0.295, 3.59, side * 13.16),
        new Vector3(0.295, 3.59, side * 13.16),
        new Vector3(0.295, 3.14, side * 13.16),
        new Vector3(-0.295, 3.14, side * 13.16),
      ];
      hoop.add(new Line(new BufferGeometry().setFromPoints(target),
        new LineBasicMaterial({ color: '#b44e32' })));
      const rim = new Mesh(
        new TorusGeometry(0.225, 0.018, 8, 32),
        new MeshStandardMaterial({ color: '#e66b29', roughness: 0.6 }),
      );
      rim.rotation.x = Math.PI / 2;
      rim.position.set(0, 3.14, side * 12.9);
      hoop.add(rim);
      court.add(hoop);
    }
    const props = new Group();
    props.name = 'Basketball sideline equipment';
    const steel = new MeshStandardMaterial({ color: '#5d717a', roughness: 0.48, metalness: 0.5 });
    const wood = new MeshStandardMaterial({ color: '#b38b5b', roughness: 0.78 });
    for (const z of [-6, 6]) {
      const bench = new Group();
      bench.name = 'Court sideline bench';
      bench.position.set(-8.05, 0.09, z);
      const seat = new Mesh(new RoundedBoxGeometry(0.42, 0.055, 2.4, 2, 0.018), wood);
      seat.position.y = 0.43;
      bench.add(seat);
      for (const end of [-1, 1]) {
        const support = new Mesh(new BoxGeometry(0.34, 0.4, 0.065), steel);
        support.position.set(0, 0.2, end * 0.9);
        bench.add(support);
      }
      props.add(bench);
    }
    const coneMaterial = new MeshStandardMaterial({ color: '#da793b', roughness: 0.85 });
    for (const z of [-10.5, -7.5, -4.5, -1.5]) {
      const cone = new Group();
      cone.name = 'Basketball training cone';
      cone.position.set(8.05, 0.094, z);
      const base = new Mesh(new BoxGeometry(0.22, 0.025, 0.22), coneMaterial);
      base.position.y = 0.0125;
      const tip = new Mesh(new CylinderGeometry(0.015, 0.085, 0.27, 12), coneMaterial);
      tip.position.y = 0.16;
      cone.add(base, tip);
      props.add(cone);
    }
    const cart = new Group();
    cart.name = 'Basketball ball cart';
    cart.position.set(8.05, 0.094, 9.5);
    const tray = new Mesh(new BoxGeometry(0.52, 0.035, 0.9), steel);
    tray.position.y = 0.28;
    cart.add(tray);
    for (const x of [-0.25, 0.25]) {
      for (const z of [-0.43, 0.43]) {
        const upright = new Mesh(new CylinderGeometry(0.012, 0.012, 0.6, 8), steel);
        upright.position.set(x, 0.34, z);
        cart.add(upright);
        const wheel = new Mesh(new SphereGeometry(0.05, 8, 6),
          new MeshStandardMaterial({ color: '#353d43', roughness: 0.95 }));
        wheel.position.set(x, 0.05, z);
        cart.add(wheel);
      }
      const rail = new Mesh(new BoxGeometry(0.025, 0.025, 0.9), steel);
      rail.position.set(x, 0.58, 0);
      cart.add(rail);
    }
    for (const z of [-0.27, 0, 0.27]) {
      const ball = this.createBasketball();
      ball.position.set(0, 0.42, z);
      cart.add(ball);
    }
    props.add(cart);
    const spareBall = this.createBasketball();
    spareBall.position.set(-8.05, 0.214, 8.1);
    props.add(spareBall);
    props.traverse((node) => {
      if (node instanceof Mesh) {
        node.castShadow = true;
        node.receiveShadow = true;
      }
    });
    court.add(props);
    return court;
  }

  private createBasketball(): Group {
    const ball = new Group();
    ball.name = 'Basketball';
    ball.add(new Mesh(new SphereGeometry(0.12, 20, 12),
      new MeshStandardMaterial({ color: '#b9652f', roughness: 0.95 })));
    const seamMaterial = new MeshStandardMaterial({ color: '#3e3028', roughness: 1 });
    for (let axis = 0; axis < 3; axis += 1) {
      const seam = new Mesh(new TorusGeometry(0.12, 0.002, 4, 32), seamMaterial);
      if (axis === 1) seam.rotation.x = Math.PI / 2;
      if (axis === 2) seam.rotation.y = Math.PI / 2;
      ball.add(seam);
    }
    return ball;
  }

  private createClassroomTrees(room: { width: number; depth: number }): Group {
    const outdoors = new Group();
    outdoors.name = 'Classroom outdoor trees';
    for (const side of [-1, 1]) {
      for (let index = 0; index < 3; index += 1) {
        const tree = new Group();
        tree.name = 'Outdoor tree';
        tree.position.set(
          (index - 1) * room.width * 0.3,
          0,
          side * (room.depth / 2 + 2.2),
        );
        const height = 3.0 + index * 0.25;
        const trunk = new Mesh(
          new CylinderGeometry(0.065, 0.12, height * 0.65, 8),
          new MeshStandardMaterial({ color: '#856047', roughness: 0.95 }),
        );
        trunk.position.y = height * 0.325;
        tree.add(trunk);

        const crowns = [
          { x: -0.3, y: height * 0.65, z: 0.05, radius: 0.65, color: '#568749' },
          { x: 0.32, y: height * 0.7, z: -0.08, radius: 0.62, color: '#699a52' },
          { x: 0, y: height * 0.84, z: 0, radius: 0.7, color: '#77a65b' },
        ];
        for (const crown of crowns) {
          const foliage = new Mesh(
            new SphereGeometry(crown.radius, 12, 8),
            new MeshStandardMaterial({ color: crown.color, roughness: 1 }),
          );
          foliage.position.set(crown.x, crown.y, crown.z);
          foliage.scale.y = 1.1;
          tree.add(foliage);
        }
        outdoors.add(tree);
      }
    }
    return outdoors;
  }

  private createClassroomLighting(): Group {
    const lights = new Group();
    lights.name = 'Classroom soft ambient lighting';
    lights.add(
      new AmbientLight('#fff7eb', 0.65),
      new HemisphereLight('#e5f0ff', '#9a8166', 0.85),
    );
    return lights;
  }

  private createClassroomChair(): Group {
    const chair = new Group();
    chair.name = 'School chair';
    const wood = new MeshStandardMaterial({
      color: CLASSROOM_WOOD_FINISHES.chair.tint, roughness: CLASSROOM_WOOD_FINISHES.chair.roughness,
    });
    const steel = new MeshStandardMaterial({ color: '#b9c7cd', roughness: 0.32, metalness: 0.65 });
    const rubber = new MeshStandardMaterial({ color: '#454b4e', roughness: 0.95 });
    const seat = new Mesh(new RoundedBoxGeometry(0.32, 0.032, 0.33, 2, 0.012), wood);
    seat.name = 'Chair wood seat';
    seat.position.y = 0.45;
    chair.add(seat);
    const back = new Mesh(new RoundedBoxGeometry(0.026, 0.19, 0.31, 2, 0.01), wood);
    back.name = 'Chair wood back';
    back.position.set(0.154, 0.65, 0);
    back.rotation.z = -0.08;
    chair.add(back);

    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const foot = new Vector3(sx * 0.14, 0.032, sz * 0.135);
        const top = new Vector3(sx * 0.115, 0.434, sz * 0.12);
        const leg = new Mesh(new CylinderGeometry(0.011, 0.012, foot.distanceTo(top), 10), steel);
        leg.name = 'Chair steel leg';
        leg.position.copy(foot).add(top).multiplyScalar(0.5);
        leg.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), top.sub(foot).normalize());
        chair.add(leg);
        const cap = new Mesh(new CylinderGeometry(0.014, 0.014, 0.04, 10), rubber);
        cap.name = 'Chair rubber foot';
        cap.position.set(foot.x, 0.032, foot.z);
        chair.add(cap);
      }
    }
    for (const side of [-1, 1]) {
      const brace = new Mesh(new CylinderGeometry(0.009, 0.009, 0.26, 10), steel);
      brace.name = 'Chair side brace';
      brace.rotation.z = Math.PI / 2;
      brace.position.set(0, 0.23, side * 0.128);
      chair.add(brace);
    }
    const framePath = new CurvePath<Vector3>();
    framePath.add(new LineCurve3(new Vector3(0.13, 0.43, -0.17), new Vector3(0.16, 0.72, -0.17)));
    framePath.add(new QuadraticBezierCurve3(
      new Vector3(0.16, 0.72, -0.17), new Vector3(0.165, 0.765, -0.17), new Vector3(0.165, 0.765, -0.125)));
    framePath.add(new LineCurve3(new Vector3(0.165, 0.765, -0.125), new Vector3(0.165, 0.765, 0.125)));
    framePath.add(new QuadraticBezierCurve3(
      new Vector3(0.165, 0.765, 0.125), new Vector3(0.165, 0.765, 0.17), new Vector3(0.16, 0.72, 0.17)));
    framePath.add(new LineCurve3(new Vector3(0.16, 0.72, 0.17), new Vector3(0.13, 0.43, 0.17)));
    const frame = new Mesh(new TubeGeometry(framePath, 32, 0.012, 8, false), steel);
    frame.name = 'Chair bent steel back frame';
    chair.add(frame);
    const plate = new Mesh(new RoundedBoxGeometry(0.003, 0.026, 0.064, 1, 0.001), steel);
    plate.name = 'Chair nameplate';
    plate.position.set(0.139, 0.66, 0);
    chair.add(plate);
    return chair;
  }

  private createClassroomDeskDrawer(): Group {
    const drawer = new Group();
    drawer.name = 'School desk drawer';
    const wood = new MeshStandardMaterial({
      color: CLASSROOM_WOOD_FINISHES.desk.tint, roughness: CLASSROOM_WOOD_FINISHES.desk.roughness,
    });
    const body = new Mesh(new BoxGeometry(0.31, 0.085, 0.47), wood);
    body.name = 'Drawer wood body';
    body.position.set(0.025, 0.643, 0);
    drawer.add(body);
    const seam = new Mesh(new BoxGeometry(0.006, 0.09, 0.49),
      new MeshStandardMaterial({ color: '#675442', roughness: 0.9 }));
    seam.name = 'Drawer reveal';
    seam.position.set(0.183, 0.643, 0);
    drawer.add(seam);
    const front = new Mesh(new RoundedBoxGeometry(0.018, 0.087, 0.476, 2, 0.005), wood);
    front.name = 'Drawer wood front';
    front.position.set(0.19, 0.643, 0);
    drawer.add(front);
    const handle = new Mesh(new RoundedBoxGeometry(0.018, 0.012, 0.095, 2, 0.004),
      new MeshStandardMaterial({ color: '#a8b6bd', roughness: 0.35, metalness: 0.65 }));
    handle.name = 'Drawer handle';
    handle.position.set(0.208, 0.643, 0);
    drawer.add(handle);
    return drawer;
  }

  private createClassroomLectern(): Group {
    const lectern = new Group();
    lectern.name = 'Classroom lectern';
    const panels = new Group();
    panels.name = 'Lectern wood panels';
    const wood = new MeshStandardMaterial({ color: '#c39560', roughness: 0.7 });
    const edge = new MeshStandardMaterial({ color: '#a77b4e', roughness: 0.75 });
    const front = new Mesh(new RoundedBoxGeometry(0.46, 0.9, 0.035, 2, 0.008), wood);
    front.position.set(0, 0.51, 0.18);
    panels.add(front);
    for (const side of [-1, 1]) {
      const panel = new Mesh(new RoundedBoxGeometry(0.035, 0.9, 0.36, 2, 0.008), wood);
      panel.position.set(side * 0.21, 0.51, 0);
      panels.add(panel);
    }
    const top = new Mesh(new RoundedBoxGeometry(0.62, 0.055, 0.5, 2, 0.015), wood);
    top.position.y = 0.98;
    panels.add(top);
    const surface = new Mesh(new RoundedBoxGeometry(0.58, 0.035, 0.42, 2, 0.01), wood);
    surface.position.set(0, 1.08, -0.035);
    surface.rotation.x = -0.22;
    panels.add(surface);
    const base = new Mesh(new RoundedBoxGeometry(0.58, 0.09, 0.46, 2, 0.015), edge);
    base.position.y = 0.045;
    const stop = new Mesh(new RoundedBoxGeometry(0.58, 0.05, 0.025, 2, 0.008), edge);
    stop.position.set(0, 1.12, -0.22);
    stop.rotation.x = -0.22;
    lectern.add(panels, base, stop);
    lectern.traverse((node) => {
      if (node instanceof Mesh) {
        node.castShadow = true;
        node.receiveShadow = true;
      }
    });
    return lectern;
  }

  private createSchoolBackpack(color: string): Group {
    const bag = new Group();
    bag.name = 'School backpack';
    const fabric = new MeshStandardMaterial({ color, roughness: 0.96 });
    const trim = new MeshStandardMaterial({ color: '#343d42', roughness: 0.95 });
    const body = new Mesh(new RoundedBoxGeometry(0.135, 0.28, 0.23, 2, 0.045), fabric);
    bag.add(body);
    const pocket = new Mesh(new RoundedBoxGeometry(0.045, 0.14, 0.19, 2, 0.018), fabric);
    pocket.position.set(0.077, -0.045, 0);
    bag.add(pocket);
    const zipper = new Mesh(new BoxGeometry(0.006, 0.006, 0.15), trim);
    zipper.position.set(0.101, 0.016, 0);
    bag.add(zipper);
    const handle = new Mesh(new TorusGeometry(0.034, 0.005, 6, 12, Math.PI), trim);
    handle.rotation.y = Math.PI / 2;
    handle.position.y = 0.138;
    bag.add(handle);
    for (const side of [-1, 1]) {
      const strap = new Mesh(new TubeGeometry(new CatmullRomCurve3([
        new Vector3(-0.045, -0.09, side * 0.073),
        new Vector3(-0.105, 0.04, side * 0.073),
        new Vector3(-0.09, 0.15, side * 0.073),
        new Vector3(-0.04, 0.1, side * 0.073),
      ]), 12, 0.009, 5, false), trim);
      strap.name = 'Backpack shoulder strap';
      bag.add(strap);
    }
    bag.traverse((node) => {
      if (node instanceof Mesh) {
        node.castShadow = true;
        node.receiveShadow = true;
      }
    });
    return bag;
  }

  private createClassroomTeachingTools(): Group {
    const tools = new Group();
    tools.name = 'Classroom mathematical tools';
    const wood = new MeshStandardMaterial({ color: '#d6b77d', roughness: 0.85 });
    const markings = new MeshStandardMaterial({ color: '#594e3b', roughness: 0.9 });
    const outline = new Shape();
    outline.moveTo(-0.25, -0.23);
    outline.lineTo(0.21, -0.23);
    outline.lineTo(-0.25, 0.23);
    outline.closePath();
    const hole = new Path();
    hole.moveTo(-0.19, -0.17);
    hole.lineTo(-0.19, 0.085);
    hole.lineTo(0.065, -0.17);
    hole.closePath();
    outline.holes.push(hole);
    const triangle = new Mesh(new ExtrudeGeometry(outline, { depth: 0.018, bevelEnabled: false }), wood);
    triangle.name = 'Teaching set square';
    tools.add(triangle);
    const ruler = new Mesh(new RoundedBoxGeometry(0.055, 0.68, 0.018, 2, 0.005), wood);
    ruler.name = 'Teaching ruler';
    ruler.position.set(0.33, 0.02, 0.012);
    tools.add(ruler);
    for (let mark = 0; mark <= 20; mark += 1) {
      const tick = new Mesh(new BoxGeometry(mark % 5 === 0 ? 0.027 : 0.015, 0.003, 0.002), markings);
      tick.position.set(0.318, -0.28 + mark * 0.03, 0.023);
      tools.add(tick);
    }
    const compass = new Group();
    compass.name = 'Teaching compass';
    compass.position.set(0.03, 0.43, 0.018);
    for (const side of [-1, 1]) {
      const arm = new Group();
      arm.rotation.z = side * 0.27;
      const leg = new Mesh(new BoxGeometry(0.023, 0.28, 0.016), wood);
      leg.position.y = -0.14;
      const tip = new Mesh(new CylinderGeometry(0.008, 0, 0.055, 8), markings);
      tip.position.y = -0.3075;
      arm.add(leg, tip);
      compass.add(arm);
    }
    const hinge = new Mesh(new CylinderGeometry(0.025, 0.025, 0.024, 12), markings);
    hinge.rotation.x = Math.PI / 2;
    compass.add(hinge);
    tools.add(compass);
    tools.traverse((node) => {
      if (node instanceof Mesh) {
        node.castShadow = true;
        node.receiveShadow = true;
      }
    });
    return tools;
  }

  private rebuildPresetInterior(preset: 'classroom' | 'home' | 'custom', room: { width: number; depth: number; height: number }): void {
    if (!this.scene) {
      return;
    }

    this.disposePresetInterior();

    if (this.defaultLighting) {
      this.defaultLighting.visible = preset !== 'classroom';
    }
    if (this.renderer) {
      this.renderer.toneMapping = preset === 'classroom' ? ACESFilmicToneMapping : NoToneMapping;
    }
    if (preset === 'custom') {
      return;
    }

    const group = new Group();
    if (preset === 'classroom') {
      group.add(this.createClassroomLighting());
    }
    const wallColor = preset === 'classroom' ? '#f7f5ed' : '#5a5148';
    const accentColor = preset === 'classroom' ? '#7fb3df' : '#c89266';

    const wallMat = new MeshStandardMaterial({ color: wallColor, roughness: 0.86, metalness: 0.01, transparent: true, opacity: preset === 'classroom' ? 0.78 : 0.35 });
    const wallThickness = 0.08;
    const classroomWindowCenters = [-0.8, 0.9, 2.6];
    const buildClassroomSideWall = (wallZ: number, withDoor: boolean) => {
      const openings = classroomWindowCenters.map((center) => ({ left: center - 0.6, right: center + 0.6, bottom: 1.1, top: 2.14 }));
      if (withDoor) {
        const center = -room.width * 0.26;
        openings.push({ left: center - 0.43, right: center + 0.43, bottom: 0, top: 2.16 });
      }
      const xEdges = [...new Set([-room.width / 2, room.width / 2, ...openings.flatMap((opening) => [opening.left, opening.right])])].sort((left, right) => left - right);
      const yEdges = [0, 1.1, 2.14, 2.16, room.height];
      for (let column = 0; column < xEdges.length - 1; column += 1) {
        for (let row = 0; row < yEdges.length - 1; row += 1) {
          const centerX = (xEdges[column] + xEdges[column + 1]) / 2;
          const centerY = (yEdges[row] + yEdges[row + 1]) / 2;
          if (openings.some((opening) => centerX > opening.left && centerX < opening.right && centerY > opening.bottom && centerY < opening.top)) {
            continue;
          }
          const wall = new Mesh(new BoxGeometry(xEdges[column + 1] - xEdges[column], yEdges[row + 1] - yEdges[row], wallThickness), wallMat);
          wall.name = 'Classroom side wall with window openings';
          wall.position.set(centerX, centerY, wallZ);
          group.add(wall);
        }
      }
    };

    if (preset === 'classroom') {
      const wallNormalUrl = new URL('./models/classroom/appearances/protos/textures/roughcast/roughcast_normal.jpg', window.location.href).href;
      void new TextureLoader().loadAsync(wallNormalUrl).then((normalMap) => {
        if (this.presetInteriorRoot !== group) {
          normalMap.dispose();
          return;
        }
        normalMap.wrapS = RepeatWrapping;
        normalMap.wrapT = RepeatWrapping;
        normalMap.repeat.set(room.width / 2, room.height / 2);
        wallMat.normalMap = normalMap;
        wallMat.normalScale.set(0.18, 0.18);
        wallMat.needsUpdate = true;
      }).catch((error) => console.error('Failed to load Webots classroom wall material:', error));
    }

    const backWall = new Mesh(new BoxGeometry(room.width, room.height, wallThickness), wallMat);
    backWall.position.set(0, room.height / 2, -room.depth / 2);
    if (preset === 'classroom') {
      backWall.geometry.dispose();
      buildClassroomSideWall(-room.depth / 2, false);
    } else {
      group.add(backWall);
    }

    const leftWall = new Mesh(new BoxGeometry(wallThickness, room.height, room.depth), wallMat);
    leftWall.position.set(-room.width / 2, room.height / 2, 0);
    group.add(leftWall);

    const rightWall = new Mesh(new BoxGeometry(wallThickness, room.height, room.depth), wallMat);
    rightWall.position.set(room.width / 2, room.height / 2, 0);
    group.add(rightWall);

    const frontWallTop = new Mesh(new BoxGeometry(room.width, room.height * 0.4, wallThickness), wallMat);
    frontWallTop.position.set(0, room.height * 0.8, room.depth / 2);
    if (preset !== 'classroom') {
      group.add(frontWallTop);
    }

    const frontWallLeft = new Mesh(new BoxGeometry(room.width * 0.38, room.height * 0.6, wallThickness), wallMat);
    frontWallLeft.position.set(-room.width * 0.31, room.height * 0.3, room.depth / 2);
    if (preset !== 'classroom') {
      group.add(frontWallLeft);
    }

    const frontWallRight = new Mesh(new BoxGeometry(room.width * 0.38, room.height * 0.6, wallThickness), wallMat);
    frontWallRight.position.set(room.width * 0.31, room.height * 0.3, room.depth / 2);
    if (preset !== 'classroom') {
      group.add(frontWallRight);
    } else {
      [frontWallTop, frontWallLeft, frontWallRight].forEach((wall) => wall.geometry.dispose());
      buildClassroomSideWall(room.depth / 2, true);
    }

    if (preset === 'classroom') {
      group.add(this.createClassroomGround(room));
      group.add(this.createClassroomTrees(room));
      group.add(this.createBasketballCourt(room));
      group.add(this.createBleachers(room));
      group.add(this.createParkingLot(room));
      const teachingTools = this.createClassroomTeachingTools();
      teachingTools.position.set(-room.width / 2 + 0.065, 1.6, room.depth / 2 - 0.65);
      teachingTools.rotation.y = Math.PI / 2;
      group.add(teachingTools);
      const trimMat = new MeshStandardMaterial({ color: '#83b8e5', roughness: 0.58, metalness: 0.04 });
      this.createClassroomWoodFloor(group, room);

      const wallTrim = new MeshStandardMaterial({ color: '#b9d9df', roughness: 0.58, metalness: 0.02 });
      const baseboardHeight = 0.12;
      const baseboardThickness = 0.035;
      [
        { size: new Vector3(room.width, baseboardHeight, baseboardThickness), position: new Vector3(0, baseboardHeight / 2, -room.depth / 2 + wallThickness / 2) },
        { size: new Vector3(baseboardThickness, baseboardHeight, room.depth), position: new Vector3(-room.width / 2 + wallThickness / 2, baseboardHeight / 2, 0) },
        { size: new Vector3(baseboardThickness, baseboardHeight, room.depth), position: new Vector3(room.width / 2 - wallThickness / 2, baseboardHeight / 2, 0) },
      ].forEach(({ size, position }) => {
        const molding = new Mesh(new BoxGeometry(size.x, size.y, size.z), wallTrim);
        molding.position.copy(position);
        group.add(molding);
      });

      const teachingStage = new Mesh(
        new BoxGeometry(1.35, 0.09, room.depth * 0.86),
        new MeshStandardMaterial({ color: '#e6d2b8', roughness: 0.86, metalness: 0.01 }),
      );
      teachingStage.position.set(-room.width / 2 + 0.95, 0.045, 0);
      group.add(teachingStage);
      this.applyVarnishedPineFinish(teachingStage);

      const blackboardFallback = new Group();
      const blackboardFrame = new Mesh(
        new BoxGeometry(0.06, 1.28, Math.max(2.7, room.depth * 0.58)),
        new MeshStandardMaterial({ color: '#b88e63', roughness: 0.72, metalness: 0.03 }),
      );
      blackboardFrame.position.set(-room.width / 2 + 0.07, Math.min(room.height - 0.85, 1.78), 0);
      blackboardFrame.rotation.y = 0;
      blackboardFallback.add(blackboardFrame);

      const board = new Mesh(
        new BoxGeometry(0.03, 1.12, Math.max(2.55, room.depth * 0.54)),
        new MeshStandardMaterial({ color: '#39584f', roughness: 0.7, metalness: 0.02 }),
      );
      board.position.set(-room.width / 2 + 0.095, Math.min(room.height - 0.85, 1.78), 0);
      board.rotation.y = 0;
      blackboardFallback.add(board);

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
        blackboardFallback.add(line);
      });

      const chalkTray = new Mesh(
        new BoxGeometry(0.1, 0.04, Math.max(2.45, room.depth * 0.5)),
        new MeshStandardMaterial({ color: '#d9c7ad', roughness: 0.8, metalness: 0.01 }),
      );
      chalkTray.position.set(-room.width / 2 + 0.18, Math.min(room.height - 1.45, 1.18), 0);
      chalkTray.rotation.y = 0;
      blackboardFallback.add(chalkTray);
      group.add(blackboardFallback);
      void this.loadClassroomProtoAsset('school_furniture/protos/Blackboard.proto').then((asset) => {
        if (this.presetInteriorRoot !== group) {
          return;
        }
        const importedBlackboard = asset.clone(true);
        importedBlackboard.position.set(-room.width / 2 + 0.1, 1.72, 0);
        group.remove(blackboardFallback);
        group.add(importedBlackboard);
      }).catch((error) => console.error('Failed to load Webots classroom blackboard:', error));

      const chalkCanvas = document.createElement('canvas');
      chalkCanvas.width = 1400;
      chalkCanvas.height = 640;
      const chalkContext = chalkCanvas.getContext('2d');
      if (chalkContext) {
        chalkContext.fillStyle = '#f1eee1';
        chalkContext.font = '52px "Microsoft YaHei", sans-serif';
        chalkContext.fillText('科学课堂  |  Science Class', 75, 95);
        chalkContext.strokeStyle = '#c4cfb3';
        chalkContext.lineWidth = 3;
        chalkContext.beginPath();
        chalkContext.moveTo(75, 125);
        chalkContext.lineTo(1325, 125);
        chalkContext.stroke();
        chalkContext.font = '38px "Microsoft YaHei", sans-serif';
        chalkContext.fillText('观察 · 思考 · 探索', 75, 230);
        chalkContext.fillText('Observe, Think, Explore', 75, 300);
        chalkContext.fillStyle = '#e4d587';
        chalkContext.fillText('X  前后     Y  左右     Z  上下', 75, 430);
        chalkContext.fillStyle = '#c6dfdc';
        chalkContext.fillText('Today: Flight & Motion', 75, 530);
        const chalkTexture = new CanvasTexture(chalkCanvas);
        chalkTexture.colorSpace = SRGBColorSpace;
        const chalkWriting = new Mesh(new PlaneGeometry(2.38, 1.1), new MeshBasicMaterial({ map: chalkTexture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
        chalkWriting.name = 'Bilingual classroom chalk lesson';
        chalkWriting.rotation.y = Math.PI / 2;
        chalkWriting.position.set(-room.width / 2 + 0.15, 1.72, 0);
        group.add(chalkWriting);
      }

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

      const teacherDesk = new Group();
      teacherDesk.name = 'Classroom teacher desk';
      teacherDesk.position.set(-room.width / 2 + 1.55, 0, -0.55);
      teacherDesk.rotation.y = Math.PI / 2;
      const teacherDeskFallback = new Mesh(
        new BoxGeometry(1.4, 0.74, 0.62),
        new MeshStandardMaterial({ color: CLASSROOM_WOOD_FINISHES.desk.tint, roughness: 0.78, metalness: 0.01 }),
      );
      teacherDeskFallback.position.y = 0.37;
      teacherDesk.add(teacherDeskFallback);
      group.add(teacherDesk);
      void this.loadClassroomDeskAsset().then(({ geometry, material }) => {
        if (this.presetInteriorRoot !== group) {
          return;
        }
        teacherDesk.remove(teacherDeskFallback);
        const deskMesh = new Mesh(geometry.clone(), material.clone());
        deskMesh.scale.set(2, 1, 0.62 / 1.2);
        deskMesh.userData.sharedClassroomTextures = true;
        deskMesh.castShadow = true;
        deskMesh.receiveShadow = true;
        teacherDesk.add(deskMesh);
      }).catch((error) => console.error('Failed to load Webots teacher desk:', error));

      const bulletinFrame = new Mesh(new BoxGeometry(0.065, 1.5, 3.65), new MeshStandardMaterial({ color: '#b48b5e', roughness: 0.65 }));
      bulletinFrame.position.set(room.width / 2 - 0.085, 1.72, 0);
      group.add(bulletinFrame);
      {
        const bulletinTexture = this.createAircraftBulletinTexture(group);
        const bulletin = new Mesh(new PlaneGeometry(3.5, 1.4), new MeshBasicMaterial({ map: bulletinTexture }));
        bulletin.name = 'Aircraft exploration classroom bulletin board';
        bulletin.rotation.y = -Math.PI / 2;
        bulletin.position.set(room.width / 2 - 0.125, 1.72, 0);
        group.add(bulletin);
      }

      const windowFrameMaterial = new MeshStandardMaterial({ color: '#e7f2f5', roughness: 0.52, metalness: 0.02 });
      const windowGlassMaterial = new MeshPhysicalMaterial({ color: '#b9e3f4', roughness: 0.12, metalness: 0, transparent: true, opacity: 0.34, transmission: 0.3, thickness: 0.02, side: 2 });
      for (const side of [-1, 1]) {
        for (const centerX of classroomWindowCenters) {
          const windowGroup = new Group();
          windowGroup.name = 'Classroom side window';
          windowGroup.position.set(centerX, 1.62, side * room.depth / 2);
          const glass = new Mesh(new PlaneGeometry(1.08, 0.92), windowGlassMaterial);
          windowGroup.add(glass);
          for (const offsetX of [-0.57, 0, 0.57]) {
            const upright = new Mesh(new BoxGeometry(0.06, 1.04, 0.1), windowFrameMaterial);
            upright.position.x = offsetX;
            windowGroup.add(upright);
          }
          for (const offsetY of [-0.49, 0, 0.49]) {
            const rail = new Mesh(new BoxGeometry(1.2, 0.06, 0.1), windowFrameMaterial);
            rail.position.y = offsetY;
            windowGroup.add(rail);
          }
          const sill = new Mesh(new BoxGeometry(1.3, 0.05, 0.22), windowFrameMaterial);
          sill.position.set(0, -0.54, -side * 0.04);
          windowGroup.add(sill);
          group.add(windowGroup);
        }
      }

      const podiumGroup = this.createClassroomLectern();
      podiumGroup.position.set(-room.width / 2 + 1.36, 0, 1.02);
      podiumGroup.rotation.y = Math.PI / 2;
      group.add(podiumGroup);
      const lecternPanels = podiumGroup.getObjectByName('Lectern wood panels');
      if (lecternPanels) {
        this.applyVarnishedPineFinish(lecternPanels);
      }

      const wallClock = new Mesh(
        new CylinderGeometry(0.12, 0.12, 0.02, 24),
        new MeshStandardMaterial({ color: '#f5f4ef', roughness: 0.35, metalness: 0.02 }),
      );
      wallClock.rotation.z = Math.PI / 2;
      wallClock.position.set(-room.width * 0.43, 2.0, -room.depth * 0.28);
      group.add(wallClock);

      const doorGroup = new Group();
      const doorMaterial = new MeshStandardMaterial({ color: '#a5744e', roughness: 0.58, metalness: 0.01 });
      const doorFrame = new Mesh(new BoxGeometry(0.08, 2.16, 0.12), trimMat);
      doorFrame.position.set(-room.width * 0.26, 1.08, room.depth / 2 - 0.055);
      doorFrame.position.x -= 0.405;
      doorGroup.add(doorFrame);
      const oppositeDoorFrame = doorFrame.clone();
      oppositeDoorFrame.position.x += 0.81;
      doorGroup.add(oppositeDoorFrame);
      const doorHeader = new Mesh(new BoxGeometry(0.89, 0.08, 0.12), trimMat);
      doorHeader.position.set(-room.width * 0.26, 2.12, room.depth / 2 - 0.055);
      doorGroup.add(doorHeader);
      const doorLeaf = new Mesh(new BoxGeometry(0.73, 2.02, 0.045), doorMaterial);
      doorLeaf.position.set(-room.width * 0.26, 1.02, room.depth / 2 - 0.04);
      doorGroup.add(doorLeaf);
      for (const panel of [
        { y: 0.56, height: 0.72, width: 0.53 },
        { y: 1.48, height: 0.72, width: 0.53 },
      ]) {
        const inset = new Mesh(new BoxGeometry(panel.width, panel.height, 0.014), doorMaterial);
        inset.position.set(-room.width * 0.26, panel.y, room.depth / 2 - 0.072);
        doorGroup.add(inset);
      }
      const doorHandleMaterial = new MeshStandardMaterial({ color: '#a6a9a8', roughness: 0.3, metalness: 0.8 });
      const handlePlate = new Mesh(new BoxGeometry(0.07, 0.12, 0.012), doorHandleMaterial);
      handlePlate.position.set(-room.width * 0.26 + 0.27, 1.02, room.depth / 2 - 0.08);
      doorGroup.add(handlePlate);
      const handle = new Mesh(new SphereGeometry(0.025, 12, 10), doorHandleMaterial);
      handle.position.set(-room.width * 0.26 + 0.27, 1.02, room.depth / 2 - 0.105);
      doorGroup.add(handle);
      group.add(doorGroup);
      this.applyVarnishedPineFinish(doorGroup);

      const aisle = new Mesh(
        new BoxGeometry(room.width * 0.62, 0.01, 0.74),
        new MeshStandardMaterial({ color: '#d5d9e0', roughness: 0.8, metalness: 0.01 }),
      );
      aisle.position.set(0.35, 0.006, 0);
      group.add(aisle);

      const { rows, cols, deskW, deskD, rowSpacing, colCenters, firstRowX, chairOffsetX, helipadPose } =
        getClassroomDeskLayout();
      const helipadX = helipadPose.x;
      const helipadZ = helipadPose.z;
      const backpackSeats = [
        { row: 0, col: 0, color: '#526c89' },
        { row: 0, col: 4, color: '#9e6652' },
        { row: 1, col: 1, color: '#6b7860' },
        { row: 2, col: 3, color: '#b29258' },
        { row: 3, col: 0, color: '#796b86' },
        { row: 3, col: 4, color: '#527b79' },
      ];
      for (const { row, col, color } of backpackSeats) {
        const backpack = this.createSchoolBackpack(color);
        backpack.position.set(firstRowX + row * rowSpacing + chairOffsetX + 0.245, 0.56, colCenters[col]);
        group.add(backpack);
      }
      const instanceTransform = new Object3D();
      const placeInstance = (instances: InstancedMesh, index: number, x: number, y: number, z: number, scaleX = 1, scaleY = 1, scaleZ = 1) => {
        instanceTransform.position.set(x, y, z);
        instanceTransform.rotation.set(0, 0, 0);
        instanceTransform.scale.set(scaleX, scaleY, scaleZ);
        instanceTransform.updateMatrix();
        instances.setMatrixAt(index, instanceTransform.matrix);
      };

      for (const [template, offsetX, finish] of [
        [this.createClassroomChair(), chairOffsetX, 'chair'],
        [this.createClassroomDeskDrawer(), 0, 'desk'],
      ] as const) {
        for (const part of template.children) {
          if (!(part instanceof Mesh)) {
            continue;
          }
          part.updateMatrix();
          const instances = new InstancedMesh(part.geometry, part.material, rows * cols);
          instances.name = part.name;
          let index = 0;
          for (let r = 0; r < rows; r += 1) {
            for (let c = 0; c < cols; c += 1) {
              instanceTransform.position.set(firstRowX + r * rowSpacing + offsetX, 0, colCenters[c]);
              instanceTransform.rotation.set(0, 0, 0);
              instanceTransform.scale.set(1, 1, 1);
              instanceTransform.updateMatrix();
              instances.setMatrixAt(index++, instanceTransform.matrix.clone().multiply(part.matrix));
            }
          }
          instances.instanceMatrix.needsUpdate = true;
          instances.castShadow = true;
          instances.receiveShadow = true;
          group.add(instances);
          if (part.name.includes('wood')) {
            this.applyVarnishedPineFinish(instances, finish);
          }
        }
      }

      void this.loadClassroomDeskAsset().then(({ geometry, material }) => {
        if (this.presetInteriorRoot !== group) {
          return;
        }
        const desks = new InstancedMesh(geometry.clone(), material.clone(), rows * cols);
        desks.name = 'Webots school desk instances';
        desks.userData.sharedClassroomTextures = true;
        let deskIndex = 0;
        for (let r = 0; r < rows; r += 1) {
          const x = firstRowX + r * rowSpacing;
          for (let c = 0; c < cols; c += 1) {
            placeInstance(desks, deskIndex++, x, 0, colCenters[c], deskD / 0.7, 1, deskW / 1.2);
          }
        }
        desks.instanceMatrix.needsUpdate = true;
        desks.castShadow = true;
        desks.receiveShadow = true;
        group.add(desks);
      }).catch((error) => console.error('Failed to load Webots classroom desk asset:', error));

      const deskSurfaceY = 0.71001;
      const helipadBase = new Mesh(
        new BoxGeometry(0.3, 0.024, 0.3),
        new MeshStandardMaterial({ color: '#7896a6', roughness: 0.82, metalness: 0.08 }),
      );
      helipadBase.name = 'Classroom desk helipad';
      helipadBase.position.set(helipadX, deskSurfaceY + 0.012, helipadZ);
      group.add(helipadBase);

      const helipadDeckPlate = new Mesh(
        new BoxGeometry(0.284, 0.008, 0.284),
        new MeshStandardMaterial({ color: '#edf4f7', roughness: 0.72, metalness: 0.02 }),
      );
      helipadDeckPlate.position.set(helipadX, deskSurfaceY + 0.028, helipadZ);
      group.add(helipadDeckPlate);

      const helipadTop = new Mesh(
        new CylinderGeometry(0.126, 0.126, 0.006, 48),
        new MeshStandardMaterial({ color: '#b9dfed', roughness: 0.78, metalness: 0.08 }),
      );
      helipadTop.position.set(helipadX, deskSurfaceY + 0.035, helipadZ);
      group.add(helipadTop);

      const safetyDashMaterial = new MeshStandardMaterial({ color: '#287598', roughness: 0.64, metalness: 0.04 });
      const safetyDashCount = 16;
      for (let dashIndex = 0; dashIndex < safetyDashCount; dashIndex += 1) {
        const angle = (dashIndex / safetyDashCount) * Math.PI * 2;
        const radius = 0.108;
        const dash = new Mesh(new BoxGeometry(0.03, 0.004, 0.009), safetyDashMaterial);
        dash.position.set(helipadX + Math.sin(angle) * radius, deskSurfaceY + 0.040, helipadZ + Math.cos(angle) * radius);
        dash.rotation.y = angle;
        group.add(dash);
      }

      const hMarkMaterial = new MeshStandardMaterial({ color: '#287598', roughness: 0.74, metalness: 0.01 });
      const hBarLeft = new Mesh(new BoxGeometry(0.014, 0.004, 0.095), hMarkMaterial);
      hBarLeft.position.set(helipadX - 0.034, deskSurfaceY + 0.040, helipadZ);
      group.add(hBarLeft);
      const hBarRight = new Mesh(new BoxGeometry(0.014, 0.004, 0.095), hMarkMaterial);
      hBarRight.position.set(helipadX + 0.034, deskSurfaceY + 0.040, helipadZ);
      group.add(hBarRight);
      const hBarCross = new Mesh(new BoxGeometry(0.082, 0.004, 0.014), hMarkMaterial);
      hBarCross.position.set(helipadX, deskSurfaceY + 0.040, helipadZ);
      group.add(hBarCross);

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
      if (node instanceof DirectionalLight) {
        node.shadow.dispose();
      }
      if (node.userData?.sharedClassroomAsset) {
        return;
      }
      if (node.geometry?.dispose) {
        node.geometry.dispose();
      }
      if (node.material?.dispose) {
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        materials.forEach((material: any) => {
          if (!material) {
            return;
          }
          if (!node.userData?.sharedClassroomTextures) {
            Object.values(material).forEach((value: any) => {
              if (value?.isTexture) {
                value.dispose();
              }
            });
          }
          material.dispose();
        });
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
      const width = Math.max(1, host.clientWidth || 420);
      const height = Math.max(220, host.clientHeight || 300);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height);
      this.updateAttitudeViewport();
      if (this.controls) {
        this.controls.update();
      }
    });
    this.resizeObserver.observe(host);
    this.resizeObserver.observe(this.attitudeViewportRef.nativeElement);
  }

  private updateAttitudeViewport(): void {
    if (!this.renderer) return;
    const canvas = this.renderer.domElement.getBoundingClientRect();
    const inset = this.attitudeViewportRef.nativeElement.getBoundingClientRect();
    if (!canvas.width || !canvas.height) return;
    const size = this.renderer.getSize(new Vector2());
    const scaleX = size.x / canvas.width, scaleY = size.y / canvas.height;
    this.attitudeViewport = { x: (inset.left - canvas.left) * scaleX, y: (canvas.bottom - inset.bottom) * scaleY,
      width: inset.width * scaleX, height: inset.height * scaleY };
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
      const sample = this.displayedAttitude;
      if (sample) {
        this.aircraftYaw = MathUtils.degToRad(sample.yaw);
        this.droneGroup.quaternion.slerp(
          attitudeQuaternion(sample.roll, sample.pitch, sample.yaw, this.defaultDroneYawOffset),
          1 - Math.exp(-Math.max(0, deltaSec) / 0.035),
        );
      } else if (!this.attitudeActive && !this.realPoseShown) {
        this.aircraftYaw = this.simService.pose$.value.yaw;
        this.droneGroup.quaternion.slerp(
          attitudeQuaternion(0, 0, MathUtils.radToDeg(this.aircraftYaw), this.defaultDroneYawOffset),
          1 - Math.exp(-Math.max(0, deltaSec) / 0.035),
        );
      }
      if (now - this.lastAttitudeMetricsTs >= 200) {
        this.lastAttitudeMetricsTs = now;
        this.zone.run(() => {
          this.attitudeMetrics = this.connectionService.attitudeReception.metrics(now);
        });
      }
      this.updatePropellerAnimation(deltaSec);
      if (this.running && !this.paused) {
        this.updateFlightPath(this.droneGroup.position);
      }
      this.controls?.update();

      if (this.flightAxes) {
        this.flightAxes.position.copy(this.droneGroup.position);
        this.flightAxes.quaternion.copy(this.droneGroup.quaternion)
          .multiply(attitudeQuaternion(0, 0, 0, -this.defaultDroneYawOffset));
      }
      this.renderer.render(this.scene, this.camera);
      this.attitudePreview?.update(this.liveAttitude, deltaSec);
      this.attitudePreview?.render(this.renderer, this.attitudeViewport);
      this.animationFrameId = requestAnimationFrame(animate);
    };

    this.animationFrameId = requestAnimationFrame(animate);
  }
}

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const viewerStartedAt = performance.now();
const $ = (selector) => document.querySelector(selector);
const canvas = $('#three-canvas');
const loadingOverlay = $('#loading-overlay');
const loadingBar = $('#loading-bar');
const loadingText = $('#loading-text');
const statusDot = $('#status-dot');
const runtimeStatus = $('#runtime-status');
const runtimeMetrics = $('#runtime-metrics');
const panel = $('#control-panel');
const handButton = $('#hand-button');
const video = $('#webcam');
const handCanvas = $('#hand-canvas');
const handContext = handCanvas.getContext('2d');
const cameraCard = $('#camera-card');
const cameraLabelText = $('#camera-label-text');
const gestureGuide = $('#gesture-guide');
const toast = $('#toast');

const STORAGE_KEY = 'huangjing-viewer-v14';
const DEFAULTS = Object.freeze({
  quality: 'auto',
  exposure: 1.1,
  ambient: 0.28,
  bloom: 0.34,
  modelHaze: 0.24,
  surfaceDetail: 0.76,
  rimIntensity: 1.15,
  movementSpeed: 1,
  rotationSensitivity: 1,
  zoomSensitivity: 1,
  inferenceFps: 24,
  handLight: 78,
  handRange: 72,
  beamFocus: 0.66,
  touchBoost: 1.55,
  autoRotateSpeed: 0.6,
});

const PROFILES = Object.freeze({
  low: { dpr: 0.9, bloom: false, label: 'FLOW' },
  balanced: { dpr: 1, bloom: true, label: 'BAL' },
  high: { dpr: 1.35, bloom: true, label: 'HIGH' },
});

function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') }; }
  catch { return { ...DEFAULTS }; }
}

const state = loadSettings();
let resolvedQuality = resolveQuality(state.quality);
let profile = PROFILES[resolvedQuality];
let renderer;
let composer = null;
let bloomPass = null;
let modelRoot = null;
let modelMeshes = [];
let materialRecords = [];
let handData = null;
let handDetected = false;
let modelReady = false;
let toastTimer = 0;
let postTimer = 0;

function resolveQuality(requested) {
  if (requested !== 'auto') return requested;
  const memory = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;
  const mobile = matchMedia('(pointer: coarse)').matches;
  if (memory <= 3 || cores <= 4 || (mobile && memory <= 4)) return 'low';
  if (memory >= 12 && cores >= 12 && !mobile) return 'high';
  return 'balanced';
}

function setStatus(text, mode = '') {
  runtimeStatus.textContent = text;
  statusDot.className = `status-dot ${mode}`;
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('show');
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

function setLoading(percent, text) {
  loadingBar.style.width = `${Math.max(8, Math.min(100, percent))}%`;
  loadingText.textContent = text;
}

try {
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: resolvedQuality !== 'low',
    alpha: false,
    powerPreference: 'high-performance',
  });
} catch (error) {
  setLoading(100, '当前浏览器无法启动 WebGL · WebGL unavailable');
  setStatus('WebGL 不可用 · Unavailable', 'error');
  throw error;
}

renderer.setClearColor(0x020706, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = state.exposure;
renderer.setSize(innerWidth, innerHeight, false);
renderer.setPixelRatio(Math.min(devicePixelRatio, profile.dpr));

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x020706, 0.012);
const pmremGenerator = new THREE.PMREMGenerator(renderer);
scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.035).texture;
pmremGenerator.dispose();
const pivot = new THREE.Group();
pivot.position.x = innerWidth > 980 ? 1.15 : 0;
scene.add(pivot);

const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.1, 180);
camera.position.set(0, 0.5, 28);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.065;
controls.enablePan = false;
controls.minDistance = 13;
controls.maxDistance = 48;
controls.autoRotate = true;
controls.autoRotateSpeed = state.autoRotateSpeed;
controls.target.set(0, 0, 0);
controls.saveState();

const ambientLight = new THREE.HemisphereLight(0x9fcbb3, 0x070504, state.ambient);
scene.add(ambientLight);
const keyLight = new THREE.DirectionalLight(0xffefd1, 2.2);
keyLight.position.set(9, 13, 11);
scene.add(keyLight);
const jadeRim = new THREE.DirectionalLight(0x68dca8, state.rimIntensity);
jadeRim.position.set(-10, 5, -12);
scene.add(jadeRim);
const goldRim = new THREE.PointLight(0xd8ad61, 7, 30, 1.8);
goldRim.position.set(7, -4, 5);
scene.add(goldRim);

const handLight = new THREE.SpotLight(0xffd39a, state.handLight, state.handRange, THREE.MathUtils.lerp(Math.PI * .34, Math.PI * .09, state.beamFocus), .72, 1.5);
handLight.visible = false;
scene.add(handLight);
scene.add(handLight.target);
const touchLight = new THREE.PointLight(0xffc87a, 0, 9, 1.8);
touchLight.visible = false;
scene.add(touchLight);
const handHalo = new THREE.Mesh(
  new THREE.RingGeometry(0.2, 0.29, 32),
  new THREE.MeshBasicMaterial({ color: 0xffd49a, transparent: true, opacity: 0.72, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
);
handHalo.visible = false;
scene.add(handHalo);

const exploreCanvas = document.createElement('canvas');
exploreCanvas.width = exploreCanvas.height = 128;
const exploreContext = exploreCanvas.getContext('2d');
const exploreGradient = exploreContext.createRadialGradient(64, 64, 0, 64, 64, 64);
exploreGradient.addColorStop(0, 'rgba(255,241,203,.9)');
exploreGradient.addColorStop(.2, 'rgba(255,207,130,.38)');
exploreGradient.addColorStop(1, 'rgba(255,190,96,0)');
exploreContext.fillStyle = exploreGradient;
exploreContext.fillRect(0, 0, 128, 128);
const exploreGlow = new THREE.Sprite(new THREE.SpriteMaterial({
  map: new THREE.CanvasTexture(exploreCanvas),
  color: 0xffd79d,
  transparent: true,
  opacity: 0,
  depthWrite: false,
  depthTest: true,
  blending: THREE.AdditiveBlending,
}));
exploreGlow.scale.set(2.4, 2.4, 1);
exploreGlow.visible = false;
scene.add(exploreGlow);

const mistCanvas = document.createElement('canvas');
mistCanvas.width = mistCanvas.height = 128;
const mistContext = mistCanvas.getContext('2d');
const mistGradient = mistContext.createRadialGradient(64, 64, 5, 64, 64, 64);
mistGradient.addColorStop(0, 'rgba(126,222,177,.22)');
mistGradient.addColorStop(.52, 'rgba(81,160,124,.08)');
mistGradient.addColorStop(1, 'rgba(38,94,70,0)');
mistContext.fillStyle = mistGradient;
mistContext.fillRect(0, 0, 128, 128);
const mistAura = new THREE.Sprite(new THREE.SpriteMaterial({
  map: new THREE.CanvasTexture(mistCanvas),
  transparent: true,
  opacity: .04 + state.modelHaze * .18,
  depthWrite: false,
  depthTest: false,
  blending: THREE.AdditiveBlending,
}));
mistAura.position.set(0, .2, -3);
mistAura.scale.set(17, 17, 1);
pivot.add(mistAura);

const shadowCanvas = document.createElement('canvas');
shadowCanvas.width = shadowCanvas.height = 128;
const shadowContext = shadowCanvas.getContext('2d');
const shadowGradient = shadowContext.createRadialGradient(64, 64, 3, 64, 64, 64);
shadowGradient.addColorStop(0, 'rgba(0,0,0,.55)');
shadowGradient.addColorStop(1, 'rgba(0,0,0,0)');
shadowContext.fillStyle = shadowGradient;
shadowContext.fillRect(0, 0, 128, 128);
const groundShadow = new THREE.Mesh(
  new THREE.PlaneGeometry(13, 7),
  new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(shadowCanvas), transparent: true, depthWrite: false, opacity: .72 }),
);
groundShadow.rotation.x = -Math.PI / 2;
groundShadow.position.set(0, -6.55, 0);
scene.add(groundShadow);

function rebuildPostprocessing() {
  clearTimeout(postTimer);
  if (composer) {
    composer.dispose?.();
    composer = null;
    bloomPass = null;
  }
  if (!profile.bloom || state.bloom <= 0.01) return;
  composer = new EffectComposer(renderer);
  composer.setPixelRatio(Math.min(renderer.getPixelRatio(), resolvedQuality === 'high' ? 1.1 : 0.72));
  composer.addPass(new RenderPass(scene, camera));
  bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), state.bloom, 0.5, 0.72);
  composer.addPass(bloomPass);
  composer.setSize(innerWidth, innerHeight);
}

rebuildPostprocessing();

function prepareModel(root) {
  modelRoot = root;
  pivot.add(modelRoot);
  modelRoot.updateMatrixWorld(true);

  const initialBox = new THREE.Box3().setFromObject(modelRoot);
  const size = initialBox.getSize(new THREE.Vector3());
  const fitScale = 12 / Math.max(size.x, size.y, size.z, .001);
  modelRoot.scale.setScalar(fitScale);
  modelRoot.updateMatrixWorld(true);
  const centeredBox = new THREE.Box3().setFromObject(modelRoot);
  const center = centeredBox.getCenter(new THREE.Vector3());
  modelRoot.position.sub(center);
  modelRoot.updateMatrixWorld(true);
  pivot.updateMatrixWorld(true);

  modelMeshes = [];
  materialRecords = [];
  const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

  modelRoot.traverse((mesh) => {
    if (!mesh.isMesh || !mesh.geometry?.getAttribute('position')) return;
    modelMeshes.push(mesh);

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const clones = materials.map((original) => {
      const material = original.clone();
      const baseOpacity = 1 - state.modelHaze * .42;
      material.transparent = state.modelHaze > .001;
      material.opacity = baseOpacity;
      material.depthWrite = true;
      material.depthTest = true;
      if ('roughness' in material) material.roughness = .7 - state.surfaceDetail * .44;
      if ('envMapIntensity' in material) material.envMapIntensity = .45 + state.surfaceDetail * 1.15;
      if (material.normalScale) material.normalScale.setScalar(.75 + state.surfaceDetail * .55);
      ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap'].forEach((key) => {
        if (material[key]) material[key].anisotropy = maxAnisotropy;
      });
      if ('emissive' in material) material.emissive = new THREE.Color(0x030806);
      if ('emissiveIntensity' in material) material.emissiveIntensity = .015;
      material.needsUpdate = true;
      materialRecords.push({ material, baseEmissive: .015, baseOpacity });
      return material;
    });
    mesh.material = Array.isArray(mesh.material) ? clones : clones[0];

  });

  const finalBox = new THREE.Box3().setFromObject(modelRoot);
  groundShadow.position.y = finalBox.min.y - .3;

  modelReady = true;
  window.__viewerReadyMs = Math.round(performance.now() - viewerStartedAt);
  setStatus('标本在线 · Specimen live', 'live');
  setLoading(100, '实体标本与材质光场已就绪 · Specimen ready');
  setTimeout(() => loadingOverlay.classList.add('hidden'), 140);
  setTimeout(() => gestureGuide.classList.add('fade'), 3600);
}

const modelLoader = new GLTFLoader();
setLoading(18, '读取轻量模型 · Loading optimized GLB');
modelLoader.load(
  'models/huangjing.glb',
  (gltf) => {
    setLoading(82, '构建雾感材质与探索光 · Shaping mist and light');
    requestAnimationFrame(() => {
      try { prepareModel(gltf.scene); }
      catch (error) { failModel(error); }
    });
  },
  (event) => {
    if (!event.total) return;
    setLoading(18 + (event.loaded / event.total) * 58, `模型载入 · Loading ${Math.round(event.loaded / event.total * 100)}%`);
  },
  failModel,
);

function failModel(error) {
  console.error(error);
  setLoading(100, '模型加载失败 · Model failed to load');
  setStatus('模型加载失败 · Load failed', 'error');
  showToast('模型加载失败，请刷新重试 · Model failed, please refresh');
}

function saveSettings() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* private mode */ }
}

function formatSetting(name, value) {
  if (name === 'surfaceDetail' || name === 'beamFocus' || name === 'modelHaze') return `${Math.round(value * 100)}%`;
  if (name === 'inferenceFps') return `${Math.round(value)} FPS`;
  if (name === 'handLight') return Math.round(value);
  if (name === 'handRange') return Math.round(value);
  return Number(value).toFixed(name === 'autoRotateSpeed' ? 2 : 1);
}

function updateSettingUI(name) {
  const input = document.querySelector(`[data-setting="${name}"]`);
  if (input) input.value = state[name];
  const output = document.querySelector(`[data-output="${name}"]`);
  if (output) output.textContent = formatSetting(name, state[name]);
}

function applySetting(name, value, persist = true) {
  state[name] = name === 'quality' ? value : Number(value);
  updateSettingUI(name);

  switch (name) {
    case 'quality': {
      resolvedQuality = resolveQuality(state.quality);
      profile = PROFILES[resolvedQuality];
      renderer.setPixelRatio(Math.min(devicePixelRatio, profile.dpr));
      rebuildPostprocessing();
      const qualityLabel = resolvedQuality === 'low' ? '流畅 · Smooth' : resolvedQuality === 'high' ? '精细 · Detailed' : '均衡 · Balanced';
      showToast(`已切换至 ${qualityLabel}`);
      break;
    }
    case 'exposure': renderer.toneMappingExposure = state.exposure; break;
    case 'ambient': ambientLight.intensity = state.ambient; break;
    case 'bloom':
      if (bloomPass) bloomPass.strength = state.bloom;
      postTimer = setTimeout(rebuildPostprocessing, 240);
      break;
    case 'modelHaze':
      materialRecords.forEach((record) => {
        record.baseOpacity = 1 - state.modelHaze * .42;
        record.material.transparent = state.modelHaze > .001;
        record.material.opacity = record.baseOpacity;
        record.material.needsUpdate = true;
      });
      mistAura.material.opacity = .04 + state.modelHaze * .18;
      break;
    case 'surfaceDetail':
      materialRecords.forEach(({ material }) => {
        if ('roughness' in material) material.roughness = .7 - state.surfaceDetail * .44;
        if ('envMapIntensity' in material) material.envMapIntensity = .45 + state.surfaceDetail * 1.15;
        if (material.normalScale) material.normalScale.setScalar(.75 + state.surfaceDetail * .55);
      });
      break;
    case 'rimIntensity': jadeRim.intensity = state.rimIntensity; break;
    case 'handLight': handLight.intensity = state.handLight; break;
    case 'handRange': handLight.distance = state.handRange; break;
    case 'beamFocus': handLight.angle = THREE.MathUtils.lerp(Math.PI * .34, Math.PI * .09, state.beamFocus); break;
    case 'autoRotateSpeed': controls.autoRotateSpeed = state.autoRotateSpeed; break;
  }
  if (persist) saveSettings();
}

document.querySelectorAll('[data-setting]').forEach((input) => {
  updateSettingUI(input.dataset.setting);
  input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', () => applySetting(input.dataset.setting, input.value));
});

function setPanel(open) {
  panel.classList.toggle('open', open);
  $('#panel-toggle').setAttribute('aria-expanded', String(open));
}

$('#panel-toggle').addEventListener('click', () => setPanel(!panel.classList.contains('open')));
$('#dock-panel-button').addEventListener('click', () => setPanel(!panel.classList.contains('open')));
$('#panel-close').addEventListener('click', () => setPanel(false));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setPanel(false); });

$('#restore-button').addEventListener('click', () => {
  Object.entries(DEFAULTS).forEach(([name, value]) => applySetting(name, value, false));
  saveSettings();
  showToast('已恢复推荐参数 · Defaults restored');
});

$('#reset-button').addEventListener('click', () => {
  controls.reset();
  pivot.rotation.set(0, 0, 0);
  pivot.scale.setScalar(1);
  showToast('视角已复位 · View reset');
});

const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17],
];
let handLandmarker = null;
let mediaStream = null;
let detectionRunning = false;
let videoFrameHandle = 0;
let detectionTimer = 0;
let lastDetectionAt = 0;
let handMisses = 0;

function landmarkDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
}

function updateHandData(landmarks) {
  const anchors = [0, 5, 9, 13, 17];
  const center = anchors.reduce((sum, index) => {
    sum.x += landmarks[index].x;
    sum.y += landmarks[index].y;
    return sum;
  }, { x: 0, y: 0 });
  center.x /= anchors.length;
  center.y /= anchors.length;

  const palmWidth = Math.max(.03, landmarkDistance(landmarks[5], landmarks[17]));
  const pinchRatio = landmarkDistance(landmarks[4], landmarks[8]) / palmWidth;
  const openness = THREE.MathUtils.clamp((pinchRatio - .22) / 1.35, 0, 1);
  const raw = { x: (0.5 - center.x) * 2, y: (0.5 - center.y) * 2, openness };

  if (!handData) handData = raw;
  else {
    const distance = Math.hypot(raw.x - handData.x, raw.y - handData.y);
    const alpha = Math.min(.44, .16 + distance * .28);
    handData.x = THREE.MathUtils.lerp(handData.x, Math.abs(raw.x) < .035 ? 0 : raw.x, alpha);
    handData.y = THREE.MathUtils.lerp(handData.y, Math.abs(raw.y) < .035 ? 0 : raw.y, alpha);
    handData.openness = THREE.MathUtils.lerp(handData.openness, raw.openness, .2);
  }
  handDetected = true;
  handMisses = 0;
  gestureGuide.classList.add('fade');
  cameraLabelText.textContent = 'HAND LIVE · 手势在线';
}

function drawHand(landmarks) {
  const width = handCanvas.width;
  const height = handCanvas.height;
  handContext.clearRect(0, 0, width, height);
  handContext.strokeStyle = '#9ee5bd';
  handContext.lineWidth = 2;
  handContext.shadowColor = '#71c99c';
  handContext.shadowBlur = 4;
  HAND_CONNECTIONS.forEach(([a, b]) => {
    handContext.beginPath();
    handContext.moveTo(landmarks[a].x * width, landmarks[a].y * height);
    handContext.lineTo(landmarks[b].x * width, landmarks[b].y * height);
    handContext.stroke();
  });
}

function scheduleDetection() {
  if (!detectionRunning) return;
  if ('requestVideoFrameCallback' in video) videoFrameHandle = video.requestVideoFrameCallback(detectFrame);
  else detectionTimer = setTimeout(() => detectFrame(performance.now()), 16);
}

function detectFrame(now) {
  if (!detectionRunning) return;
  const interval = 1000 / state.inferenceFps;
  if (!document.hidden && video.readyState >= 2 && now - lastDetectionAt >= interval) {
    lastDetectionAt = now;
    try {
      const result = handLandmarker.detectForVideo(video, now);
      if (result.landmarks?.length) {
        updateHandData(result.landmarks[0]);
        drawHand(result.landmarks[0]);
      } else {
        handMisses += 1;
        if (handMisses > 4) {
          handDetected = false;
          handData = null;
          handContext.clearRect(0, 0, handCanvas.width, handCanvas.height);
          cameraLabelText.textContent = 'SEARCHING · 寻找手部';
        }
      }
    } catch (error) {
      console.warn('Hand frame skipped', error);
    }
  }
  scheduleDetection();
}

async function createHandLandmarker(HandLandmarker, vision, delegate) {
  return HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: 'models/hand_landmarker.task', delegate },
    numHands: 1,
    runningMode: 'VIDEO',
    minHandDetectionConfidence: .55,
    minHandPresenceConfidence: .5,
    minTrackingConfidence: .5,
  });
}

async function startHandTracking() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast('摄像头不可用，仍可用鼠标或触控探索 · Camera unavailable');
    return;
  }
  handButton.disabled = true;
  handButton.querySelector('b').textContent = '正在启动';
  handButton.querySelector('small').textContent = 'Starting…';
  setStatus('手势启动中 · Starting hand control');

  try {
    const cameraPromise = navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: 480, max: 640 },
        height: { ideal: 360, max: 480 },
        frameRate: { ideal: 24, max: 30 },
        facingMode: 'user',
      },
    });
    const modulePromise = import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.min.mjs');
    const [stream, mediaPipe] = await Promise.all([cameraPromise, modulePromise]);
    mediaStream = stream;
    video.srcObject = stream;
    await video.play();
    handCanvas.width = video.videoWidth || 480;
    handCanvas.height = video.videoHeight || 360;

    const vision = await mediaPipe.FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm');
    try {
      handLandmarker = await createHandLandmarker(mediaPipe.HandLandmarker, vision, 'GPU');
    } catch (gpuError) {
      console.warn('GPU hand tracking unavailable, switching to CPU', gpuError);
      handLandmarker = await createHandLandmarker(mediaPipe.HandLandmarker, vision, 'CPU');
      showToast('已自动切换 CPU 手势识别 · CPU mode enabled');
    }

    detectionRunning = true;
    scheduleDetection();
    cameraCard.classList.add('show');
    handButton.classList.add('active');
    handButton.querySelector('b').textContent = '关闭手势';
    handButton.querySelector('small').textContent = 'Hand live';
    setStatus('手势已连接 · Hand live', 'live');
    showToast('移动旋转，张合缩放，靠近显影 · Move, zoom and illuminate');
  } catch (error) {
    console.error(error);
    stopHandTracking(false);
    setStatus('手势启动失败 · Hand failed', 'error');
    showToast(error.name === 'NotAllowedError' ? '请允许摄像头；也可使用鼠标探索 · Camera permission needed' : '手势启动失败，请重试 · Please retry');
  } finally {
    handButton.disabled = false;
  }
}

function stopHandTracking(notify = true) {
  detectionRunning = false;
  if (videoFrameHandle && 'cancelVideoFrameCallback' in video) video.cancelVideoFrameCallback(videoFrameHandle);
  clearTimeout(detectionTimer);
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  video.srcObject = null;
  handLandmarker?.close?.();
  handLandmarker = null;
  handDetected = false;
  handData = null;
  handContext.clearRect(0, 0, handCanvas.width, handCanvas.height);
  cameraCard.classList.remove('show');
  handButton.classList.remove('active');
  handButton.querySelector('b').textContent = '开启手势';
  handButton.querySelector('small').textContent = 'Hand control';
  setStatus(modelReady ? '标本在线 · Specimen live' : '模型准备中 · Preparing', modelReady ? 'live' : '');
  if (notify) showToast('手势已关闭，鼠标与触控仍可探索 · Pointer remains active');
}

handButton.addEventListener('click', () => detectionRunning ? stopHandTracking() : startHandTracking());

const clock = new THREE.Clock();
const handWorldPosition = new THREE.Vector3();
const handNdc = new THREE.Vector2();
const handRaycaster = new THREE.Raycaster();
const beamTargetPosition = new THREE.Vector3();
const beamFallbackPosition = new THREE.Vector3();
let pointerLightData = null;
let lastMetricUpdate = 0;
let frameCounter = 0;
let fps = 0;
let metricStart = performance.now();

canvas.addEventListener('pointermove', (event) => {
  gestureGuide.classList.add('fade');
  const rect = canvas.getBoundingClientRect();
  pointerLightData = {
    x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
    y: 1 - ((event.clientY - rect.top) / rect.height) * 2,
  };
}, { passive: true });
canvas.addEventListener('pointerleave', () => { pointerLightData = null; });

function resetModelGlow(response) {
  materialRecords.forEach(({ material, baseEmissive, baseOpacity }) => {
    if ('emissiveIntensity' in material) material.emissiveIntensity = THREE.MathUtils.lerp(material.emissiveIntensity, baseEmissive, response * .5);
    material.opacity = THREE.MathUtils.lerp(material.opacity, baseOpacity, response * .6);
  });
}

function updateFlashlight(input, response, time, strength = 1) {
  pivot.updateMatrixWorld(true);
  handNdc.set(input.x, input.y);
  handRaycaster.setFromCamera(handNdc, camera);
  const hits = modelReady ? handRaycaster.intersectObjects(modelMeshes, false) : [];
  const hit = hits[0] || null;
  handRaycaster.ray.at(25, beamFallbackPosition);
  beamTargetPosition.copy(hit ? hit.point : beamFallbackPosition);
  handWorldPosition.copy(handRaycaster.ray.origin).addScaledVector(handRaycaster.ray.direction, 4.5);
  handLight.position.copy(handWorldPosition);
  handLight.target.position.lerp(beamTargetPosition, response);
  handLight.target.updateMatrixWorld();
  handLight.intensity = THREE.MathUtils.lerp(handLight.intensity, state.handLight * (hit ? 1.18 : .72) * strength, response);
  handHalo.position.lerp(beamTargetPosition, response);
  handHalo.quaternion.copy(camera.quaternion);
  handHalo.scale.setScalar((hit ? 1.05 : .72) + Math.sin(time * 6) * .08);
  handHalo.material.opacity = THREE.MathUtils.lerp(handHalo.material.opacity, (hit ? .86 : .2) * strength, response);
  handLight.visible = state.handLight > 0;
  handHalo.visible = true;

  resetModelGlow(response);
  if (hit) {
    const hitMaterials = Array.isArray(hit.object.material) ? hit.object.material : [hit.object.material];
    hitMaterials.forEach((material) => {
      if ('emissiveIntensity' in material) material.emissiveIntensity = THREE.MathUtils.lerp(material.emissiveIntensity, .03 + state.touchBoost * .48 * strength, response);
      material.opacity = THREE.MathUtils.lerp(material.opacity, 1, response * .9);
    });
    touchLight.position.copy(hit.point).addScaledVector(handRaycaster.ray.direction, -.35);
    touchLight.intensity = THREE.MathUtils.lerp(touchLight.intensity, (6 + state.touchBoost * 12) * strength, response);
    touchLight.visible = true;
    exploreGlow.position.copy(hit.point).addScaledVector(handRaycaster.ray.direction, -.22);
    exploreGlow.scale.setScalar(2.05 + Math.sin(time * 4.8) * .12);
    exploreGlow.material.opacity = THREE.MathUtils.lerp(exploreGlow.material.opacity, .34 * strength, response);
    exploreGlow.visible = true;
  } else {
    touchLight.intensity = THREE.MathUtils.lerp(touchLight.intensity, 0, response);
    touchLight.visible = touchLight.intensity > .05;
    exploreGlow.material.opacity = THREE.MathUtils.lerp(exploreGlow.material.opacity, 0, response);
    exploreGlow.visible = exploreGlow.material.opacity > .01;
  }
}

function animate(now) {
  requestAnimationFrame(animate);
  if (document.hidden) return;
  const delta = Math.min(clock.getDelta(), .05);
  const time = clock.elapsedTime;
  frameCounter += 1;
  pivot.position.y = Math.sin(time * .62) * .07;
  groundShadow.material.opacity = .64 + Math.sin(time * .62) * .05;
  mistAura.material.opacity = (.04 + state.modelHaze * .18) * (1 + Math.sin(time * .43) * .08);

  const response = 1 - Math.exp(-(5 + state.movementSpeed * 5) * delta);
  if (handDetected && handData) {
    controls.autoRotate = false;
    const targetY = handData.x * Math.PI * .78 * state.rotationSensitivity;
    const targetX = handData.y * .72 * state.rotationSensitivity;
    pivot.rotation.y = THREE.MathUtils.lerp(pivot.rotation.y, targetY, response);
    pivot.rotation.x = THREE.MathUtils.lerp(pivot.rotation.x, targetX, response);
    const targetScale = .78 + handData.openness * .62 * state.zoomSensitivity;
    const nextScale = THREE.MathUtils.lerp(pivot.scale.x, targetScale, response * .72);
    pivot.scale.setScalar(nextScale);
  } else {
    controls.autoRotate = state.autoRotateSpeed > 0;
    controls.autoRotateSpeed = state.autoRotateSpeed;
  }

  if (handDetected && handData) {
    updateFlashlight(handData, response, time, 1);
  } else if (pointerLightData) {
    updateFlashlight(pointerLightData, response, time, .68);
  } else {
    handLight.visible = false;
    handHalo.visible = false;
    touchLight.visible = false;
    touchLight.intensity = 0;
    exploreGlow.visible = false;
    exploreGlow.material.opacity = 0;
    resetModelGlow(.12);
  }

  controls.update(delta);
  const exploring = (handDetected && handData) || pointerLightData;
  keyLight.intensity = THREE.MathUtils.lerp(keyLight.intensity, exploring ? 1.78 : 2.12, response * .35);
  ambientLight.intensity = THREE.MathUtils.lerp(ambientLight.intensity, state.ambient * (exploring ? .8 : 1), response * .35);
  keyLight.position.x = 9 + Math.sin(time * .31) * 1.1;
  jadeRim.intensity = state.rimIntensity * (1 + Math.sin(time * .7) * .06);
  goldRim.intensity = 6.5 + Math.sin(time * .8) * 1.1;
  if (composer) composer.render(delta);
  else renderer.render(scene, camera);

  if (now - lastMetricUpdate > 900) {
    fps = Math.round(frameCounter * 1000 / (now - metricStart));
    frameCounter = 0;
    metricStart = now;
    lastMetricUpdate = now;
    const memory = performance.memory ? ` · ${Math.round(performance.memory.usedJSHeapSize / 1048576)} MB` : '';
    runtimeMetrics.textContent = `${fps} FPS · ${profile.label}${memory}`;
  }
}

requestAnimationFrame(animate);

function onResize() {
  pivot.position.x = innerWidth > 980 ? 1.15 : 0;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.setPixelRatio(Math.min(devicePixelRatio, profile.dpr));
  composer?.setSize(innerWidth, innerHeight);
}

let resizeTimer = 0;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(onResize, 120);
});

canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  setStatus('图形上下文已暂停 · Graphics paused', 'error');
  showToast('图形上下文已暂停，请刷新恢复 · Please refresh');
});

addEventListener('beforeunload', () => stopHandTracking(false));

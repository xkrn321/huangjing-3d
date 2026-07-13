import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

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

const STORAGE_KEY = 'huangjing-viewer-v12';
const DEFAULTS = Object.freeze({
  quality: 'auto',
  exposure: 1.05,
  ambient: 0.55,
  bloom: 0.35,
  meshOpacity: 0.42,
  particleOpacity: 0.62,
  particleSize: 0.8,
  cloudAmount: 0.05,
  movementSpeed: 1,
  rotationSensitivity: 1,
  zoomSensitivity: 1,
  inferenceFps: 24,
  handLight: 70,
  handRange: 72,
  autoRotateSpeed: 0.6,
});

const PROFILES = Object.freeze({
  low: { particles: 12000, dpr: 0.9, bloom: false, label: 'FLOW' },
  balanced: { particles: 22000, dpr: 1, bloom: true, label: 'BAL' },
  high: { particles: 38000, dpr: 1.35, bloom: true, label: 'HIGH' },
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
let particles = null;
let modelRoot = null;
let sourceMeshes = [];
let materialRecords = [];
let touchTargets = [];
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
  setLoading(100, '当前浏览器无法启动 WebGL');
  setStatus('WebGL 不可用', 'error');
  throw error;
}

renderer.setClearColor(0x06100e, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = state.exposure;
renderer.setSize(innerWidth, innerHeight, false);
renderer.setPixelRatio(Math.min(devicePixelRatio, profile.dpr));

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x06100e, 0.016);
const pivot = new THREE.Group();
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

const ambientLight = new THREE.HemisphereLight(0xc7ead7, 0x15100b, state.ambient);
scene.add(ambientLight);
const keyLight = new THREE.DirectionalLight(0xf7e9ce, 1.35);
keyLight.position.set(9, 13, 11);
scene.add(keyLight);
const jadeRim = new THREE.DirectionalLight(0x66d6a3, 0.72);
jadeRim.position.set(-10, 5, -12);
scene.add(jadeRim);
const goldRim = new THREE.PointLight(0xd8ad61, 9, 34, 1.7);
goldRim.position.set(7, -4, 5);
scene.add(goldRim);

const handLight = new THREE.PointLight(0xffc36e, state.handLight, state.handRange, 1.7);
handLight.visible = false;
scene.add(handLight);
const handHalo = new THREE.Mesh(
  new THREE.SphereGeometry(0.22, 10, 10),
  new THREE.MeshBasicMaterial({ color: 0xffd49a, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending }),
);
handHalo.visible = false;
scene.add(handHalo);

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

const particleMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 },
    uPixelRatio: { value: renderer.getPixelRatio() },
    uCloudAmount: { value: state.cloudAmount },
    uPointScale: { value: state.particleSize },
    uOpacity: { value: state.particleOpacity },
    uHandPosition: { value: new THREE.Vector3(0, 0, 100) },
    uHandActive: { value: 0 },
  },
  vertexShader: `
    uniform float uTime, uPixelRatio, uCloudAmount, uPointScale;
    attribute vec3 aCloudOffset, aColor;
    attribute float aSize;
    varying vec3 vColor;
    varying vec3 vBasePosition;
    void main() {
      vColor = aColor;
      vBasePosition = position;
      float wave = sin(uTime * .65 + position.y * .42 + position.x * .18) * .16;
      vec3 p = position + aCloudOffset * uCloudAmount;
      p += normalize(aCloudOffset + .001) * wave * uCloudAmount;
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_PointSize = aSize * uPointScale * uPixelRatio * (110.0 / max(3.0, -mv.z));
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: `
    uniform vec3 uHandPosition;
    uniform float uHandActive, uOpacity;
    varying vec3 vColor;
    varying vec3 vBasePosition;
    void main() {
      float d = length(gl_PointCoord - vec2(.5));
      if (d > .5) discard;
      float core = 1.0 - smoothstep(.0, .5, d);
      float touch = uHandActive * exp(-length(vBasePosition - uHandPosition) * .42);
      vec3 color = vColor * (.58 + core * .46 + touch * 1.25);
      gl_FragColor = vec4(color, core * (.2 + touch * .22) * uOpacity);
    }
  `,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});

function pickSource(vertexIndex) {
  for (const source of sourceMeshes) {
    if (vertexIndex < source.end) return source;
  }
  return sourceMeshes[sourceMeshes.length - 1];
}

function buildParticles(count = profile.particles) {
  if (!sourceMeshes.length) return;
  const totalVertices = sourceMeshes[sourceMeshes.length - 1].end;
  const positions = new Float32Array(count * 3);
  const offsets = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const point = new THREE.Vector3();
  const drift = new THREE.Vector3();
  const outward = new THREE.Vector3();
  const jade = new THREE.Color(0x74c49b);
  const gold = new THREE.Color(0xe4b86c);
  const pale = new THREE.Color(0xdcebdc);
  const color = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const targetIndex = Math.floor(Math.random() * totalVertices);
    const source = pickSource(targetIndex);
    const localIndex = Math.max(0, targetIndex - source.start) % source.position.count;
    point.fromBufferAttribute(source.position, localIndex).applyMatrix4(source.matrix);
    const i3 = i * 3;
    positions[i3] = point.x;
    positions[i3 + 1] = point.y;
    positions[i3 + 2] = point.z;

    drift.set(Math.random() - .5, Math.random() - .5, Math.random() - .5).normalize();
    outward.copy(point).normalize();
    const spread = 1.2 + Math.random() * 4.4;
    offsets[i3] = outward.x * spread * .55 + drift.x * spread;
    offsets[i3 + 1] = outward.y * spread * .55 + drift.y * spread;
    offsets[i3 + 2] = outward.z * spread * .55 + drift.z * spread;

    const mix = Math.random();
    if (mix > .91) color.copy(pale);
    else color.lerpColors(jade, gold, Math.min(.72, Math.max(.08, .22 + point.y * .02 + Math.random() * .3)));
    color.multiplyScalar(.78 + Math.random() * .32);
    colors[i3] = color.r;
    colors[i3 + 1] = color.g;
    colors[i3 + 2] = color.b;
    sizes[i] = .72 + Math.random() * 1.25;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aCloudOffset', new THREE.BufferAttribute(offsets, 3));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.computeBoundingSphere();

  if (particles) {
    particles.geometry.dispose();
    particles.geometry = geometry;
  } else {
    particles = new THREE.Points(geometry, particleMaterial);
    particles.frustumCulled = true;
    pivot.add(particles);
  }
}

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

  sourceMeshes = [];
  materialRecords = [];
  touchTargets = [];
  let vertexCursor = 0;

  modelRoot.traverse((mesh) => {
    if (!mesh.isMesh || !mesh.geometry?.getAttribute('position')) return;
    const position = mesh.geometry.getAttribute('position');
    const matrix = mesh.matrixWorld.clone();
    sourceMeshes.push({ start: vertexCursor, end: vertexCursor + position.count, position, matrix });
    vertexCursor += position.count;

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const clones = materials.map((original) => {
      const material = original.clone();
      material.transparent = true;
      material.opacity = state.meshOpacity;
      material.depthWrite = true;
      if ('roughness' in material) material.roughness = .52;
      if ('metalness' in material) material.metalness = .02;
      if ('emissive' in material) material.emissive = new THREE.Color(0x071610);
      if ('emissiveIntensity' in material) material.emissiveIntensity = .08;
      materialRecords.push({ material, baseEmissive: .08 });
      return material;
    });
    mesh.material = Array.isArray(mesh.material) ? clones : clones[0];

    const meshCenter = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
    pivot.worldToLocal(meshCenter);
    touchTargets.push({ center: meshCenter, materials: clones });
  });

  modelReady = true;
  window.__viewerReadyMs = Math.round(performance.now() - viewerStartedAt);
  setStatus('标本在线', 'live');
  setLoading(100, '实体标本已就绪 · 粒子层后台生成');
  setTimeout(() => loadingOverlay.classList.add('hidden'), 140);

  const buildWhenIdle = () => {
    if (particles) return;
    buildParticles(profile.particles);
    window.__particleReadyMs = Math.round(performance.now() - viewerStartedAt);
    setStatus('标本在线', 'live');
  };
  if ('requestIdleCallback' in window) requestIdleCallback(buildWhenIdle, { timeout: 900 });
  else setTimeout(buildWhenIdle, 120);
}

const modelLoader = new GLTFLoader();
setLoading(18, '读取外置 GLB · 避免 Base64 双份内存');
modelLoader.load(
  'models/huangjing.glb',
  (gltf) => {
    setLoading(82, '构建自适应粒子层');
    requestAnimationFrame(() => {
      try { prepareModel(gltf.scene); }
      catch (error) { failModel(error); }
    });
  },
  (event) => {
    if (!event.total) return;
    setLoading(18 + (event.loaded / event.total) * 58, `模型载入 ${Math.round(event.loaded / event.total * 100)}%`);
  },
  failModel,
);

function failModel(error) {
  console.error(error);
  setLoading(100, '模型加载失败，请检查网络后刷新');
  setStatus('模型加载失败', 'error');
  showToast('模型加载失败：请刷新页面重试');
}

function saveSettings() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* private mode */ }
}

function formatSetting(name, value) {
  if (name === 'meshOpacity' || name === 'particleOpacity') return `${Math.round(value * 100)}%`;
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
      particleMaterial.uniforms.uPixelRatio.value = renderer.getPixelRatio();
      if (modelReady) buildParticles(profile.particles);
      rebuildPostprocessing();
      showToast(`已切换到${resolvedQuality === 'low' ? '流畅' : resolvedQuality === 'high' ? '精细' : '均衡'}档`);
      break;
    }
    case 'exposure': renderer.toneMappingExposure = state.exposure; break;
    case 'ambient': ambientLight.intensity = state.ambient; break;
    case 'bloom':
      if (bloomPass) bloomPass.strength = state.bloom;
      postTimer = setTimeout(rebuildPostprocessing, 240);
      break;
    case 'meshOpacity':
      materialRecords.forEach(({ material }) => { material.opacity = state.meshOpacity; });
      break;
    case 'particleOpacity': particleMaterial.uniforms.uOpacity.value = state.particleOpacity; break;
    case 'particleSize': particleMaterial.uniforms.uPointScale.value = state.particleSize; break;
    case 'cloudAmount': particleMaterial.uniforms.uCloudAmount.value = state.cloudAmount; break;
    case 'handLight': handLight.intensity = state.handLight; break;
    case 'handRange': handLight.distance = state.handRange; break;
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
  showToast('已恢复推荐参数');
});

$('#reset-button').addEventListener('click', () => {
  controls.reset();
  pivot.rotation.set(0, 0, 0);
  pivot.scale.setScalar(1);
  showToast('视角已复位');
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
  cameraLabelText.textContent = 'HAND LIVE';
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
          cameraLabelText.textContent = 'SEARCHING';
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
    showToast('此浏览器不支持摄像头；仍可用鼠标或触摸控制');
    return;
  }
  handButton.disabled = true;
  handButton.querySelector('b').textContent = '正在启动';
  setStatus('手势引擎启动中');

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
      showToast('GPU 不兼容，已自动切换 CPU 手势识别');
    }

    detectionRunning = true;
    scheduleDetection();
    cameraCard.classList.add('show');
    handButton.classList.add('active');
    handButton.querySelector('b').textContent = '关闭手势';
    handButton.querySelector('small').textContent = 'LIVE';
    setStatus('手势已连接', 'live');
    showToast('手势已就绪：移动旋转，张合缩放');
  } catch (error) {
    console.error(error);
    stopHandTracking(false);
    setStatus('手势启动失败', 'error');
    showToast(error.name === 'NotAllowedError' ? '需要摄像头权限；仍可用鼠标或触摸' : '手势启动失败，请重试');
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
  handButton.querySelector('small').textContent = 'CAMERA';
  setStatus(modelReady ? '标本在线' : '模型准备中', modelReady ? 'live' : '');
  if (notify) showToast('手势已关闭，可继续用鼠标或触摸');
}

handButton.addEventListener('click', () => detectionRunning ? stopHandTracking() : startHandTracking());

const clock = new THREE.Clock();
const handWorldPosition = new THREE.Vector3();
const handLocalPosition = new THREE.Vector3();
let lastMetricUpdate = 0;
let frameCounter = 0;
let fps = 0;
let metricStart = performance.now();

function animate(now) {
  requestAnimationFrame(animate);
  if (document.hidden) return;
  const delta = Math.min(clock.getDelta(), .05);
  const time = clock.elapsedTime;
  particleMaterial.uniforms.uTime.value = time;
  frameCounter += 1;

  if (handDetected && handData) {
    controls.autoRotate = false;
    const response = 1 - Math.exp(-(5 + state.movementSpeed * 5) * delta);
    const targetY = handData.x * Math.PI * .78 * state.rotationSensitivity;
    const targetX = handData.y * .72 * state.rotationSensitivity;
    pivot.rotation.y = THREE.MathUtils.lerp(pivot.rotation.y, targetY, response);
    pivot.rotation.x = THREE.MathUtils.lerp(pivot.rotation.x, targetX, response);
    const targetScale = .78 + handData.openness * .62 * state.zoomSensitivity;
    const nextScale = THREE.MathUtils.lerp(pivot.scale.x, targetScale, response * .72);
    pivot.scale.setScalar(nextScale);

    handWorldPosition.set(handData.x * 8.5, handData.y * 6.5, 8 + handData.openness * 5);
    handLight.position.copy(handWorldPosition);
    handHalo.position.copy(handWorldPosition);
    handLight.visible = state.handLight > 0;
    handHalo.visible = true;
    handHalo.scale.setScalar(.9 + Math.sin(time * 6) * .14);
    handLocalPosition.copy(handWorldPosition);
    pivot.worldToLocal(handLocalPosition);
    particleMaterial.uniforms.uHandPosition.value.copy(handLocalPosition);
    particleMaterial.uniforms.uHandActive.value = 1;

    touchTargets.forEach(({ center, materials }) => {
      const glow = Math.max(0, 1 - handLocalPosition.distanceTo(center) / 6);
      materials.forEach((material) => {
        if ('emissiveIntensity' in material) material.emissiveIntensity = THREE.MathUtils.lerp(material.emissiveIntensity, .08 + glow * 1.35, response);
      });
    });
  } else {
    controls.autoRotate = state.autoRotateSpeed > 0;
    controls.autoRotateSpeed = state.autoRotateSpeed;
    handLight.visible = false;
    handHalo.visible = false;
    particleMaterial.uniforms.uHandActive.value = 0;
    materialRecords.forEach(({ material, baseEmissive }) => {
      if ('emissiveIntensity' in material) material.emissiveIntensity = THREE.MathUtils.lerp(material.emissiveIntensity, baseEmissive, .08);
    });
  }

  controls.update(delta);
  goldRim.intensity = 8 + Math.sin(time * .8) * 1.5;
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
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.setPixelRatio(Math.min(devicePixelRatio, profile.dpr));
  particleMaterial.uniforms.uPixelRatio.value = renderer.getPixelRatio();
  composer?.setSize(innerWidth, innerHeight);
}

let resizeTimer = 0;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(onResize, 120);
});

canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  setStatus('图形上下文已暂停', 'error');
  showToast('显卡上下文已暂停，请刷新页面恢复');
});

addEventListener('beforeunload', () => stopHandTracking(false));

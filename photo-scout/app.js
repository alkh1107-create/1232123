import { AestheticModel } from './aesthetics.js';
import { PhotoEditor } from './editor.js';
const $ = (id) => document.getElementById(id);
const video = $('video');
const viewport = $('viewport');
const overlay = $('overlay');
const overlayContext = overlay.getContext('2d');
const measureCanvas = $('analysis-canvas');
const measureContext = measureCanvas.getContext('2d', { willReadFrequently: true });
const classRu = { person: 'человек', dog: 'собака', cat: 'кошка', bird: 'птица', horse: 'лошадь', sheep: 'овца', cow: 'корова', elephant: 'слон', bear: 'медведь', zebra: 'зебра', giraffe: 'жираф', bicycle: 'велосипед', motorcycle: 'мотоцикл', car: 'автомобиль', bus: 'автобус', train: 'поезд', boat: 'лодка', 'potted plant': 'растение', flower: 'цветок', cake: 'торт', umbrella: 'зонт', backpack: 'рюкзак', handbag: 'сумка', bottle: 'бутылка', cup: 'чашка', 'sports ball': 'мяч', kite: 'воздушный змей', bench: 'скамейка', chair: 'стул', couch: 'диван', vase: 'ваза', book: 'книга', clock: 'часы', surfboard: 'доска для сёрфинга', snowboard: 'сноуборд', skateboard: 'скейтборд', 'dining table': 'стол', 'traffic light': 'светофор', 'fire hydrant': 'гидрант' };
const state = { stream: null, track: null, detector: null, modelLoading: false, cameraFacing: 'environment', torchOn: false, lastDetect: 0, busy: false, detections: [], best: null, metrics: null, tilt: 0, level: false, levelAvailable: false, lastLevel: false, orientationSubscribed: false, autoExposure: true, manualMode: false, caps: {}, autoTimer: 0, photos: [], galleryUrls: [], activePhoto: null, activeImage: null, edit: { exposure: 0, contrast: 0, color: 0, preset: 'natural' }, toastTimer: 0, db: null };

const aestheticModel = new AestheticModel((status) => {
  if(status==='loading') setAiStatus('NIMA · загрузка');
  if(status==='ready') setAiStatus('NIMA · локально', 'ready');
  if(status==='error') {
    setAiStatus('NIMA · недоступна', 'error');
    $('aesthetic-hint').textContent='Без оценки эстетики · технические подсказки работают';
  }
});
const editor = new PhotoEditor({ model:aestheticModel, toast,
onOriginalScore:async(photo,score)=>{photo.aesthetic=score;await savePhoto(photo);},
onSave:async(entry)=>{
  await savePhoto(entry); state.photos.unshift(entry); updatePhotoCount();
}});
let cameraGeneration=0, animationFrame=0, cameraStarting=false, pageName='camera';
let lastAesthetic=0, aestheticBusy=false, liveScore=null, bestFrame=null;

function visibleRect() {
  const rect=viewport.getBoundingClientRect();
  const scale=Math.max(rect.width/video.videoWidth,rect.height/video.videoHeight);
  const w=rect.width/scale,h=rect.height/scale;
  return {x:(video.videoWidth-w)/2,y:(video.videoHeight-h)/2,w,h};
}
async function scoreLive() {
  if(aestheticBusy || !aestheticModel.ready || !state.stream || document.hidden)return;
  aestheticBusy=true;lastAesthetic=Date.now();
  const generation=cameraGeneration;
  try {
    const crop=visibleRect(),canvas=document.createElement('canvas');
    const scale=Math.min(1,960/Math.max(crop.w,crop.h));
    canvas.width=Math.max(1,Math.round(crop.w*scale));canvas.height=Math.max(1,Math.round(crop.h*scale));
    canvas.getContext('2d').drawImage(video,crop.x,crop.y,crop.w,crop.h,0,0,canvas.width,canvas.height);
    const score=await aestheticModel.score(canvas);
    if(generation!==cameraGeneration || !state.stream)return;
    liveScore={...score,time:Date.now()};
    const improved=!bestFrame || score.mean>bestFrame.score.mean+.08;
    if(improved) {
      bestFrame={canvas,score,date:Date.now()};
      $('save-best').disabled=false;
      $('save-best').textContent='ЛУЧШИЙ · '+score.mean.toFixed(1);
    }
    $('aesthetic-hint').textContent=improved?'Новый лучший ракурс за этот поиск':'NIMA · лучший ракурс '+bestFrame.score.mean.toFixed(1)+' / 10 · продолжай поиск';
    updateQuality();renderAdvice();
  } catch(_) { /* Model reports its own state; never manufacture an aesthetic score. */ }
  finally {aestheticBusy=false;}
}
async function scoreSaved(entry) {
  const url=URL.createObjectURL(entry.blob);
  try {
    const image=new Image();image.src=url;await image.decode();
    entry.aesthetic=await aestheticModel.score(image);
    await savePhoto(entry);
    if(pageName==='gallery')renderGallery();
  } catch(_) { /* The photo remains usable without a model score. */ }
  finally {URL.revokeObjectURL(url);}
}
async function saveBest() {
  const best=bestFrame;if(!best)return;
  $('save-best').disabled=true;
  try {
    const blob=await new Promise(resolve=>best.canvas.toBlob(resolve,'image/jpeg',.95));
    if(!blob)throw new Error();
    const entry={id:crypto.randomUUID(),blob,date:Date.now(),label:'лучший ракурс · превью',score:null,
      aesthetic:best.score,width:best.canvas.width,height:best.canvas.height};
    await savePhoto(entry);state.photos.unshift(entry);updatePhotoCount();
    toast('Лучший ракурс сохранён как превью до 960 px');
  } catch(_){toast('Не удалось сохранить кадр');}
  finally {$('save-best').disabled=!bestFrame;}
}
async function importPhoto(file) {
  if(!file)return;
  if(file.size>80*1024*1024){toast('Выбери фото меньше 80 МБ');return;}
  const url=URL.createObjectURL(file);
  try {
    const image=new Image();image.src=url;await image.decode();
    const entry={id:crypto.randomUUID(),blob:file,date:Date.now(),label:file.name || 'фото',score:null,
      width:image.naturalWidth,height:image.naturalHeight};
    await savePhoto(entry);state.photos.unshift(entry);updatePhotoCount();
    state.activePhoto=entry;state.activeImage=null;showPage('editor');
  } catch(_){toast('Не удалось открыть или сохранить фото. Попробуй JPEG или PNG.');}
  finally {URL.revokeObjectURL(url);$('photo-file').value='';}
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function setAiStatus(message, kind = '') {
  const el = $('ai-status');
  el.className = `ai-status ${kind}`;
  el.innerHTML = `<i></i> ${message}`;
}

function showPage(name) {
  pageName=name;
  if(name!=='editor') { editor.cancel(); editor.setBusy(false); }
  document.querySelectorAll('.page').forEach((page) => page.classList.toggle('active', page.id === `page-${name}`));
  document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.page === name));
  if (name !== 'camera') stopCamera();
  if (name === 'gallery') renderGallery();
  if (name === 'editor') {
    if (state.activePhoto && (!state.activeImage || !editor.image || editor.photo?.id!==state.activePhoto.id)) openEditor(state.activePhoto);
    else { editor.setBusy(false); editor.sync(); editor.render(); }
  }
  if (name === 'camera' && !state.stream) {
    viewport.classList.remove('live');
    $('start-card').hidden = false;
  }
}

async function openCamera() {
  if(cameraStarting)return;
  cameraStarting=true;
  if (!navigator.mediaDevices?.getUserMedia) {
    cameraStarting=false;
    toast('Камера требует HTTPS и современный браузер');
    return;
  }
  if (!state.orientationSubscribed) {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission().then((permission) => {
        if (permission === 'granted') { window.addEventListener('deviceorientation', updateTilt); state.orientationSubscribed = true; }
        else toast('Горизонт недоступен без разрешения датчика');
      }).catch(() => toast('Нет доступа к датчику горизонта'));
    } else { window.addEventListener('deviceorientation', updateTilt); state.orientationSubscribed = true; }
  }

  $('start-camera').disabled = true;
  $('start-camera').textContent = 'ПОДКЛЮЧАЮ…';
  $('start-card').hidden = false;
  try {
    stopCamera();
    bestFrame=null;lastAesthetic=0;
    $('save-best').disabled=true;
    $('save-best').textContent='ЛУЧШИЙ КАДР —';
    $('aesthetic-hint').textContent='Ищу выразительный свет, цвет и композицию';
    const generation=cameraGeneration;
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: state.cameraFacing }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } }, audio: false });
    if(generation!==cameraGeneration || pageName!=='camera'){stream.getTracks().forEach(track=>track.stop());return;}
    state.stream=stream;
    state.track = state.stream.getVideoTracks()[0];
    video.srcObject = state.stream;
    await video.play();
    if(generation!==cameraGeneration || pageName!=='camera')return;
    viewport.classList.add('live');
    $('start-card').hidden = true;
    $('capture-button').disabled = false;
    $('manual-button').disabled = false;
    $('lens-button').disabled = false;
    const settings = state.track.getSettings?.() || {};
    $('resolution-tag').textContent = settings.width ? `${settings.width}×${settings.height}` : 'КАМЕРА';
    inspectCapabilities();
    aestheticModel.load().catch(()=>{});
    loadDetector();
    animationFrame=requestAnimationFrame(drawLoop);
  } catch (error) {
    const message = error.name === 'NotAllowedError' ? 'Разреши доступ к камере в браузере' : error.name === 'NotFoundError' ? 'Камера не найдена' : 'Не удалось включить камеру';
    $('scene-message').textContent = message;
    toast(message);
    setAiStatus('камера недоступна', 'error');
  } finally {
    cameraStarting=false;
    $('start-camera').disabled = false;
    $('start-camera').innerHTML = 'ВКЛЮЧИТЬ КАМЕРУ <b>↗</b>';
  }
}

function stopCamera() {
  cameraGeneration++;cancelAnimationFrame(animationFrame);
  liveScore=null;state.metrics=null;state.detections=[];state.best=null;
  $('score-badge').querySelector('b').textContent='—';
  if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
  state.stream = null;
  state.track = null;
  video.srcObject = null;
  viewport.classList.remove('live');
  $('capture-button').disabled = true;
  $('manual-button').disabled = true;
  $('lens-button').disabled = true;
  if ($('control-sheet').open) $('control-sheet').close();
}

function inspectCapabilities() {
  state.manualMode = false;
  state.autoExposure = true;
  $('manual-mode').classList.remove('selected'); $('auto-mode').classList.add('selected');
  state.caps = state.track?.getCapabilities?.() || {};
  const settings = state.track?.getSettings?.() || {};
  const caps = state.caps;
  const lines = [];
  if (caps.exposureCompensation) {
    const range = $('ev-control');
    range.min = caps.exposureCompensation.min ?? -2;
    range.max = caps.exposureCompensation.max ?? 2;
    range.step = caps.exposureCompensation.step ?? 0.1;
    range.value = settings.exposureCompensation ?? 0;
    range.disabled = false;
    lines.push('экспокоррекция доступна');
  } else {
    $('ev-control').disabled = true;
    lines.push('экспокоррекция — авто');
  }
  const canManual = hasOption(caps.exposureMode, 'manual') && caps.iso && caps.exposureTime;
  $('manual-mode').disabled = !canManual;
  if (caps.iso) configureRange('iso-control', caps.iso, settings.iso, (value) => value, Math.round);
  else $('iso-control').disabled = true;
  if (caps.exposureTime) configureRange('shutter-control', { min: 0, max: 100 }, settings.exposureTime, secondsToSlider, sliderToSeconds);
  else $('shutter-control').disabled = true;
  $('iso-label').textContent = settings.iso ? `ISO ${settings.iso}` : 'АВТО';
  $('shutter-label').textContent = settings.exposureTime ? formatShutter(settings.exposureTime) : 'АВТО';
  $('ev-label').textContent = `${Number(settings.exposureCompensation || 0).toFixed(1)} EV`;
  $('torch-button').hidden = !caps.torch;
  if (caps.zoom) lines.push('зум есть');
  $('zoom-row').hidden = !caps.zoom;
  if (caps.zoom) {
    const zoom = $('zoom-control');
    zoom.min = caps.zoom.min ?? 1;
    zoom.max = caps.zoom.max ?? 1;
    zoom.step = caps.zoom.step ?? .1;
    zoom.value = settings.zoom ?? zoom.min;
    $('zoom-label').textContent = `${Number(zoom.value).toFixed(1)}×`;
  }
  const shutterSupported = Boolean(caps.exposureTime);
  if (canManual) lines.push('ручные ISO и выдержка поддерживаются');
  else if (caps.iso || shutterSupported) lines.push('ручные настройки поддерживаются частично');
  else lines.push('ручные ISO/выдержка скрыты: браузер их не даёт');
  $('camera-support').textContent = `${lines.join(' · ')}. Показываю текущие значения камеры, когда они доступны.`;
  refreshActualExposure();
}

function hasOption(capability, item) { return Array.isArray(capability) && capability.includes(item); }
function configureRange(id, range, current, fromValue, toValue) {
  const input = $(id);
  input.min = range.min ?? 0;
  input.max = range.max ?? 100;
  input.step = range.step ?? (id === 'iso-control' ? 1 : 'any');
  const selected = current == null ? (Number(input.min) + Number(input.max)) / 2 : fromValue(current);
  input.value = Number.isFinite(selected) ? Math.max(Number(input.min), Math.min(Number(input.max), selected)) : input.min;
  input.disabled = state.manualMode ? false : id !== 'ev-control';
  if (id === 'shutter-control') input.dataset.map = 'log';
}
function secondsToSlider(seconds) {
  const range = state.caps.exposureTime;
  if (!range || range.max <= range.min || range.min <= 0) return 50;
  return 100 * Math.log(seconds / range.min) / Math.log(range.max / range.min);
}
function sliderToSeconds(slider) {
  const range = state.caps.exposureTime;
  if (!range || range.max <= range.min || range.min <= 0) return 1 / 125;
  return range.min * Math.pow(range.max / range.min, Number(slider) / 100);
}
function formatShutter(seconds) {
  if (!seconds) return 'АВТО';
  if (seconds >= 1) return `${seconds.toFixed(1)} с`;
  return `1/${Math.round(1 / seconds)} с`;
}

async function loadDetector() {
  if (state.modelLoading || state.detector) return;
  state.modelLoading = true;
  $('scene-message').textContent = 'Загружаю бесплатную модель распознавания…';
  try {
    const visionApi = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1');
    const vision = await visionApi.FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm');
    state.detector = await visionApi.ObjectDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-tasks/object_detector/efficientdet_lite0_uint8.tflite' },
      runningMode: 'VIDEO', maxResults: 8, scoreThreshold: 0.42,
    });

    $('scene-message').textContent = 'Наведи на объект — ищу удачную композицию';
  } catch (error) {
    console.warn('Photo Scout detector is unavailable', error);

    $('scene-message').textContent = 'Модель не загрузилась. Проверяю свет и горизонт без распознавания.';
  } finally { state.modelLoading = false; }
}

function drawLoop() {
  if (!state.stream || !video.videoWidth) {
    if (state.stream) animationFrame=requestAnimationFrame(drawLoop);
    return;
  }
  drawOverlay();
  if (Date.now()-lastAesthetic>Math.max(1600,aestheticModel.ms*2.5)) scoreLive();
  if (Date.now() - state.lastDetect > 600 && !state.busy && state.detector) detectFrame();
  if (Date.now() - (state.metrics?.time || 0) > 500) measureFrame();
  if (state.stream) animationFrame=requestAnimationFrame(drawLoop);
}

function detectFrame() {
  if (!state.detector || state.busy || !state.stream) return;
  state.busy = true;
  state.lastDetect = Date.now();
  try {
    const result = state.detector.detectForVideo(video, performance.now());
    state.detections = result.detections || [];
    chooseSubject();
    renderAdvice();
  } catch (error) {
    console.warn('Frame detection failed', error);
  } finally { state.busy = false; }
}

function chooseSubject() {
  if (!state.detections.length) { state.best = null; return; }
  const width = video.videoWidth;
  const height = video.videoHeight;
  const viewportRect = viewport.getBoundingClientRect();
  const scale = Math.max(viewportRect.width / width, viewportRect.height / height);
  const cropX = (viewportRect.width - width * scale) / 2;
  const cropY = (viewportRect.height - height * scale) / 2;
  const nodes = [.333, .667];
  state.detections = state.detections.map((detection) => {
    const box = detection.boundingBox;
    const x = ((box.originX + box.width / 2) * scale + cropX) / viewportRect.width;
    const y = ((box.originY + box.height / 2) * scale + cropY) / viewportRect.height;
    const area = Math.min(1, box.width * scale * box.height * scale / (viewportRect.width * viewportRect.height));
    let nearest = { distance: Infinity, x: .5, y: .5 };
    for (const nx of nodes) for (const ny of nodes) {
      const distance = Math.hypot(x - nx, y - ny);
      if (distance < nearest.distance) nearest = { distance, x: nx, y: ny };
    }
    const category = detection.categories?.[0];
    const subjectValue = category?.score || 0;
    const framing = Math.max(0, 1 - nearest.distance / .55);
    const areaValue = area < .015 ? .35 : area > .58 ? .35 : area > .32 ? .75 : 1;
    return { detection, category, box, x, y, area, target: nearest, framing, rank: subjectValue * .42 + framing * .4 + areaValue * .18 };
  }).sort((a, b) => b.rank - a.rank);
  state.best = state.detections[0];
}

function drawOverlay() {
  if(!video.videoWidth)return;
  const rect = viewport.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixelW = Math.max(1, Math.round(rect.width * dpr));
  const pixelH = Math.max(1, Math.round(rect.height * dpr));
  if (overlay.width !== pixelW || overlay.height !== pixelH) { overlay.width = pixelW; overlay.height = pixelH; }
  overlayContext.setTransform(dpr, 0, 0, dpr, 0, 0);
  const ctx = overlayContext;
  const width = rect.width;
  const height = rect.height;
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.strokeStyle = '#e7ffb266';
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 5]);
  for (const p of [1 / 3, 2 / 3]) { ctx.beginPath(); ctx.moveTo(width * p, 0); ctx.lineTo(width * p, height); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, height * p); ctx.lineTo(width, height * p); ctx.stroke(); }
  ctx.setLineDash([]);
  const tilt = Math.max(-25, Math.min(25, state.tilt));
  ctx.save(); ctx.translate(width / 2, height / 2); ctx.rotate(tilt * Math.PI / 180);
  ctx.strokeStyle = state.level ? '#d9ff5a' : '#ffc56e'; ctx.lineWidth = state.level ? 2 : 1;
  ctx.beginPath(); ctx.moveTo(-width * .31, 0); ctx.lineTo(width * .31, 0); ctx.stroke();
  ctx.fillStyle = state.level ? '#d9ff5a' : '#ffc56e';
  ctx.fillRect(-3, -3, 6, 6); ctx.restore();

  const scale = Math.max(width / video.videoWidth, height / video.videoHeight);
  const offsetX = (width - video.videoWidth * scale) / 2;
  const offsetY = (height - video.videoHeight * scale) / 2;
  for (const subject of state.detections) {
    const box = subject.box;
    const x = box.originX * scale + offsetX;
    const y = box.originY * scale + offsetY;
    const w = box.width * scale;
    const h = box.height * scale;
    const selected = subject === state.best;
    ctx.strokeStyle = selected ? '#d9ff5a' : '#78e0d0bb';
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeRect(x, y, w, h);
    if (selected) {
      const name = localized(subject.category?.categoryName || 'объект');
      const badge = `${name.toUpperCase()} ${Math.round((subject.category?.score || 0) * 100)}%`;
      ctx.font = '600 9px monospace';
      const tw = ctx.measureText(badge).width + 12;
      ctx.fillStyle = '#d9ff5a'; ctx.fillRect(x, Math.max(0, y - 21), tw, 18);
      ctx.fillStyle = '#12191d'; ctx.fillText(badge, x + 6, Math.max(12, y - 9));
      const tx = subject.target.x * width;
      const ty = subject.target.y * height;
      ctx.fillStyle = '#d9ff5a'; ctx.beginPath(); ctx.arc(tx, ty, 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#12191d'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(tx, ty, 8, 0, Math.PI * 2); ctx.stroke();
    }
  }
  ctx.restore();
}

function localized(name) { return classRu[name] || name.replace(/_/g, ' '); }

function measureFrame() {
  const width = measureCanvas.width;
  const height = measureCanvas.height;
  const crop=visibleRect();
  measureContext.drawImage(video,crop.x,crop.y,crop.w,crop.h,0,0,width,height);
  const pixels = measureContext.getImageData(0, 0, width, height).data;
  let luminance = 0;
  let clipped = 0, blown=0;
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < pixels.length; i += 4, p++) {
    const light = .2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2];
    gray[p] = light;
    luminance += light;
    if (light < 13 || light > 247) clipped++;
    if(light>247)blown++;
  }
  let laplace = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 2) for (let x = 1; x < width - 1; x += 2) {
    const at = y * width + x;
    laplace += Math.abs(-4 * gray[at] + gray[at - 1] + gray[at + 1] + gray[at - width] + gray[at + width]);
    count++;
  }
  const average = luminance / (width * height);
  const sharpness = laplace / count;
  const clipping = clipped / (width * height);
  state.metrics = { average, sharpness, clipping, blown:blown/(width*height), time: Date.now() };
  updateQuality();
  if (state.autoExposure && !state.manualMode && state.caps.exposureCompensation && Date.now() - state.autoTimer > 1900) {
    const desired = state.metrics.blown>.08 ? -.5 : average<65 ? .5 : average>190 ? -.35 : 0;
    const settings = state.track?.getSettings?.() || {};
    if (Math.abs(Number(settings.exposureCompensation || 0) - desired) >= .3) applyExposure(desired, true);
  }
}

function updateQuality() {
  const metrics = state.metrics;
  if (!metrics) return;
  const { average, sharpness, clipping } = metrics;
  const fresh=liveScore && Date.now()-liveScore.time<Math.max(10000,aestheticModel.ms*4);
  const score=fresh?liveScore.mean:null;
  $('score-badge').querySelector('b').textContent=score===null?'—':score.toFixed(1);
  $('score-badge').querySelector('small').textContent='NIMA /10';
  $('score-badge').style.borderColor=score>=5.8?'#d9ff5a99':'#ffffff29';
  $('light-readout').textContent = average < 65 ? 'ТЕМНО' : average > 190 ? 'ЯРКО' : 'ХОРОШО';
  $('sharp-readout').textContent = sharpness < 5 ? 'СМАЗАНО?' : sharpness > 11 ? 'РЕЗКО' : 'СРЕДНЕ';
  const settings = state.track?.getSettings?.() || {};
  $('exposure-readout').textContent = settings.iso ? `ISO${Math.round(settings.iso)}` : 'АВТО';
  $('scene-note').classList.toggle('good', score >= 5.8);
}

function renderAdvice() {
  const metrics = state.metrics;
  const subject = state.best;
  const messages = [];
  if (metrics?.average < 65) messages.push('Темновато: найди свет или открой экспозицию');
  else if (metrics?.average > 190 || metrics?.blown > .08) messages.push('Светлые участки теряются — убавь экспозицию');
  if (metrics?.sharpness < 4.5) messages.push('Похоже на смаз — задержи телефон');
  if (state.levelAvailable && !state.level) messages.push('Поверни телефон, чтобы выровнять горизонт');
  if(liveScore && Date.now()-liveScore.time<10000 && liveScore.mean>=5.8)
    messages.push('Выразительный кадр по NIMA · задержи телефон и снимай');
  if (subject) {
    const name = localized(subject.category?.categoryName || 'объект');
    const confidence = Math.round((subject.category?.score || 0) * 100);
    if (subject.area < .012) messages.push(`${name} далеко — подойди ближе`);
    else if (subject.area > .58) messages.push(`${name} почти заполняет кадр — отступи`);
    else if (subject.framing < .55) {
      const pan = subject.target.x > subject.x ? 'чуть левее' : 'чуть правее';
      const tilt = subject.target.y > subject.y ? 'и чуть выше' : 'и чуть ниже';
      messages.push(`Помести ${name} на точку третей: сдвинь камеру ${pan} ${tilt}`);
    } else messages.push(`${name} найден · уверенность ${confidence}% · удачная точка третей`);
  } else if (state.detector && !messages.some((message) => message.includes('Темновато'))) {
    messages.push('Веди камерой — найду объект для композиции');
  }
  const message = messages[0] || 'Хороший свет. Ищи интересный передний план.';
  $('scene-message').textContent = message;
  $('scene-note').classList.toggle('good', Boolean(subject && subject.framing > .72 && metrics?.average > 65 && state.level));
}

function updateTilt(event) {
  if(event.gamma==null || event.beta==null)return;
  state.levelAvailable = true;
  const orientation = screen.orientation?.angle || 0;
  const raw = orientation === 90 ? -(event.beta || 0) : orientation === 270 ? (event.beta || 0) : (event.gamma || 0);
  state.tilt = Math.max(-45, Math.min(45, raw));
  state.level = Math.abs(state.tilt) < 1.3;
  if (state.level && !state.lastLevel) navigator.vibrate?.(25);
  state.lastLevel = state.level;
  $('level-number').textContent = `${Math.round(state.tilt)}°`;
  $('level-indicator').style.transform = `translateX(${Math.max(-13, Math.min(13, state.tilt * .7))}px)`;
  if (state.metrics) { updateQuality(); renderAdvice(); }
}

async function applyExposure(value, automatic = false) {
  if (!state.track || !state.caps.exposureCompensation) return;
  const range = state.caps.exposureCompensation;
  const target = Math.max(range.min ?? -2, Math.min(range.max ?? 2, Number(value)));
  try {
    await state.track.applyConstraints({ advanced: [{ exposureCompensation: target }] });
    state.autoTimer = Date.now();
    $('ev-control').value = target;
    $('ev-label').textContent = `${target > 0 ? '+' : ''}${target.toFixed(1)} EV`;
    refreshActualExposure();
  } catch (_) {
    if (automatic) state.autoTimer = Date.now();
    if (!automatic) toast('Камера отказалась менять экспозицию');
  }
}

function refreshActualExposure() {
  const settings = state.track?.getSettings?.() || {};
  $('iso-label').textContent = settings.iso ? `ISO ${Math.round(settings.iso)}` : 'АВТО';
  $('shutter-label').textContent = settings.exposureTime ? formatShutter(settings.exposureTime) : 'АВТО';
  $('ev-label').textContent = `${Number(settings.exposureCompensation || 0).toFixed(1)} EV`;
  if (state.metrics) updateQuality();
}

async function setCameraMode(manual) {
  if (!state.track) return;
  if (manual && !hasOption(state.caps.exposureMode, 'manual')) {
    toast('Ручной режим камера не поддерживает');
    return;
  }
  if (!manual) {
    state.manualMode = false;
    state.autoExposure = true;
    $('auto-mode').classList.add('selected'); $('manual-mode').classList.remove('selected');
    try {
      if (hasOption(state.caps.exposureMode, 'continuous')) await state.track.applyConstraints({ advanced: [{ exposureMode: 'continuous' }] });
      $('iso-control').disabled = true; $('shutter-control').disabled = true; $('ev-control').disabled = !state.caps.exposureCompensation;
      toast('Автоэкспозиция включена');
    } catch (_) { toast('Не удалось вернуть автоэкспозицию'); }
    return;
  }
  state.manualMode = true;
  state.autoExposure = false;
  $('manual-mode').classList.add('selected'); $('auto-mode').classList.remove('selected');
  const settings = state.track.getSettings?.() || {};
  const iso = settings.iso || Math.max(state.caps.iso.min, Math.min(state.caps.iso.max, 100));
  const exposureTime = settings.exposureTime || Math.max(state.caps.exposureTime.min, Math.min(state.caps.exposureTime.max, 1 / 125));
  try {
    await state.track.applyConstraints({ advanced: [{ exposureMode: 'manual', iso, exposureTime }] });
    $('iso-control').disabled = false; $('shutter-control').disabled = false; $('ev-control').disabled = true;
    $('iso-control').value = iso;
    $('shutter-control').value = secondsToSlider(exposureTime);
    refreshActualExposure();
    toast('Ручной режим применён камерой');
  } catch (_) {
    state.manualMode = false;
    $('manual-mode').classList.remove('selected'); $('auto-mode').classList.add('selected');
    toast('Телефон не применил ручные параметры');
  }
}

async function changeManualValue(kind, value) {
  if (!state.track || !state.manualMode) return;
  const update = kind === 'iso' ? { iso: Number(value) } : { exposureTime: sliderToSeconds(value) };
  try {
    await state.track.applyConstraints({ advanced: [update] });
    refreshActualExposure();
    if (kind === 'iso') $('iso-label').textContent = `ISO ${Math.round(Number(value))}`;
    else $('shutter-label').textContent = formatShutter(update.exposureTime);
  } catch (_) { toast('Не удалось применить параметр'); }
}

async function toggleTorch() {
  if (!state.track || !state.caps.torch) return;
  state.torchOn = !state.torchOn;
  try {
    await state.track.applyConstraints({ advanced: [{ torch: state.torchOn }] });
    $('torch-button').style.color = state.torchOn ? '#d9ff5a' : '';
  } catch (_) { state.torchOn = false; toast('Вспышка не поддерживается этой камерой'); }
}

async function capturePhoto() {
  if (!state.track || !video.videoWidth) return;
  const track=state.track, actual=track.getSettings?.() || {};
  $('capture-button').disabled = true;
  let blob;
  try {
    if ('ImageCapture' in window) {
      try { blob = await new ImageCapture(track).takePhoto(); } catch (_) { blob = null; }
    }
    if (!blob) {
      if(!video.videoWidth)throw new Error('Камера остановлена');
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', .96));
    }
    if (!blob) throw new Error('Снимок не получился');
    const entry = { id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`, blob, date: Date.now(), score: null, aesthetic:null, label: state.best ? localized(state.best.category?.categoryName || 'кадр') : 'кадр', iso: actual.iso || null, exposureTime: actual.exposureTime || null };
    await savePhoto(entry);
    state.photos.unshift(entry);
    updatePhotoCount();
    navigator.vibrate?.(35);
    toast('Снимок сохранён · оцениваю эстетику');
    scoreSaved(entry);
  } catch (error) { toast(error.message || 'Не удалось сохранить снимок'); }
  finally { $('capture-button').disabled = !state.track; }
}

function openDb() {
  if (!('indexedDB' in window)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open('photo-scout-roll', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('photos', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}
function dbRequest(mode, action) {
  return new Promise((resolve,reject)=>{
    if(!state.db)return reject(new Error('Хранилище браузера недоступно'));
    const transaction=state.db.transaction('photos',mode);
    let result;
    const request=action(transaction.objectStore('photos'));
    request.onsuccess=()=>{result=request.result;};
    transaction.oncomplete=()=>resolve(result);
    transaction.onerror=transaction.onabort=()=>reject(transaction.error || new Error('Не удалось сохранить фото'));
  });
}
async function savePhoto(entry) {state.db ||= await openDb();await dbRequest('readwrite',store=>store.put(entry));}
async function loadPhotos() {
  state.db ||= await openDb();
  state.photos = (await dbRequest('readonly', (store) => store.getAll())) || state.photos;
  state.photos.sort((a, b) => b.date - a.date);
  updatePhotoCount();
}
function updatePhotoCount() {
  $('photo-count').textContent = state.photos.length;
  $('nav-count').hidden = state.photos.length === 0;
}
function renderGallery() {
  const grid = $('gallery-grid');
  state.galleryUrls.forEach((url) => URL.revokeObjectURL(url));
  state.galleryUrls = [];
  grid.replaceChildren();
  $('empty-gallery').hidden = state.photos.length > 0;
  for (const photo of state.photos) {
    const button = document.createElement('button');
    button.className = 'photo-card';
    button.type = 'button';
    button.setAttribute('aria-label', `Открыть снимок ${photo.label}`);
    const image = document.createElement('img');
    image.src = URL.createObjectURL(photo.blob);
    state.galleryUrls.push(image.src);
    image.alt = photo.label;
    const score = document.createElement('span'); score.className = 'photo-score'; score.textContent = photo.aesthetic ? `NIMA ${photo.aesthetic.mean.toFixed(1)}/10` : 'NIMA —';
    const open = document.createElement('span'); open.className = 'photo-open'; open.textContent = '✳';
    button.append(image, score, open);
    button.addEventListener('click', () => { state.activePhoto = photo; state.activeImage = null; showPage('editor'); });
    grid.append(button);
  }
}

async function openEditor(photo) {
  state.activePhoto=photo;state.activeImage=photo.id;
  await editor.open(photo);
}

function bindControls() {
  $('start-camera').addEventListener('click', openCamera);
  $('capture-button').addEventListener('click', capturePhoto);
  $('lens-button').addEventListener('click', async () => {
    state.cameraFacing = state.cameraFacing === 'environment' ? 'user' : 'environment';
    await openCamera();
  });
  $('manual-button').addEventListener('click', () => $('control-sheet').showModal());
  $('close-sheet').addEventListener('click', () => $('control-sheet').close());
  $('sheet-done').addEventListener('click', () => $('control-sheet').close());
  $('auto-mode').addEventListener('click', () => setCameraMode(false));
  $('manual-mode').addEventListener('click', () => setCameraMode(true));
  $('ev-control').addEventListener('input', (event) => applyExposure(event.target.value));
  $('iso-control').addEventListener('input', (event) => changeManualValue('iso', event.target.value));
  $('shutter-control').addEventListener('input', (event) => changeManualValue('shutter', event.target.value));
  $('zoom-control').addEventListener('input', async (event) => {
    if (!state.track || !state.caps.zoom) return;
    $('zoom-label').textContent = `${Number(event.target.value).toFixed(1)}×`;
    try { await state.track.applyConstraints({ advanced: [{ zoom: Number(event.target.value) }] }); }
    catch (_) { toast('Зум не применился'); }
  });
  $('torch-button').addEventListener('click', toggleTorch);
  $('screen-toggle').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  });
  document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => showPage(button.dataset.page)));
  $('back-camera').addEventListener('click', () => showPage('camera'));
  $('close-editor').addEventListener('click', () => showPage('gallery'));
  $('save-best').addEventListener('click',saveBest);
  $('import-photo').addEventListener('click',()=>$('photo-file').click());
  $('photo-file').addEventListener('change',event=>importPhoto(event.target.files[0]));
  window.addEventListener('resize', () => { drawOverlay(); });
  window.addEventListener('pagehide', stopCamera);
}

bindControls();
loadPhotos().then(renderGallery).catch(()=>toast('Хранилище браузера недоступно'));

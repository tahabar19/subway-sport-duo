// Subway Sport Duo : caméra -> pose -> détecteur -> jeu, plus la liaison avec l'autre joueur.
import { Game } from './game.js?v=10';
import { loadAssets } from './assets.js?v=10';
import { MotionDetector, DEFAULTS } from './motion.js?v=10';
import { Net, newCode, cleanCode } from './net.js?v=10';
import { Voice, opusSupported } from './voice.js?v=10';
import { PoseLandmarker, FilesetResolver } from '../vendor/vision_bundle.mjs';

const $ = (id) => document.getElementById(id);
const video = $('video'), preview = $('preview'), pctx = preview.getContext('2d');
const now = () => performance.now() / 1000;
const load = (k, d) => {
  try {
    return JSON.parse(localStorage.getItem(k)) ?? d;
  } catch {
    return d;
  }
};
const store = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};

const HOLD_TO_START = 0.8; // secondes bras levés pour se déclarer prêt
const CALIB_TIME = 3;
const COUNTDOWN = 3;
const RUN_TIMEOUT = 1.1; // sans petit saut pendant ce temps, le personnage s'arrête
const CADENCE_NORMAL = 2.6, PACE_PER_HOP = 0.45, PACE_MIN = 0.5, PACE_MAX = 1.6;
const SEND_EVERY = 1 / 12; // état envoyé à l'adversaire 12 fois par seconde
const EMOJI = { garcon: '👦', fille: '👧' };
// Téléphone / tablette : pas de clavier, on joue au doigt (glisser) ou avec la caméra.
const TOUCH = matchMedia('(hover: none) and (pointer: coarse)').matches || navigator.maxTouchPoints > 0;

const detector = new MotionDetector({ ...DEFAULTS, ...load('subway-sport-cfg', {}) });
// Modèles 3D : si le chargement rate (réseau…), le jeu repart avec les anciens personnages en cubes.
let assets = null;
try {
  assets = await loadAssets('?v=10');
} catch (e) {
  console.warn('Modèles 3D non chargés, retour aux cubes :', e);
}
const game = new Game($('game'), assets);
game.shakeStrength = Math.max(0, Math.min(1, Number(load('subway-duo-shake', 1))));
const net = new Net();

// Moi et l'adversaire
const me = { name: '', char: 'garcon', mic: true, ...load('subway-duo-me', {}) };
let opp = null; // { name, char, mic, phase, st, final, alive }
const wins = { me: 0, opp: 0 };

let phase = 'loading'; // loading | lobby | ready | calib | waiting | countdown | play | over
let landmarker = null;
let camOk = false;
let camLoading = true; // modèle de pose en cours de chargement (~15 Mo la première fois sur téléphone)
let keyboard = false; // jeu au clavier : le personnage court tout seul
let lastVideoTime = -1;
let measure = null;
let landmarks = null;
let holdTime = 0;
let phaseStart = now();
let lastActivity = -10;
let lastHop = -10, cadence = CADENCE_NORMAL;
let calLast = { m: null, t: 0 }, calMoving = true;
let seed = 0;
let solo = false; // partie lancée sans adversaire
let lastSend = 0;
let resultCounted = false;
let isCreator = false; // celui qui a créé la partie choisit le nombre de cœurs
let lives = Math.max(1, Math.min(10, Number(load('subway-duo-lives', 3)) || 3));
let myFinal = 0; // mon score à l'élimination (le jeu rejoue ensuite la course de l'autre)
const clampLives = (n) => (Number.isFinite(Number(n)) ? Math.max(1, Math.min(10, Math.round(Number(n)))) : 3);

// ---- Sons
let audio = null;
const audioCtx = () => {
  audio ??= new AudioContext();
  // iPhone : après un appel ou la mise en veille, l'état peut être « interrupted » au lieu de « suspended ».
  if (audio.state !== 'running') audio.resume().catch(() => {});
  return audio;
};
function beep(freq, dur = 0.08, type = 'square', vol = 0.06) {
  try {
    const a = audioCtx();
    const o = a.createOscillator(), g = a.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
    o.connect(g).connect(a.destination);
    o.start();
    o.stop(a.currentTime + dur);
  } catch {}
}

function flash(text) {
  const el = $('action');
  el.textContent = text;
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
}

let toastTimer = 0;
function toast(text, secs = 2.6) {
  $('toast').textContent = text;
  $('toast').classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('on'), secs * 1000);
}

const oppName = () => opp?.name || 'Ton adversaire';
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14);

// ---- Voix : passe par le même relais que le jeu (voice.js)
let voice = null;
let opusOk = false;
opusSupported().then((ok) => (opusOk = ok));
async function applyMic() {
  voice ??= new Voice(audioCtx(), (msg) => net.connected && net.send(msg));
  try {
    await voice.setMic(me.mic);
  } catch {
    me.mic = false;
    voice.setMic(false);
    toast('Micro refusé ou introuvable');
  }
  $('micBtn').textContent = me.mic ? '🎤 Micro' : '🔇 Micro';
  $('micBtn').setAttribute('aria-label', me.mic ? 'Micro activé (toucher pour couper)' : 'Micro coupé (toucher pour activer)');
  $('micBtn').classList.toggle('live', me.mic);
  net.send({ t: 'mic', on: me.mic });
  store('subway-duo-me', { name: me.name, char: me.char, mic: me.mic });
}
function toggleMic() {
  me.mic = !me.mic;
  applyMic();
}
$('micBtn').addEventListener('click', toggleMic);

// ---- Liaison avec l'adversaire
net.onStatus = (s, detail) => {
  const room = $('room');
  room.classList.add('on');
  room.classList.toggle('ok', s === 'connecte');
  if (s === 'connecte') {
    $('roomText').textContent = `${net.code} · connecté`;
    sendHello();
  } else if (s === 'attente') {
    $('roomText').textContent = `${net.code} · en attente`;
  } else if (s === 'perdu') {
    $('roomText').textContent = `${net.code} · déconnecté`;
    if (opp) toast(`${oppName()} s'est déconnecté(e)`);
    opp = null;
    game.setGhost(null);
    game.ghostState = null;
  } else if (s === 'erreur') {
    $('roomText').textContent = `${net.code} · ${detail}`;
    if (phase === 'lobby') $('lobbyErr').textContent = detail;
  }
};

net.onMessage = (m) => {
  if (m.t === 'v') return void voice?.receive(m);
  if (m.t === 'hello') {
    // Opus si les deux navigateurs savent le faire, sinon son de téléphone.
    voice?.setOpus(opusOk && m.op === true);
    const fresh = !opp;
    opp = { phase: 'ready', st: null, final: null, alive: true, ...opp };
    opp.name = cleanName(m.name) || 'Adversaire';
    opp.char = m.char === 'fille' ? 'fille' : 'garcon';
    opp.mic = !!m.mic;
    opp.phase = String(m.phase || 'ready');
    game.setGhost(opp.char);
    if (fresh) {
      toast(`${EMOJI[opp.char]} ${opp.name} est là !`);
      beep(660, 0.12, 'triangle', 0.08);
    }
    if (m.cr === true && !isCreator) setLives(m.lives, false);
    // On répond si l'autre n'a pas encore notre fiche.
    if (fresh || !m.have) sendHello();
    return;
  }
  if (!opp) return;
  if (m.t === 'phase') {
    opp.phase = String(m.phase);
    if (m.phase === 'waiting' && phase !== 'play') toast(`${oppName()} est prêt(e) ✅`);
  } else if (m.t === 'mic') opp.mic = !!m.on;
  else if (m.t === 'lives' && !isCreator) setLives(m.n, false);
  else if (m.t === 'st') {
    const n = (v) => (Number.isFinite(v) ? v : 0);
    opp.st = {
      lane: Math.max(-1, Math.min(1, Math.round(n(m.lane)))),
      py: Math.max(0, Math.min(4, n(m.py))),
      roll: !!m.roll, run: Math.max(0, Math.min(2, n(m.run))), speed: n(m.speed),
      dist: n(m.dist), score: Math.max(0, Math.round(n(m.score))), lives: Math.max(0, Math.min(10, n(m.lives))),
      alive: !!m.alive, hurt: !!m.hurt,
    };
    opp.stAt = now();
  } else if (m.t === 'hit') {
    toast(`💥 ${oppName()} ${m.what === 'train' ? "s'est pris un train" : "s'est cogné(e)"} !`);
    if (phase === 'watch') (game.addTrauma(m.what === 'train' ? 0.7 : 0.45), beep(110, 0.3, 'sawtooth', 0.06));
  } else if (m.t === 'over') {
    const wasOver = opp.final !== null;
    opp.final = Math.max(0, Math.round(Number(m.score) || 0));
    opp.alive = false;
    if (phase === 'play' && !wasOver) toast(`☠️ ${oppName()} est éliminé(e) avec ${opp.final} — dépasse ce score !`, 4);
  } else if (m.t === 'start' && !net.isHost) {
    // L'hôte donne le départ, avec la graine du parcours commun.
    if (phase === 'waiting' || phase === 'over' || phase === 'ready') {
      if (m.lives) setLives(m.lives, false);
      startCountdown(Number(m.seed) >>> 0);
    }
  }
};

function sendHello() {
  net.send({ t: 'hello', name: me.name, char: me.char, mic: me.mic, phase, have: !!opp, op: opusOk, cr: isCreator, lives });
}

// Nombre de cœurs : réglé par le créateur de la partie, le même pour les deux.
function setLives(n, mine = true) {
  lives = clampLives(n);
  if (mine) {
    store('subway-duo-lives', lives);
    net.send({ t: 'lives', n: lives });
  }
  renderLives();
}
function renderLives() {
  $('livesVal').textContent = lives;
  $('livesLobbyVal').textContent = lives;
  $('livesRow').classList.toggle('mine', isCreator);
  $('livesWho').textContent = isCreator || !opp ? '' : ` (choisi par ${opp.name})`;
}
for (const [id, d] of [['livesMinus', -1], ['livesPlus', 1], ['livesLobbyMinus', -1], ['livesLobbyPlus', 1]])
  $(id).addEventListener('click', () => (isCreator || phase === 'lobby') && setLives(lives + d));

function sendPhase() {
  net.send({ t: 'phase', phase });
}

// ---- Phases
function setPhase(p) {
  phase = p;
  phaseStart = now();
  holdTime = 0;
  $('lobby').classList.toggle('hidden', p !== 'lobby' && p !== 'loading');
  $('tools').classList.toggle('cache', p === 'lobby' || p === 'loading');
  $('panel').classList.toggle('hidden', p === 'play' || p === 'watch' || p === 'lobby' || p === 'loading');
  $('livesRow').style.display = p === 'ready' || p === 'waiting' || p === 'over' ? '' : 'none';
  $('watch').classList.toggle('on', p === 'watch');
  $('moves').style.display = p === 'ready' || p === 'calib' ? '' : 'none';
  $('msg').classList.toggle('big', p === 'countdown');
  if (p === 'calib') detector.startCalibration();
  if (p === 'play') {
    lastActivity = now();
    cadence = CADENCE_NORMAL;
    resultCounted = false;
    if (opp) {
      opp.final = null;
      opp.alive = true;
      opp.st = null;
    }
    game.setCharacter(me.char);
    game.start(seed, lives);
    beep(880, 0.2, 'triangle', 0.08);
  }
  if (p === 'watch') game.watchStart(seed, opp.char); // on suit l'adversaire sur le même parcours
  renderLives();
  sendPhase();
}

function startCountdown(s) {
  seed = s;
  solo = !opp || !net.connected;
  setPhase('countdown');
}

function ready() {
  // Une fois calibré (ou au clavier) : on attend l'autre joueur.
  setPhase('waiting');
}

// ---- Accueil
function pick(groupId, attr, value) {
  for (const b of $(groupId).querySelectorAll('.choice')) b.setAttribute('aria-pressed', String(b.dataset[attr] === value));
}
$('name').value = me.name;
pick('charChoice', 'char', me.char);
pick('micChoice', 'mic', me.mic ? '1' : '0');
$('charChoice').addEventListener('click', (e) => {
  const b = e.target.closest('.choice');
  if (!b) return;
  me.char = b.dataset.char;
  pick('charChoice', 'char', me.char);
  game.setCharacter(me.char);
});
$('micChoice').addEventListener('click', (e) => {
  const b = e.target.closest('.choice');
  if (!b) return;
  me.mic = b.dataset.mic === '1';
  pick('micChoice', 'mic', b.dataset.mic);
});
const params = new URLSearchParams(location.search);
const linkCode = cleanCode(params.get('salle'));
if (linkCode) {
  $('hostOrJoin').style.display = 'none';
  $('joinOnly').style.display = 'block';
  $('joinBtn').textContent = `Rejoindre la partie ${linkCode}`;
}
game.setCharacter(me.char);

$('lobbyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const act = e.submitter?.dataset.act || (linkCode ? 'join' : 'host');
  me.name = cleanName($('name').value);
  if (!me.name) return void ($('lobbyErr').textContent = 'Écris ton prénom');
  const code = linkCode || (act === 'join' ? cleanCode($('code').value) : newCode());
  if (act === 'join' && code.length < 4) return void ($('lobbyErr').textContent = 'Code de partie incomplet');
  $('lobbyErr').textContent = '';
  audioCtx(); // débloque le son (il faut un clic)
  await applyMic();
  isCreator = act === 'host' && !linkCode;
  if (isCreator) net.host(code);
  else net.join(code);
  const link = location.origin + location.pathname + '?salle=' + code;
  history.replaceState(null, '', link);
  renderShare(code, link);
  keepAwake();
  $('micBtn').classList.add('on');
  $('opp').classList.add('on');
  setPhase('ready');
});

// Code de la partie, en gros, et bouton pour l'envoyer (feuille de partage de l'iPhone : Messages, WhatsApp…).
function renderShare(code, link) {
  const box = $('share');
  box.innerHTML = '';
  const label = document.createElement('span');
  label.textContent = 'Code à donner à ton adversaire';
  const big = document.createElement('span');
  big.className = 'code';
  big.textContent = code;
  const send = document.createElement('button');
  send.type = 'button';
  send.className = 'btn alt';
  send.textContent = navigator.share ? '📤 Envoyer le lien' : '📋 Copier le lien';
  send.onclick = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Subway Duo', text: `Viens jouer à Subway Duo avec moi ! Code : ${code}`, url: link });
      } catch {}
    } else {
      navigator.clipboard?.writeText(link).then(() => (send.textContent = 'Lien copié ✓'));
    }
  };
  const small = document.createElement('span');
  small.className = 'link';
  small.textContent = link;
  box.append(label, big, send, small);
}

// ---- Écran allumé pendant la partie (on joue loin du téléphone, sans le toucher)
let wakeLock = null;
async function keepAwake() {
  if (wakeLock || document.visibilityState !== 'visible' || !navigator.wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => (wakeLock = null));
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // Retour dans l'appli (iPhone : après la veille ou un changement d'appli) : on relance tout.
  if (phase !== 'lobby' && phase !== 'loading') keepAwake();
  if (video.srcObject && video.paused) video.play().catch(() => {});
  if (audio && audio.state !== 'running') audio.resume().catch(() => {});
});

// ---- Caméra et modèle de pose
async function initCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    preview.width = 320;
    preview.height = Math.round((320 * video.videoHeight) / video.videoWidth);
    const files = await FilesetResolver.forVisionTasks('vendor/wasm');
    const create = (delegate) =>
      PoseLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: 'vendor/pose_landmarker_lite.task', delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
      });
    try {
      landmarker = await create('GPU');
    } catch {
      landmarker = await create('CPU');
    }
    camOk = true;
  } catch (err) {
    console.error(err);
    $('cam').style.display = 'none';
    $('camBtn').style.display = 'none';
  }
  camLoading = false;
}

function trackPose(t) {
  if (!camOk || video.readyState < 2 || video.currentTime === lastVideoTime) return false;
  lastVideoTime = video.currentTime;
  const res = landmarker.detectForVideo(video, performance.now());
  landmarks = res.landmarks?.[0] ?? null;
  measure = detector.measure(landmarks, video.videoWidth / video.videoHeight);
  if (phase === 'play' && !keyboard) {
    for (const e of detector.update(measure, t)) {
      lastActivity = t;
      if (e.type === 'hop') {
        const gap = t - lastHop;
        if (gap > 0.2 && gap < 1) cadence += (1 / gap - cadence) * 0.3;
        lastHop = t;
      }
      if (e.type === 'jump') (game.jump(), flash('SAUT !'));
      else if (e.type === 'down') (game.roll(), flash('ROULADE !'));
      else if (e.type === 'lane') game.setLane(e.lane);
    }
  }
  return true;
}

const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
function drawPreview() {
  const W = preview.width, H = preview.height, aspect = W / H;
  pctx.save();
  pctx.scale(-1, 1);
  pctx.drawImage(video, -W, 0, W, H);
  pctx.restore();
  const px = (X) => (X / aspect) * W;
  if (detector.calibrated) {
    const { baseX, baseY, torso, cfg, lane } = detector;
    const l = px(baseX - cfg.lane * torso), r = px(baseX + cfg.lane * torso);
    pctx.fillStyle = 'rgba(255,210,31,.22)';
    if (lane === -1) pctx.fillRect(0, 0, l, H);
    else if (lane === 1) pctx.fillRect(r, 0, W - r, H);
    else pctx.fillRect(l, 0, r - l, H);
    pctx.strokeStyle = 'rgba(255,255,255,.85)';
    pctx.lineWidth = 1.5;
    pctx.beginPath();
    pctx.moveTo(l, 0), pctx.lineTo(l, H), pctx.moveTo(r, 0), pctx.lineTo(r, H);
    pctx.stroke();
    pctx.setLineDash([5, 4]);
    pctx.strokeStyle = 'rgba(255,255,255,.6)';
    pctx.beginPath(), pctx.moveTo(0, baseY * H), pctx.lineTo(W, baseY * H), pctx.stroke();
    pctx.strokeStyle = '#ff5a36';
    const jy = (baseY - cfg.jump * torso) * H;
    pctx.beginPath(), pctx.moveTo(0, jy), pctx.lineTo(W, jy), pctx.stroke();
    pctx.setLineDash([]);
  }
  if (landmarks) {
    pctx.strokeStyle = measure ? '#3dffa2' : '#ff8a5c';
    pctx.lineWidth = 2.5;
    pctx.beginPath();
    for (const [a, b] of BONES) {
      pctx.moveTo((1 - landmarks[a].x) * W, landmarks[a].y * H);
      pctx.lineTo((1 - landmarks[b].x) * W, landmarks[b].y * H);
    }
    pctx.stroke();
  }
  $('camState').textContent = measure ? '' : 'Corps non visible';
}

// ---- Écrans
const oppScoreNow = () => opp?.final ?? opp?.st?.score ?? 0;
const oppAlive = () => !!opp && opp.alive && opp.phase === 'play';

function resultText() {
  const a = myFinal, b = oppScoreNow();
  if (!opp || solo) return `Score ${a} · record ${game.best}`;
  if (oppAlive()) return `Éliminé(e) avec ${a}.\n${EMOJI[opp.char]} ${opp.name} court encore : ${b}…`;
  if (!resultCounted) {
    resultCounted = true;
    if (a > b) wins.me++;
    else if (b > a) wins.opp++;
    beep(a >= b ? 990 : 330, 0.35, 'triangle', 0.09);
  }
  const head = a > b ? `🏆 Tu gagnes ${a} à ${b} !` : b > a ? `${opp.name} gagne ${b} à ${a}` : `Égalité ${a} partout !`;
  return `${head}\nVictoires : toi ${wins.me} – ${wins.opp} ${opp.name}`;
}

// Boutons sous le message : ce que fait la touche Entrée au clavier, au doigt sur téléphone.
let actsKey = '';
function renderActs() {
  const list = [];
  const canRestart = phase === 'ready' || (phase === 'over' && !oppAlive());
  if (canRestart) list.push(['touch', TOUCH ? '📱 ' + (phase === 'over' ? 'Rejouer' : 'Jouer') + ' au doigt' : '⌨️ Jouer au clavier', '']);
  if (phase === 'waiting' && (!opp || !net.connected)) list.push(['solo', '🏃 Jouer seul en attendant', 'alt']);
  const key = list.map((a) => a[0] + a[1]).join('|');
  if (key === actsKey) return;
  actsKey = key;
  $('acts').replaceChildren(
    ...list.map(([act, text, cls]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ' + cls;
      b.dataset.act = act;
      b.textContent = text;
      return b;
    }),
  );
}
$('acts').addEventListener('click', (e) => {
  const act = e.target.closest('button')?.dataset.act;
  audioCtx();
  keepAwake();
  if (act === 'touch' && (phase === 'ready' || (phase === 'over' && !oppAlive()))) {
    keyboard = true;
    ready();
  } else if (act === 'solo' && phase === 'waiting' && (!opp || !net.connected)) startCountdown((Math.random() * 2 ** 32) >>> 0);
});

function updatePanel(dt, t) {
  renderActs();
  const msg = $('msg'), bar = $('bar').firstElementChild;
  const handsUp = MotionDetector.handsUp(measure);
  if (phase === 'ready' || phase === 'over') {
    const canStart = camOk && t - phaseStart > (phase === 'over' ? 2 : 0) && !(phase === 'over' && oppAlive());
    holdTime = canStart && handsUp ? holdTime + dt : 0;
    bar.style.width = Math.min(100, (holdTime / HOLD_TO_START) * 100) + '%';
    const how = !camOk
      ? camLoading
        ? 'Chargement de la caméra…'
        : TOUCH
          ? 'Pas de caméra : joue au doigt 👇'
          : 'Pas de caméra : appuie sur Entrée pour jouer au clavier.'
      : measure
        ? `Lève les deux bras pour ${phase === 'over' ? 'la revanche' : 'te mettre prêt(e)'} 🙌`
        : TOUCH
          ? 'Pose le téléphone debout et recule à 2–3 m :\non doit te voir en entier, de la tête aux pieds.'
          : 'Recule à 2–3 m de la caméra :\non doit te voir en entier, de la tête aux pieds.';
    if (phase === 'over') msg.textContent = oppAlive() ? resultText() : `${resultText()}\n${how}`;
    else msg.textContent = how;
    if (holdTime >= HOLD_TO_START) setPhase('calib');
  } else if (phase === 'calib') {
    if (measure !== calLast.m) {
      calMoving = MotionDetector.moving(calLast.m, measure, t - calLast.t);
      calLast = { m: measure, t };
    }
    if (!measure || handsUp || calMoving) phaseStart = t;
    const el = t - phaseStart;
    if (el < 0.05) detector.startCalibration();
    if (el > CALIB_TIME - 1.5) detector.addCalibrationSample(measure);
    bar.style.width = Math.min(100, (el / CALIB_TIME) * 100) + '%';
    msg.textContent = handsUp
      ? 'Baisse les bras, reste debout au centre…'
      : el < 0.3
        ? 'Mets-toi à ta place de jeu,\npuis ne bouge plus, bras le long du corps…'
        : `Ne bouge plus, bras le long du corps…\n${Math.max(1, Math.ceil(CALIB_TIME - el))}`;
    if (el >= CALIB_TIME) {
      if (detector.finishCalibration()) {
        keyboard = false;
        ready();
      } else phaseStart = t;
    }
  } else if (phase === 'waiting') {
    bar.style.width = '0%';
    if (!opp || !net.connected)
      msg.textContent = `Prêt(e) ✅\nEn attente de ton adversaire…${TOUCH ? '' : '\n(Entrée = jouer seul en attendant)'}`;
    else if (opp.phase === 'play') msg.textContent = `Prêt(e) ✅\n${opp.name} finit sa partie : ${oppScoreNow()}…`;
    else if (opp.phase !== 'waiting') msg.textContent = `Prêt(e) ✅\nEn attente de ${opp.name}…`;
    else msg.textContent = 'Départ…';
    // L'hôte donne le départ quand les deux sont prêts.
    if (net.isHost && opp && net.connected && opp.phase === 'waiting') {
      const s = (Math.random() * 2 ** 32) >>> 0;
      net.send({ t: 'start', seed: s, lives });
      startCountdown(s);
    }
  } else if (phase === 'watch') {
    // Spectateur jusqu'à l'élimination de l'adversaire (ou sa déconnexion).
    if (!oppAlive()) setPhase('over');
  } else if (phase === 'countdown') {
    const left = COUNTDOWN - (t - phaseStart);
    const n = Math.ceil(left);
    if (msg.textContent !== String(n) && n > 0) beep(n === 1 ? 660 : 440, 0.12, 'triangle', 0.08);
    msg.textContent = n > 0 ? String(n) : 'GO !';
    bar.style.width = Math.min(100, ((t - phaseStart) / COUNTDOWN) * 100) + '%';
    if (left <= 0) setPhase('play');
  }
}

function updateHud(t) {
  $('meWho').textContent = `${EMOJI[me.char]} ${me.name || 'Moi'}`;
  const done = phase === 'watch' || phase === 'over';
  $('score').textContent = done ? myFinal : game.score;
  $('sub').textContent = done ? `record ${game.best}` : `🪙 ${game.coinCount} · record ${Math.max(game.best, game.score)}`;
  $('speed').textContent = done ? '☠️ éliminé(e)' : `⚡ ${Math.round(game.speed * 3.6)} km/h`;
  const a = game.run;
  $('speed').style.color = done || a < 0.75 ? '#ffffff' : a < 0.95 ? '#4be37a' : a < 1.2 ? '#ff9f1a' : '#ff3b30';
  $('lives').textContent = done ? '' : '❤'.repeat(Math.max(0, game.lives));
  if (phase === 'watch' && opp) $('watchText').textContent = `👀 Tu regardes ${opp.name} · ${oppScoreNow()} — toi : ${myFinal}`;
  const stopped = phase === 'play' && !keyboard && t - lastActivity > RUN_TIMEOUT;
  $('hint').textContent = measure ? 'Sautille pour avancer !' : TOUCH ? 'Je ne te vois plus — reviens dans le cadre (ou glisse du doigt)' : 'Je ne te vois plus — reviens dans le cadre';
  $('hint').classList.toggle('on', stopped);

  $('share').classList.toggle('on', (phase === 'ready' || phase === 'waiting') && !opp && !!net.code);

  // Adversaire, à droite
  const box = $('opp');
  if (!opp) {
    $('oppWho').textContent = '… adversaire';
    $('oppScore').textContent = '—';
    $('oppLives').textContent = '';
    $('oppState').textContent = net.connected ? 'Connexion…' : 'Pas encore là';
    $('oppGap').textContent = '';
    box.classList.remove('out');
  } else {
    $('oppWho').textContent = `${voice?.remoteTalking ? '🗣️ ' : opp.mic ? '🎤 ' : '🔇 '}${opp.name} ${EMOJI[opp.char]}`;
    $('micBtn').classList.toggle('talk', !!voice?.talking);
    $('oppScore').textContent = oppScoreNow();
    $('oppLives').textContent = '❤'.repeat(opp.final !== null ? 0 : (opp.st?.lives ?? lives));
    $('oppState').textContent =
      { ready: 'Se prépare', calib: 'Calibrage…', waiting: 'Prêt(e) ✅', countdown: 'Départ…', play: 'En course 🏃', over: 'Éliminé(e)', lobby: 'Accueil' }[opp.phase] || '';
    box.classList.toggle('out', opp.final !== null && phase === 'play');
    let gap = '';
    if (phase === 'play' && opp.phase === 'play' && opp.st && !solo) {
      const d = Math.round(opp.st.dist - game.distance);
      gap = d > 2 ? `devant de ${d} m` : d < -2 ? `derrière de ${-d} m` : 'côte à côte';
    } else if (phase === 'play' && opp.final !== null && !solo) {
      const d = opp.final - game.score;
      gap = d > 0 ? `encore ${d} pts pour gagner` : 'tu mènes ! 🔥';
    }
    $('oppGap').textContent = gap;
  }

  // Fantôme : visible pendant la course, à sa voie, avec son prénom au-dessus.
  const showGhost = phase === 'play' && !solo && opp?.st && opp.phase === 'play';
  game.ghostState = showGhost ? { ...opp.st, gap: opp.st.dist - game.distance } : null;
  const tag = $('ghostTag'), pos = showGhost ? game.ghostLabelPos() : null;
  tag.style.display = pos ? 'block' : 'none';
  if (pos) {
    tag.textContent = `${EMOJI[opp.char]} ${opp.name}`;
    tag.style.left = pos.x + 'px';
    tag.style.top = pos.y + 'px';
  }
}

// État envoyé à l'adversaire
let lastSlow = 0;
function sendState(t) {
  if (!net.connected) return;
  // Une fois par seconde, on répète ce qu'un message perdu ne doit pas bloquer.
  if (t - lastSlow > 1) {
    lastSlow = t;
    if (!opp) sendHello();
    sendPhase();
    if (phase === 'over' || phase === 'watch') net.send({ t: 'over', score: myFinal });
    if (phase === 'countdown' && net.isHost && t - phaseStart < 1.2) net.send({ t: 'start', seed, lives });
    if (isCreator && (phase === 'ready' || phase === 'waiting' || phase === 'over')) net.send({ t: 'lives', n: lives });
  }
  if (t - lastSend < SEND_EVERY) return;
  lastSend = t;
  if (phase !== 'play') return;
  net.send({
    t: 'st', lane: game.lane, py: Math.round(game.py * 100) / 100, roll: game.rollLeft > 0,
    run: Math.round(game.run * 100) / 100, speed: Math.round(game.speed * 10) / 10,
    dist: Math.round(game.distance * 10) / 10, score: game.score, lives: game.lives,
    alive: game.state === 'play', hurt: game.invincible > 0,
  });
}

game.onEvent = (e, info) => {
  if (e === 'coin') beep(1320 * 2 ** (Math.min(info, 7) / 12), 0.07, 'triangle'); // série : un demi-ton de plus par pièce
  else if (e === 'jump') beep(520, 0.12, 'sine', 0.08);
  else if (e === 'roll') beep(260, 0.12, 'sine', 0.08);
  else if (e === 'daytime') {
    toast({ 'après-midi': "☀️ L'après-midi", 'coucher de soleil': '🌇 Le soleil se couche', nuit: '🌙 La nuit tombe' }[info] || info);
  } else if (e === 'quality') {
    const names = ['très basse', 'basse', 'moyenne', 'haute'];
    toast(`🖥️ Graphismes réglés sur « ${names[info]} » pour rester fluide`);
  } else if (e === 'hit') (beep(110, 0.3, 'sawtooth', 0.1), net.send({ t: 'hit', what: info }));
  else if (e === 'over') {
    myFinal = game.score;
    net.send({ t: 'over', score: myFinal });
    // L'adversaire court encore : on le regarde jouer. Sinon, résultat.
    setPhase(!solo && oppAlive() && opp.st ? 'watch' : 'over');
  }
};

// ---- Clavier
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const k = e.key;
  if (k === 'Enter' && (phase === 'ready' || (phase === 'over' && !oppAlive()))) {
    // Corps visible : on calibre comme avec les bras levés ; sinon, partie au clavier.
    if (camOk && measure) return setPhase('calib');
    keyboard = true;
    return ready();
  }
  if (k === 'Enter' && phase === 'waiting' && (!opp || !net.connected)) return startCountdown((Math.random() * 2 ** 32) >>> 0);
  if ((k === 'm' || k === 'M') && phase !== 'lobby') return toggleMic();
  if (k === 'r' || k === 'R') return toggleSettings();
  if (k === 'v' || k === 'V') return toggleCam();
  if (k === 'Escape') return toggleSettings(false);
  if (phase !== 'play') return;
  const moves = {
    ArrowLeft: () => game.moveLane(-1),
    ArrowRight: () => game.moveLane(1),
    ArrowUp: () => game.jump(),
    ' ': () => game.jump(),
    ArrowDown: () => game.roll(),
  };
  if (moves[k]) {
    e.preventDefault();
    keyboard = true;
    moves[k]();
  }
});

// ---- Au doigt : glisser à gauche / à droite = voie, vers le haut = saut, vers le bas = roulade.
// Le geste part dès que le doigt a bougé de quelques millimètres, sans attendre qu'il se lève.
let swipe = null;
const SWIPE_MIN = 22; // pixels
addEventListener(
  'touchstart',
  (e) => {
    swipe = null;
    if (phase !== 'play' || e.touches.length !== 1 || e.target.closest?.('button, input, select, #settings')) return;
    swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY, done: false };
  },
  { passive: true },
);
addEventListener(
  'touchmove',
  (e) => {
    if (!swipe || swipe.done || phase !== 'play') return;
    const dx = e.touches[0].clientX - swipe.x, dy = e.touches[0].clientY - swipe.y;
    if (Math.hypot(dx, dy) < SWIPE_MIN) return;
    swipe.done = true;
    keyboard = true; // le personnage court tout seul
    if (Math.abs(dx) > Math.abs(dy)) game.moveLane(dx > 0 ? 1 : -1);
    else if (dy < 0) game.jump();
    else game.roll();
  },
  { passive: true },
);
addEventListener('touchend', () => (swipe = null), { passive: true });
// iPhone : pas de zoom par pincement ni double toucher dans le jeu.
for (const ev of ['gesturestart', 'gesturechange', 'dblclick']) document.addEventListener(ev, (e) => e.preventDefault());

// ---- Boutons micro, caméra, réglages
function toggleSettings(on = !$('settings').classList.contains('on')) {
  $('settings').classList.toggle('on', on);
}
function toggleCam() {
  $('cam').style.display = $('cam').style.display ? '' : 'none';
}
$('setBtn').addEventListener('click', () => toggleSettings());
$('setClose').addEventListener('click', () => toggleSettings(false));
$('settings').addEventListener('click', (e) => e.target === $('settings') && toggleSettings(false));
$('camBtn').addEventListener('click', toggleCam);
$('micBtn').textContent = me.mic ? '🎤 Micro' : '🔇 Micro';

// ---- Réglages
for (const input of document.querySelectorAll('#settings [data-k]')) {
  const k = input.dataset.k;
  const show = () => input.nextElementSibling && (input.nextElementSibling.textContent = input.value);
  input.value = detector.cfg[k];
  show();
  input.addEventListener('input', () => {
    detector.cfg[k] = input.type === 'range' ? Number(input.value) : input.value;
    show();
    store('subway-sport-cfg', detector.cfg);
  });
}

// Tremblement de l'écran au choc : 0 = coupé (si ça donne mal au cœur).
{
  const input = $('shake');
  const show = () => (input.nextElementSibling.textContent = Math.round(input.value * 100) + ' %');
  input.value = game.shakeStrength;
  show();
  input.addEventListener('input', () => {
    game.shakeStrength = Number(input.value);
    show();
    store('subway-duo-shake', game.shakeStrength);
  });
}
// Graphismes : « auto » s'adapte à l'ordinateur de chaque joueur (le jeu est en ligne).
{
  const sel = $('quality');
  const apply = (v) => (v === 'auto' ? game.setQuality(3, true) : game.setQuality(Number(v)));
  sel.value = load('subway-duo-quality', 'auto');
  if (![...sel.options].some((o) => o.value === sel.value)) sel.value = 'auto';
  apply(sel.value);
  sel.addEventListener('change', () => (apply(sel.value), store('subway-duo-quality', sel.value)));
}

// ---- Boucle principale
let last = now();
function frame() {
  const t = now(), dt = Math.min(t - last, 0.05);
  last = t;
  if (trackPose(t)) drawPreview();
  if (phase !== 'play') updatePanel(dt, t);
  game.setRunning(phase === 'play' && (keyboard || t - lastActivity < RUN_TIMEOUT));
  game.setPace(keyboard ? 1 : Math.min(PACE_MAX, Math.max(PACE_MIN, 1 + PACE_PER_HOP * (cadence - CADENCE_NORMAL))));
  if (phase === 'watch' && opp?.st) {
    // L'état arrive 12×/s : on prévoit la distance entre deux messages.
    const ahead = Math.min(0.3, t - (opp.stAt || t)) * opp.st.speed;
    game.watchTo({ ...opp.st, dist: opp.st.dist + ahead }, dt);
  }
  game.update(dt);
  updateHud(t);
  sendState(t);
  requestAnimationFrame(frame);
}

window.duo = { game, net, get phase() { return phase; }, get voice() { return voice; } }; // pour le débogage dans la console
setPhase('lobby');
// ?sanscamera : pour tester à deux sur un même PC, au clavier.
if (!params.has('sanscamera')) initCamera();
else {
  $('cam').style.display = 'none';
  $('camBtn').style.display = 'none';
  camLoading = false;
}
// Appli hors ligne et démarrage rapide : les gros fichiers (modèle de pose, 3D) restent sur le téléphone.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost'))
  navigator.serviceWorker.register('sw.js').catch(() => {});
frame();

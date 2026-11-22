// Subway Sport Duo : caméra -> pose -> détecteur -> jeu, plus la liaison avec l'autre joueur.
import { Game } from './game.js?v=17';
import { loadAssets } from './assets.js?v=17';
import { MotionDetector, DEFAULTS } from './motion.js?v=17';
import { Net, newCode, cleanCode, MAX_PLAYERS } from './net.js?v=17';
import { Voice, opusSupported } from './voice.js?v=17';
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
const AVA = (c) => `icones/perso-${c === 'fille' ? 'fille' : 'garcon'}.png?v=17`; // portraits des personnages
const ic = (n, cls = '') => `<svg class="ic ${cls}"><use href="#i-${n}"/></svg>`;
// Change le contenu d'un élément seulement s'il a changé (le HUD est mis à jour à chaque image).
const setText = (el, v) => el.textContent !== String(v) && (el.textContent = v);
const setHTML = (el, v) => el._h !== v && ((el._h = v), (el.innerHTML = v));
const hearts = (n) => ic('coeur', 'plein-coeur').repeat(Math.max(0, n));
// Téléphone / tablette : pas de clavier, on joue au doigt (glisser) ou avec la caméra.
const TOUCH = matchMedia('(hover: none) and (pointer: coarse)').matches || navigator.maxTouchPoints > 0;

const detector = new MotionDetector({ ...DEFAULTS, ...load('subway-sport-cfg', {}) });
// Modèles 3D : si le chargement rate (réseau…), le jeu repart avec les anciens personnages en cubes.
let assets = null;
try {
  assets = await loadAssets('?v=17');
} catch (e) {
  console.warn('Modèles 3D non chargés, retour aux cubes :', e);
}
const game = new Game($('game'), assets);
game.shakeStrength = Math.max(0, Math.min(1, Number(load('subway-duo-shake', 1))));
const net = new Net();

// Moi et l'adversaire
const me = { name: '', char: 'garcon', mic: true, ...load('subway-duo-me', {}) };
// Les autres joueurs de la partie (jusqu'à 5) : id -> { id, name, char, mic, op, phase, st, stAt, final, alive, inRound }
const opps = new Map();
const wins = new Map(); // id (ou 'me') -> manches gagnées
let creatorId = null; // joueur qui a créé la partie (c'est lui qui choisit les cœurs)
let watchId = null; // joueur qu'on regarde après avoir été éliminé
let resumeAt = 0, resumeShown = 0; // reprise après une pause (3, 2, 1)

let phase = 'loading'; // loading | lobby | ready | calib | waiting | countdown | play | over
let landmarker = null;
let camOk = false;
let camLoading = true; // modèle de pose en cours de chargement (~15 Mo la première fois sur téléphone)
let noCamera = false; // ?sanscamera (essais au clavier) : pas de bouton caméra
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
let soloMode = false; // « Jouer seul » depuis l'accueil : pas de partie à créer, pas de réseau
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

const others = () => [...opps.values()];
const racers = () => others().filter((o) => o.inRound); // ceux qui courent la même manche que moi
const scoreOf = (o) => o.final ?? o.st?.score ?? 0;
const isAlive = (o) => o.inRound && o.alive && o.phase === 'play';
const aliveRacers = () => racers().filter(isAlive);
const anyAlive = () => aliveRacers().length > 0;
// « Léa », « Léa et Sam », « Léa, Sam et Noé »
const names = (list) => {
  const n = list.map((o) => o.name);
  return n.length < 2 ? n.join('') : n.slice(0, -1).join(', ') + ' et ' + n.at(-1);
};
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
  for (const b of [$('micBtn'), $('micBtn2')]) {
    setHTML(b, ic(me.mic ? 'mic' : 'mic-off'));
    b.setAttribute('aria-label', me.mic ? 'Micro activé (toucher pour couper)' : 'Micro coupé (toucher pour activer)');
    b.classList.toggle('live', me.mic);
  }
  net.send({ t: 'mic', on: me.mic });
  store('subway-duo-me', { name: me.name, char: me.char, mic: me.mic });
}
function toggleMic() {
  me.mic = !me.mic;
  applyMic();
}
$('micBtn').addEventListener('click', toggleMic);
$('micBtn2').addEventListener('click', toggleMic);

// ---- Liaison avec les autres joueurs
function updateRoom() {
  const room = $('room');
  room.classList.add('on');
  room.classList.toggle('ok', opps.size > 0);
  room.classList.toggle('plusieurs', opps.size > 1);
  $('roomText').textContent = (net.code || '') + (opps.size ? ` · ${opps.size + 1} joueurs` : '');
}
function syncGhosts() {
  game.setGhosts(others().map((o) => ({ id: o.id, kind: o.char })));
}
net.onStatus = (s, id, detail) => {
  if (s === 'arrive') sendHello();
  else if (s === 'parti') {
    const o = opps.get(id);
    if (o) toast(detail === 'quitte' ? `${o.name} a quitté la partie` : `${o.name} s'est déconnecté(e)`);
    opps.delete(id);
    voice?.forget(id);
    voice?.setOpus(opusOk && others().every((x) => x.op));
    syncGhosts();
    // Le créateur est parti pour de bon : le joueur hôte reprend le choix des cœurs.
    if (detail === 'quitte' && (id === creatorId || !opps.size)) {
      creatorId = null;
      if (net.isHost) isCreator = true;
    }
    renderLives();
  } else if (s === 'erreur') {
    toast(id);
    if (phase === 'lobby') $('lobbyErr').textContent = id;
  }
  updateRoom();
};

net.onMessage = (m) => {
  if (m.t === 'v') return void voice?.receive(m);
  if (m.t === 'hello') {
    let o = opps.get(m.from);
    const fresh = !o;
    if (!o) {
      const inRound = phase !== 'lobby' && roundIds.includes(m.from); // sa fiche arrive après le départ
      opps.set(m.from, (o = { id: m.from, phase: 'ready', st: null, final: null, alive: inRound, inRound }));
    }
    o.name = cleanName(m.name) || 'Joueur';
    o.char = m.char === 'fille' ? 'fille' : 'garcon';
    o.mic = !!m.mic;
    o.op = m.op === true;
    o.phase = String(m.phase || 'ready');
    // Opus si tous les navigateurs savent le faire, sinon son de téléphone.
    voice?.setOpus(opusOk && others().every((x) => x.op));
    syncGhosts();
    if (fresh) {
      toast(`${o.name} est là !`);
      beep(660, 0.12, 'triangle', 0.08);
    }
    if (m.cr === true) {
      creatorId = m.from;
      if (!isCreator) setLives(m.lives, false);
    }
    // On répond si l'autre n'a pas encore notre fiche.
    if (fresh || !m.have) sendHello();
    updateRoom();
    renderLives();
    return;
  }
  const o = opps.get(m.from);
  if (!o) return;
  if (m.t === 'phase') {
    o.phase = String(m.phase);
    if (m.phase === 'waiting' && phase !== 'play') toast(`${o.name} est prêt(e) !`);
  } else if (m.t === 'mic') o.mic = !!m.on;
  else if (m.t === 'lives' && !isCreator) setLives(m.n, false);
  else if (m.t === 'st') {
    const n = (v) => (Number.isFinite(v) ? v : 0);
    o.st = {
      lane: Math.max(-1, Math.min(1, Math.round(n(m.lane)))),
      py: Math.max(0, Math.min(4, n(m.py))),
      roll: !!m.roll, run: Math.max(0, Math.min(2, n(m.run))), speed: n(m.speed),
      dist: n(m.dist), score: Math.max(0, Math.round(n(m.score))), lives: Math.max(0, Math.min(10, n(m.lives))),
      alive: !!m.alive, hurt: !!m.hurt,
    };
    o.stAt = now();
  } else if (m.t === 'hit') {
    if (!o.inRound) return;
    toast(`${o.name} ${m.what === 'train' ? "s'est pris un train" : "s'est cogné(e)"} !`);
    if (phase === 'watch' && m.from === watchId) (game.addTrauma(m.what === 'train' ? 0.7 : 0.45), beep(110, 0.3, 'sawtooth', 0.06));
  } else if (m.t === 'over') {
    const wasOver = o.final !== null;
    o.final = Math.max(0, Math.round(Number(m.score) || 0));
    o.alive = false;
    if (phase === 'play' && !wasOver && o.inRound) toast(`${o.name} est éliminé(e) avec ${o.final}`, 3);
  } else if (m.t === 'go' && net.isHost && phase === 'waiting') startNow();
  else if (m.t === 'start' && phase === 'waiting' && Array.isArray(m.ids) && m.ids.includes(net.id)) {
    // L'hôte donne le départ, avec la graine du parcours commun et la liste de ceux qui courent.
    if (m.lives) setLives(m.lives, false);
    startCountdown(Number(m.seed) >>> 0, m.ids.map(String));
  }
};

function sendHello() {
  const have = [...net.peers.keys()].every((id) => opps.has(id)); // j'ai déjà la fiche de tout le monde
  net.send({ t: 'hello', name: me.name, char: me.char, mic: me.mic, phase, have, op: opusOk, cr: isCreator, lives });
}

// L'hôte lance la manche pour tous ceux qui sont prêts.
function startNow() {
  const s = (Math.random() * 2 ** 32) >>> 0;
  const ids = [net.id, ...others().filter((o) => o.phase === 'waiting').map((o) => o.id)];
  net.send({ t: 'start', seed: s, lives, ids });
  startCountdown(s, ids);
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
  const cr = opps.get(creatorId);
  $('livesWho').textContent = isCreator || !cr ? '' : ` (choisi par ${cr.name})`;
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
  game.paused = false;
  resumeAt = 0;
  $('pause').classList.remove('on');
  holdTime = 0;
  $('lobby').classList.toggle('hidden', p !== 'lobby' && p !== 'loading');
  $('tools').classList.toggle('cache', p !== 'play' && p !== 'watch' && p !== 'countdown');
  document.body.dataset.phase = p; // le CSS cache le score et la salle derrière les menus
  $('panel').classList.toggle('hidden', p === 'play' || p === 'watch' || p === 'lobby' || p === 'loading');
  $('livesRow').style.display = p === 'ready' || p === 'waiting' || p === 'over' ? '' : 'none';
  $('watch').classList.toggle('on', p === 'watch');
  $('micBtn2').style.display = soloMode ? 'none' : ''; // seul : personne à qui parler
  // Les mouvements du corps ne s'affichent que si la caméra est là (ou en train de charger).
  $('moves').style.display = (p === 'ready' || p === 'calib') && (camOk || camLoading) ? '' : 'none';
  $('panel').classList.toggle('decompte', p === 'countdown');
  $('resultat').classList.toggle('on', p === 'over');
  if (p === 'calib') detector.startCalibration();
  if (p === 'play') {
    lastActivity = now();
    cadence = CADENCE_NORMAL;
    resultCounted = false;
    for (const o of racers()) {
      o.final = null;
      o.alive = true;
      o.st = null;
    }
    game.setCharacter(me.char);
    game.start(seed, lives);
    beep(880, 0.2, 'triangle', 0.08);
  }
  if (p === 'watch') game.watchStart(seed, opps.get(watchId)?.char); // on suit un adversaire sur le même parcours
  renderLives();
  sendPhase();
}

// ids : joueurs qui courent cette manche (liste donnée par l'hôte, la même chez tout le monde) ;
// les autres la regardent passer.
let roundIds = [];
function startCountdown(s, ids = []) {
  seed = s;
  roundIds = ids;
  for (const o of opps.values()) {
    o.inRound = ids.includes(o.id);
    if (o.inRound) Object.assign(o, { final: null, alive: true, st: null });
  }
  solo = !racers().length;
  resultCounted = false;
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
$('charChoice').addEventListener('click', (e) => {
  const b = e.target.closest('.choice');
  if (!b) return;
  me.char = b.dataset.char;
  pick('charChoice', 'char', me.char);
  game.setCharacter(me.char);
  $('meAva').src = AVA(me.char);
});
const params = new URLSearchParams(location.search);
let linkCode = cleanCode(params.get('salle'));
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
  if (act === 'solo') {
    // Mode solo : on joue tout de suite, sans code ni adversaire (ni micro).
    $('lobbyErr').textContent = '';
    audioCtx();
    soloMode = true;
    isCreator = true; // les cœurs se règlent librement
    keepAwake();
    setPhase('ready');
    return;
  }
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
  box.innerHTML = `<span class="lab">Code à donner aux autres joueurs</span><div class="tuiles">${[...code].map((c) => `<i>${c}</i>`).join('')}</div>`;
  const send = document.createElement('button');
  send.type = 'button';
  send.className = 'btn bleu petit';
  send.innerHTML = navigator.share ? ic('partager') + 'Envoyer le lien' : ic('copier') + 'Copier le lien';
  send.onclick = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Subway Duo', text: `Viens jouer à Subway Duo avec moi ! Code : ${code}`, url: link });
      } catch {}
    } else {
      navigator.clipboard?.writeText(link).then(() => (send.innerHTML = ic('check') + 'Lien copié'));
    }
  };
  const small = document.createElement('span');
  small.className = 'link';
  small.textContent = link;
  box.append(send, small);
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
  if (document.visibilityState !== 'visible') return void syncPause(); // appli cachée : course en pause
  // Retour dans l'appli (iPhone : après la veille ou un changement d'appli) : on relance tout.
  if (phase !== 'lobby' && phase !== 'loading') keepAwake();
  if (phase === 'play' && game.paused && !sheetOpen()) showPause(true); // retour dans l'appli : la pause attend un toucher
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
    $('cam').style.display = '';
    $('camBtn').style.display = '';
  } catch (err) {
    console.error(err);
    $('cam').style.display = 'none';
    $('camBtn').style.display = 'none';
  }
  camLoading = false;
}
// Bouton « avec la caméra » : si elle a été refusée ou n'a pas démarré, on la redemande
// (sur iPhone, une demande faite après un toucher passe mieux).
function wantCamera() {
  if (camOk || camLoading || noCamera) return;
  camLoading = true;
  initCamera();
}

function trackPose(t) {
  if (!camOk || video.readyState < 2 || video.currentTime === lastVideoTime) return false;
  lastVideoTime = video.currentTime;
  const res = landmarker.detectForVideo(video, performance.now());
  landmarks = res.landmarks?.[0] ?? null;
  measure = detector.measure(landmarks, video.videoWidth / video.videoHeight);
  if (phase === 'play' && !keyboard && !game.paused) {
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
// Classement de la manche : moi et ceux qui la courent, du meilleur score au moins bon.
function standings() {
  const meRow = { id: 'me', name: me.name || 'Moi', char: me.char, score: myFinal, alive: false, me: true };
  const rows = racers().map((o) => ({ id: o.id, name: o.name, char: o.char, score: scoreOf(o), alive: isAlive(o) }));
  return [meRow, ...rows].sort((a, b) => b.score - a.score);
}
// Une fois tout le monde éliminé : victoire au meilleur score (pas en cas d'égalité), son du résultat.
function countResult() {
  if (solo || resultCounted || anyAlive()) return;
  resultCounted = true;
  const list = standings();
  const top = list[0].score;
  if (list.filter((x) => x.score === top).length === 1) wins.set(list[0].id, (wins.get(list[0].id) || 0) + 1);
  beep(myFinal >= top ? 990 : 330, 0.35, 'triangle', 0.09);
}
const winsLine = () => 'Victoires : ' + standings().map((x) => `${x.me ? 'toi' : x.name} ${wins.get(x.id) || 0}`).join(' · ');
// Adversaire encore en course le plus avancé (à regarder après mon élimination).
const leaderAlive = () => aliveRacers().filter((o) => o.st).sort((a, b) => scoreOf(b) - scoreOf(a))[0] || null;

// Boutons sous le message : ce que fait la touche Entrée au clavier, au doigt sur téléphone.
let actsKey = '';
function renderActs() {
  const list = [];
  const canRestart = phase === 'ready' || (phase === 'over' && !anyAlive());
  const again = phase === 'over' ? 'Rejouer' : 'Jouer';
  if (canRestart && !noCamera) list.push(['cam', ic('camera') + again + ' avec la caméra', '']);
  if (canRestart) list.push(['touch', (TOUCH ? ic('doigt') : ic('jouer', 'plein')) + again + (TOUCH ? ' au doigt' : ' au clavier'), noCamera ? '' : 'bleu']);
  if (phase === 'calib') list.push(['touch', (TOUCH ? ic('doigt') + 'Plutôt au doigt' : ic('jouer', 'plein') + 'Plutôt au clavier'), 'bleu']);
  if (phase === 'waiting' && !opps.size) list.push(['solo', ic('jouer', 'plein') + 'Jouer seul en attendant', 'bleu']);
  // Quelqu'un tarde : ceux qui sont prêts peuvent partir sans lui.
  const late = others().filter((o) => o.phase !== 'waiting' && o.phase !== 'play');
  if (phase === 'waiting' && late.length && others().some((o) => o.phase === 'waiting'))
    list.push(['go', ic('jouer', 'plein') + 'Partir sans ' + names(late), 'bleu']);
  const key = list.map((a) => a[0] + a[1]).join('|');
  if (key === actsKey) return;
  actsKey = key;
  $('acts').replaceChildren(
    ...list.map(([act, text, cls]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ' + cls;
      b.dataset.act = act;
      b.innerHTML = text;
      return b;
    }),
  );
}
$('acts').addEventListener('click', (e) => {
  const act = e.target.closest('button')?.dataset.act;
  audioCtx();
  keepAwake();
  const canRestart = phase === 'ready' || (phase === 'over' && !anyAlive());
  if (act === 'touch' && (canRestart || phase === 'calib')) {
    keyboard = true;
    ready();
  } else if (act === 'cam' && canRestart) {
    // Avec la caméra : on se place, on ne bouge plus 2 s, et c'est parti.
    wantCamera();
    setPhase('calib');
  } else if (act === 'solo' && phase === 'waiting' && !opps.size) startCountdown((Math.random() * 2 ** 32) >>> 0);
  else if (act === 'go' && phase === 'waiting') net.isHost ? startNow() : net.send({ t: 'go' });
});

const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function resultHTML() {
  const card = (name, char, pts, sub, win) =>
    `<div class="res${win ? ' gagne' : ''}">${win ? '<span class="badge">Gagnant</span>' : ''}<img src="${AVA(char)}" alt="">` +
    `<span class="n">${esc(name)}</span><span class="pts cerne">${pts}</span><span class="sous">${sub}</span></div>`;
  const a = myFinal;
  if (solo || !racers().length) return card(me.name || 'Moi', me.char, a, a > 0 && a >= game.best ? 'Nouveau record !' : `record ${game.best}`, false);
  const list = standings(), done = !anyAlive();
  const topAlone = done && list[0].score > (list[1]?.score ?? -1);
  if (list.length === 2) {
    // À deux : une grande carte chacun.
    const [o] = racers(), b = scoreOf(o), live = isAlive(o);
    return card('Toi', me.char, a, 'éliminé(e)', done && a > b) + card(o.name, o.char, b, live ? 'court encore…' : 'éliminé(e)', done && b > a);
  }
  return list
    .map(
      (x, i) =>
        `<div class="rang${topAlone && i === 0 ? ' gagne' : ''}${x.me ? ' moi' : ''}"><span class="r">${i + 1}</span><img src="${AVA(x.char)}" alt="">` +
        `<span class="qui"><span class="n">${esc(x.name)}</span><span class="sous">${x.alive ? 'court encore…' : 'éliminé(e)'}</span></span>` +
        `<span class="pts cerne">${x.score}</span></div>`,
    )
    .join('');
}

function panelTitle() {
  if (phase === 'calib') return 'Calibrage';
  if (phase === 'waiting') return 'Prêt !';
  if (phase === 'over') {
    if (solo || !racers().length) return 'Terminé';
    if (anyAlive()) return 'Éliminé';
    const list = standings();
    const rank = 1 + list.filter((x) => x.score > myFinal).length;
    if (rank === 1) return list.filter((x) => x.score === myFinal).length > 1 ? 'Égalité' : 'Gagné !';
    return list.length === 2 ? 'Perdu…' : `${rank}e place`;
  }
  return 'Prêt ?';
}

function updatePanel(dt, t) {
  renderActs();
  // Barre de progression : bras levés (avec caméra) et calibrage seulement.
  const showBar = phase === 'calib' || ((phase === 'ready' || phase === 'over') && (camOk || camLoading));
  if ($('bar').hidden === showBar) $('bar').hidden = !showBar;
  setText($('cardTitle'), panelTitle());
  const msg = $('msg'), bar = $('bar').firstElementChild;
  const handsUp = MotionDetector.handsUp(measure);
  if (phase === 'ready' || phase === 'over') {
    const canStart = camOk && t - phaseStart > (phase === 'over' ? 2 : 0) && !(phase === 'over' && anyAlive());
    holdTime = canStart && handsUp ? holdTime + dt : 0;
    bar.style.width = Math.min(100, (holdTime / HOLD_TO_START) * 100) + '%';
    const how = !camOk
      ? camLoading
        ? 'Chargement de la caméra…'
        : noCamera
          ? TOUCH
            ? 'Pas de caméra : joue au doigt.'
            : 'Pas de caméra : appuie sur Entrée pour jouer au clavier.'
          : 'Caméra pas encore autorisée :\ntouche « avec la caméra » pour la demander.'
      : measure
        ? `Lève les deux bras pour ${phase === 'over' ? 'la revanche' : 'te mettre prêt(e)'} !`
        : 'Avec la caméra, tu cours avec tout ton corps.\nOu joue au doigt sur l’écran.';
    if (phase === 'over') {
      countResult(); // compte la victoire (une seule fois) et joue le son du résultat
      setHTML($('resultat'), resultHTML());
      $('resultat').classList.toggle('liste', !solo && racers().length > 1);
      const alive = aliveRacers();
      msg.textContent = alive.length
        ? `${names(alive)} ${alive.length > 1 ? 'courent' : 'court'} encore…`
        : [!solo && racers().length ? winsLine() : '', camOk ? how : ''].filter(Boolean).join('\n');
    }
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
    msg.textContent = !camOk
      ? camLoading
        ? 'Démarrage de la caméra…'
        : 'La caméra est bloquée : autorise-la dans les réglages\ndu téléphone, ou joue au doigt.'
      : !measure
        ? TOUCH
          ? 'Pose le téléphone debout et recule à 2–3 m :\non doit te voir de la tête aux pieds.'
          : 'Recule à 2–3 m de la caméra :\non doit te voir de la tête aux pieds.'
        : handsUp
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
    if (soloMode) return startCountdown((Math.random() * 2 ** 32) >>> 0); // seul : départ tout de suite
    const list = others();
    const playing = list.filter((o) => o.phase === 'play'), late = list.filter((o) => o.phase !== 'waiting');
    if (!list.length) msg.textContent = `En attente d'autres joueurs…${TOUCH ? '' : '\n(Entrée = jouer seul en attendant)'}`;
    else if (playing.length) msg.textContent = `${names(playing)} ${playing.length > 1 ? 'finissent leur' : 'finit sa'} partie…`;
    else if (late.length) msg.textContent = `En attente de ${names(late)}…`;
    else msg.textContent = 'Départ…';
    // L'hôte donne le départ quand tout le monde est prêt (et qu'on a la fiche de chacun).
    if (net.isHost && list.length && !late.length && net.peers.size === opps.size) startNow();
  } else if (phase === 'watch') {
    // Spectateur jusqu'à l'élimination de l'adversaire (ou sa déconnexion).
    const w = opps.get(watchId);
    if (!w || !isAlive(w)) {
      const next = leaderAlive();
      if (next) (watchId = next.id), setPhase('watch'); // le suivant encore en course
      else setPhase('over');
    }
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
  setText($('meWho'), me.name || 'Moi');
  const done = phase === 'watch' || phase === 'over';
  setText($('score'), done ? myFinal : game.score);
  setHTML($('sub'), done ? `record ${game.best}` : `<i class="piece"></i>${game.coinCount} · record ${Math.max(game.best, game.score)}`);
  setHTML($('speed'), done ? 'éliminé(e)' : `${ic('eclair', 'plein')}${Math.round(game.speed * 3.6)} km/h`);
  const a = game.run;
  $('speed').style.background = done || a < 0.75 ? '' : a < 0.95 ? '#1fae6b' : a < 1.2 ? '#f08c00' : '#e8392b';
  setHTML($('lives'), done ? '' : hearts(game.lives));
  const w = phase === 'watch' && opps.get(watchId);
  if (w) setText($('watchText'), `Tu regardes ${w.name} : ${scoreOf(w)} — toi : ${myFinal}`);
  const stopped = phase === 'play' && !keyboard && !game.paused && t - lastActivity > RUN_TIMEOUT;
  setText($('hint'), measure ? 'Sautille pour avancer !' : 'Reviens dans le cadre !');
  $('hint').classList.toggle('on', stopped);

  // Le code reste affiché tant qu'il reste de la place : d'autres peuvent encore venir.
  $('share').classList.toggle('on', (phase === 'ready' || phase === 'waiting') && !!net.code && opps.size < MAX_PLAYERS - 1);
  $('micBtn').classList.toggle('talk', !!voice?.talking);
  renderOpps();
}

// Adversaires, à droite : un bloc chacun (une ligne compacte à partir de 3 joueurs).
const STATES = { ready: 'Se prépare', calib: 'Calibrage…', waiting: 'Prêt(e)', countdown: 'Départ…', play: 'En course', over: 'Éliminé(e)', watch: 'Éliminé(e)', lobby: 'Accueil' };
const advEls = new Map();
const tagEls = new Map();
function advBlock(id) {
  let b = advEls.get(id);
  if (b) return b;
  const el = document.createElement('div');
  el.className = 'adv';
  el.innerHTML =
    `<div class="nom"><img alt=""><span></span><svg class="ic"><use href="#i-mic-off"/></svg></div><div class="score cerne"></div>` +
    `<div class="puces"><span class="puce etat"></span></div><div class="puces ecart"><span class="puce"></span></div><div class="lives"></div>`;
  b = { el, ava: el.querySelector('img'), who: el.querySelector('.nom span'), mic: el.querySelector('.nom svg'),
    score: el.querySelector('.score'), etat: el.querySelector('.etat'), ecart: el.querySelector('.ecart .puce'), lives: el.querySelector('.lives') };
  advEls.set(id, b);
  return b;
}
function renderOpps() {
  const box = $('opp');
  const list = others();
  const many = list.length > 1;
  box.classList.toggle('plusieurs', many);
  if (phase === 'play' || phase === 'watch') list.sort((a, b) => scoreOf(b) - scoreOf(a)); // le premier en haut
  const ids = list.length ? list.map((o) => o.id) : ['_'];
  for (const [id, b] of advEls) if (!ids.includes(id)) (b.el.remove(), advEls.delete(id));
  ids.forEach((id, i) => {
    const b = advBlock(id);
    if (box.children[i] !== b.el) box.insertBefore(b.el, box.children[i] || null);
  });
  if (!list.length) {
    // Personne encore : une place vide.
    const b = advBlock('_');
    setText(b.who, 'Adversaire');
    b.ava.style.display = 'none';
    b.mic.style.display = 'none';
    setText(b.score, '—');
    setHTML(b.lives, '');
    setText(b.etat, net.connected ? 'Connexion…' : 'Pas encore là');
    setText(b.ecart, '');
    b.el.classList.remove('out');
  }
  for (const o of list) {
    const b = advBlock(o.id);
    setText(b.who, o.name);
    b.ava.style.display = '';
    const ava = AVA(o.char);
    if (!b.ava.src.endsWith(ava)) b.ava.src = ava;
    b.mic.style.display = '';
    const micIcon = '#i-' + (o.mic ? 'mic' : 'mic-off');
    const use = b.mic.firstElementChild;
    if (use.getAttribute('href') !== micIcon) use.setAttribute('href', micIcon);
    b.mic.classList.toggle('parle', !!voice?.talkingFrom(o.id));
    setText(b.score, scoreOf(o));
    setHTML(b.lives, hearts(o.final !== null ? 0 : (o.st?.lives ?? lives)));
    const racing = phase === 'play' && !solo && o.inRound;
    b.el.classList.toggle('out', racing && o.final !== null);
    let gap = '';
    if (racing && o.phase === 'play' && o.st && o.final === null) {
      const d = Math.round(o.st.dist - game.distance);
      gap = d > 2 ? `devant de ${d} m` : d < -2 ? `derrière de ${-d} m` : 'côte à côte';
    } else if (racing && o.final !== null) {
      const d = o.final - game.score;
      gap = d > 0 ? `encore ${d} pts` : 'tu le dépasses !';
    }
    const state = o.inRound || phase !== 'play' ? STATES[o.phase] || '' : 'Attend la suite';
    // À plusieurs, une seule puce : l'écart pendant la course, sinon où il en est.
    setText(b.etat, many ? gap || state : state);
    setText(b.ecart, many ? '' : gap);
  }

  // Fantômes : visibles pendant la course, à leur voie, avec leur prénom au-dessus.
  for (const o of list) {
    const show = phase === 'play' && !solo && o.inRound && o.st && o.phase === 'play' && o.final === null;
    game.setGhostState(o.id, show ? { ...o.st, gap: o.st.dist - game.distance } : null);
    let tag = tagEls.get(o.id);
    const pos = show ? game.ghostLabelPos(o.id) : null;
    if (!pos) {
      if (tag) tag.style.display = 'none';
      continue;
    }
    if (!tag) {
      tag = document.createElement('div');
      tag.className = 'ghostTag';
      $('ghostTags').append(tag);
      tagEls.set(o.id, tag);
    }
    tag.style.display = 'block';
    setText(tag, o.name);
    tag.style.left = pos.x + 'px';
    tag.style.top = pos.y + 'px';
  }
  for (const [id, tag] of tagEls) if (!opps.has(id)) (tag.remove(), tagEls.delete(id));
}

// État envoyé à l'adversaire
let lastSlow = 0;
function sendState(t) {
  if (!net.connected) return;
  // Une fois par seconde, on répète ce qu'un message perdu ne doit pas bloquer.
  if (t - lastSlow > 1) {
    lastSlow = t;
    if ([...net.peers.keys()].some((id) => !opps.has(id))) sendHello(); // quelqu'un n'a pas encore ma fiche
    sendPhase();
    if (phase === 'over' || phase === 'watch') net.send({ t: 'over', score: myFinal });
    if (phase === 'countdown' && net.isHost && t - phaseStart < 1.2 && roundIds.length) net.send({ t: 'start', seed, lives, ids: roundIds });
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
  else if (e === 'horn') {
    // Klaxon à deux tons (plus fort si le train arrive sur ta voie) + alerte à l'écran.
    const v = info ? 0.07 : 0.035;
    beep(311, 0.55, 'sawtooth', v);
    beep(392, 0.55, 'sawtooth', v);
    if (info) flash('ATTENTION !');
  } else if (e === 'whoosh') {
    beep(180, 0.25, 'sawtooth', 0.05);
    beep(90, 0.3, 'triangle', 0.08);
  }
  else if (e === 'jump') beep(520, 0.12, 'sine', 0.08);
  else if (e === 'roll') beep(260, 0.12, 'sine', 0.08);
  // Moment de la journée et graphismes : ça change sans message (pas de fenêtre qui gêne la course).
  else if (e === 'daytime' || e === 'quality') {
  } else if (e === 'hit') (beep(110, 0.3, 'sawtooth', 0.1), net.send({ t: 'hit', what: info }));
  else if (e === 'over') {
    myFinal = game.score;
    net.send({ t: 'over', score: myFinal });
    // D'autres courent encore : on regarde celui qui mène. Sinon, résultat.
    const next = solo ? null : leaderAlive();
    if (next) (watchId = next.id), setPhase('watch');
    else setPhase('over');
  }
};

// ---- Clavier
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const k = e.key;
  if (k === 'Enter' && (phase === 'ready' || (phase === 'over' && !anyAlive()))) {
    // Corps visible : on calibre comme avec les bras levés ; sinon, partie au clavier.
    if (camOk && measure) return setPhase('calib');
    keyboard = true;
    return ready();
  }
  if (k === 'Enter' && phase === 'waiting' && !opps.size) return startCountdown((Math.random() * 2 ** 32) >>> 0);
  if ((k === 'm' || k === 'M') && phase !== 'lobby') return toggleMic();
  if (k === 'r' || k === 'R') return toggleSettings();
  if (k === 'v' || k === 'V') return toggleCam();
  if ((k === 'p' || k === 'P') && phase === 'play') return showPause(!$('pause').classList.contains('on'));
  if (k === 'Escape') {
    if ($('pause').classList.contains('on')) return showPause(false);
    if ($('settings').classList.contains('on')) return toggleSettings(false);
    if ($('confirm').classList.contains('on')) return askQuit(false);
    if (phase !== 'lobby' && phase !== 'loading') return askQuit(true);
    return;
  }
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
    if (phase !== 'play' || e.touches.length !== 1 || e.target.closest?.('button, input, select, .feuille')) return;
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
  syncPause();
}

// ---- Pause : la course s'arrête pendant qu'une feuille est ouverte ou que l'appli est cachée,
// puis repart après 3, 2, 1. À plusieurs, seule MA course s'arrête (chacun court son parcours).
const sheetOpen = () => ['pause', 'settings', 'confirm'].some((id) => $(id).classList.contains('on'));
function showPause(on) {
  if (on && phase !== 'play') return;
  if (on)
    $('pauseText').textContent = aliveRacers().length ? 'Ta course est en pause.\nLes autres continuent de courir.' : 'La course t’attend.';
  $('pause').classList.toggle('on', on);
  syncPause();
}
function syncPause() {
  if (phase !== 'play') return;
  if (sheetOpen() || document.visibilityState !== 'visible') {
    game.paused = true;
    resumeAt = 0;
  } else if (game.paused && !resumeAt) {
    resumeAt = now() + 3;
    resumeShown = 0;
  }
}
function tickResume(t) {
  if (!resumeAt) return;
  const left = Math.ceil(resumeAt - t);
  if (left > 0 && left !== resumeShown) {
    resumeShown = left;
    flash(String(left));
    beep(440, 0.12, 'triangle', 0.08);
  }
  if (t >= resumeAt) {
    resumeAt = 0;
    game.paused = false;
    lastActivity = t; // pas de « Reviens dans le cadre » à la reprise
    flash('GO !');
    beep(660, 0.12, 'triangle', 0.08);
  }
}
$('pauseBtn').addEventListener('click', () => showPause(true));
$('pauseGo').addEventListener('click', () => showPause(false));
$('pauseSet').addEventListener('click', () => {
  $('pause').classList.remove('on');
  toggleSettings(true);
});
$('pauseQuit').addEventListener('click', () => {
  $('pause').classList.remove('on');
  askQuit(true);
});
$('pause').addEventListener('click', (e) => e.target === $('pause') && showPause(false));
function toggleCam() {
  $('cam').style.display = $('cam').style.display ? '' : 'none';
}
$('setBtn').addEventListener('click', () => toggleSettings());
$('setBtn2').addEventListener('click', () => toggleSettings());
$('setClose').addEventListener('click', () => toggleSettings(false));
$('settings').addEventListener('click', (e) => e.target === $('settings') && toggleSettings(false));
$('camBtn').addEventListener('click', toggleCam);

// ---- Quitter la partie : retour à l'accueil, l'adversaire est prévenu tout de suite.
function askQuit(on = true) {
  if (on) {
    toggleSettings(false);
    $('confirmText').textContent =
      phase === 'play' ? 'Ta course s’arrête et tu reviens à l’accueil.' : 'Tu reviens à l’accueil pour créer ou rejoindre une autre partie.';
  }
  $('confirm').classList.toggle('on', on);
  syncPause();
}
function leaveGame() {
  askQuit(false);
  toggleSettings(false);
  net.send({ t: 'bye' });
  net.stop();
  voice?.setMic(false);
  opps.clear();
  creatorId = watchId = null;
  solo = false;
  soloMode = false;
  isCreator = false;
  keyboard = false;
  myFinal = 0;
  wins.clear();
  syncGhosts();
  for (const tag of tagEls.values()) tag.remove();
  tagEls.clear();
  game.state = 'idle';
  game.resetRun();
  game.setCharacter(me.char);
  $('opp').classList.remove('on', 'plusieurs');
  $('room').classList.remove('on', 'ok', 'plusieurs');
  $('micBtn').classList.remove('on');
  $('share').innerHTML = '';
  // Retour à l'accueil normal (même si on était arrivé par un lien de partie).
  linkCode = '';
  $('hostOrJoin').style.display = '';
  $('joinOnly').style.display = '';
  $('code').value = '';
  const q = new URLSearchParams(location.search);
  q.delete('salle');
  history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : ''));
  wakeLock?.release().catch(() => {});
  setPhase('lobby');
  ajusterAccueil();
}
for (const id of ['quitBtn', 'quitBtn2']) $(id).addEventListener('click', () => askQuit(true));
$('confirmYes').addEventListener('click', leaveGame);
$('confirmNo').addEventListener('click', () => askQuit(false));
$('confirm').addEventListener('click', (e) => e.target === $('confirm') && askQuit(false));
setHTML($('micBtn'), ic(me.mic ? 'mic' : 'mic-off'));
setHTML($('micBtn2'), ic(me.mic ? 'mic' : 'mic-off'));

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
  else tickResume(t);
  game.setRunning(phase === 'play' && (keyboard || t - lastActivity < RUN_TIMEOUT));
  game.setPace(keyboard ? 1 : Math.min(PACE_MAX, Math.max(PACE_MIN, 1 + PACE_PER_HOP * (cadence - CADENCE_NORMAL))));
  const w = phase === 'watch' && opps.get(watchId);
  if (w?.st) {
    // L'état arrive 12×/s : on prévoit la distance entre deux messages.
    const ahead = Math.min(0.3, t - (w.stAt || t)) * w.st.speed;
    game.watchTo({ ...w.st, dist: w.st.dist + ahead }, dt);
  }
  game.update(dt);
  updateHud(t);
  sendState(t);
  requestAnimationFrame(frame);
}

// Accueil : si tout ne tient pas en hauteur (petit iPhone), on rapetisse un peu le logo et le
// formulaire pour qu'ils restent centrés, sans avoir à faire défiler.
function ajusterAccueil() {
  const l = $('lobby');
  if (l.classList.contains('hidden')) return;
  l.style.setProperty('--zoom', 1);
  const cs = getComputedStyle(l);
  const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const need = l.scrollHeight - pad, have = l.clientHeight - pad;
  if (need > have + 1) l.style.setProperty('--zoom', Math.max(0.72, have / need).toFixed(3));
}
addEventListener('resize', () => requestAnimationFrame(ajusterAccueil));
document.fonts?.ready.then(ajusterAccueil);
for (const img of document.querySelectorAll('#lobby img')) img.addEventListener('load', ajusterAccueil);

window.duo = { game, net, opps, get phase() { return phase; }, get voice() { return voice; } }; // pour le débogage dans la console
setPhase('lobby');
ajusterAccueil();
// ?sanscamera : pour tester à deux sur un même PC, au clavier.
if (!params.has('sanscamera')) initCamera();
else {
  noCamera = true;
  $('cam').style.display = 'none';
  $('camBtn').style.display = 'none';
  camLoading = false;
}
// Appli hors ligne et démarrage rapide : les gros fichiers (modèle de pose, 3D) restent sur le téléphone.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost'))
  navigator.serviceWorker.register('sw.js').catch(() => {});
frame();

// Pas de rebond / défilement de la page sur iPhone (sauf dans les menus qui défilent).
addEventListener('touchmove', (e) => { if (!e.target.closest?.('.overlay, .feuille')) e.preventDefault(); }, { passive: false });

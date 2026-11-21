// Le jeu lui-même : piste à 3 voies, obstacles, pièces, personnage (Three.js).
// Il ne sait rien de la caméra : on le pilote avec setLane / jump / roll / setRunning.
import * as THREE from '../vendor/three.module.js';
import { clone as cloneSkinned } from '../vendor/addons/utils/SkeletonUtils.js';
import { buildCartoonCity, toon, OUTLINE, addOutline, TOON } from './cartoon.js?v=15';

const LANE_W = 2.4;
const SPAWN_Z = -120;
const DESPAWN_Z = 12;
const GRAVITY = 21; // avec JUMP_V : ~0,85 s en l'air, pour qu'un saut anticipé ne retombe pas trop tôt
const JUMP_V = 8.9;
// La caméra ne voit un mouvement que ~0,1 s après son début : un saut ou une roulade
// qui arrive juste après le contact avec une barrière compte encore.
const GRACE = 0.12;
const ROLL_TIME = 0.75;
const LOW_H = 0.8; // barrière basse : à sauter
const HIGH_Y = 1.25; // dessous de la barrière haute : passer en roulade
const TRAIN_LEN = 14;
const SLEEPER_GAP = 2;
const N_SLEEPERS = 70;
const BASE_FOV = 54;
const FOV_BOOST = 8; // degrés de champ en plus à pleine vitesse : on sent mieux la vitesse
// Sensations (skill game-feel) : « trauma » qui décroît, tremblement = trauma² (doux pour les
// petits chocs, fort pour les gros), mini-gel du jeu au moment du choc.
const TRAUMA_DECAY = 1.4; // par seconde réelle
const HIT_STOP = { low: 0.07, high: 0.07, train: 0.12 }; // secondes réelles
const HIT_TRAUMA = { low: 0.55, high: 0.55, train: 0.85 };
const POP_TIME = 0.22; // pièce ramassée : grossit puis disparaît
const CHAR_SCALE = 1.25; // modèles de 1,8 m → même taille que l'ancien personnage (~2,1 m)

// Modèles 3D chargés par assets.js (null = on garde les cubes d'origine).
let ASSETS = null;
const BAKED = toon(0xffffff, { vertexColors: true });
// Portique : bandes jaunes et noires de chantier.
const STRIPES = (() => {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#ffc93c';
  g.fillRect(0, 0, 256, 64);
  g.fillStyle = '#1f1b24';
  for (let x = -64; x < 256; x += 48) {
    g.beginPath();
    g.moveTo(x, 64);
    g.lineTo(x + 24, 64);
    g.lineTo(x + 88, 0);
    g.lineTo(x + 64, 0);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();

// Générateur pseudo-aléatoire à graine (mulberry32) : même graine = même parcours.
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const mat = (color, opts = {}) => toon(color, opts); // ombrage cartoon partout

const GEO = {
  lowBar: box(2.0, 0.22, 0.25),
  lowLeg: box(0.16, LOW_H, 0.2),
  highBar: box(2.1, 0.9, 0.3),
  highLeg: box(0.18, HIGH_Y + 0.9, 0.25),
  train: box(2.0, 3.1, TRAIN_LEN),
  trainFront: box(1.7, 1.0, 0.1),
  trainStripe: box(2.04, 0.35, TRAIN_LEN + 0.02),
  coin: new THREE.CylinderGeometry(0.32, 0.32, 0.08, 16),
  headlight: new THREE.CircleGeometry(0.2, 16),
};
const MAT = {
  red: mat(0xe5392f),
  white: mat(0xf5f5f5),
  yellow: mat(0xffc400),
  dark: mat(0x2b2f3a),
  glass: mat(0x9fe3ff),
  coin: toon(0xffd21f, { emissive: 0x7a4a00, emissiveIntensity: 0.6 }),
  stripes: toon(0xffffff, { map: STRIPES }),
  headlight: new THREE.MeshBasicMaterial({ color: 0xfff6c8 }),
  trains: [mat(0x2f7de1), mat(0x1fae6b), mat(0xd9552b), mat(0x8a4fd3)],
};

export class Game {
  constructor(canvas, assets = null) {
    ASSETS = assets;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    // MediaPipe tourne en même temps sur la même machine : 1,5× suffit (2× = 78 % de pixels en plus).
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap; // three r160 : la version douce s'appelle encore ainsi
    // Pas de courbe de tons : les couleurs cartoon restent vives et franches.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.scene = new THREE.Scene(); // ciel, brouillard, lumière et moment de la journée : voir cartoon.js
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 200);
    this.fx = true; // contours noirs (coupés en qualité basse)
    // Soleil fixe (le monde défile, le joueur reste en z = 0) ; sa couleur et sa force suivent
    // l'heure (cartoon.js). Son cadre d'ombre couvre les 3 voies de z = +8 à z = -80.
    const sun = new THREE.DirectionalLight(0xffffff, 2.5);
    sun.position.set(-12.2, 24.5, -21.8);
    sun.target.position.set(0, 0, -34);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -37, right: 34, bottom: -28, top: 32, near: 6, far: 53 });
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun, sun.target);
    this.sun = sun;

    this.buildWorld();
    this.buildPlayer();

    this.obstacles = [];
    this.coins = [];
    this.pops = []; // pièces ramassées en train de « poper »
    // Objets réutilisés au lieu d'être recréés à chaque rangée (skill performance : pas d'à-coups).
    this.pool = { low: [], high: [], train: [], coin: [] };
    this._m = new THREE.Matrix4();
    this.shakeStrength = 1; // réglage du joueur, 0 à 1
    this.trauma = 0;
    this.hitStop = 0;
    this.best = Number(localStorage.getItem('subway-sport-best') || 0);
    this.onEvent = () => {}; // 'coin' | 'hit' | 'over' | 'jump' | 'roll'
    this.state = 'idle';
    this.resetRun();
    this.resize();
    addEventListener('resize', () => this.resize());
    addEventListener('orientationchange', () => setTimeout(() => this.resize(), 250));
  }

  resize() {
    const el = this.renderer.domElement;
    const w = el.clientWidth || innerWidth, h = el.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Téléphone en portrait : l'écran est étroit, on recule et on monte la caméra et on élargit
    // le champ pour voir les 3 voies en entier (0 = écran large, 1 = téléphone en portrait).
    this.portrait = Math.max(0, Math.min(1, (1.2 - w / h) / 0.7));
    this.camera.fov = BASE_FOV + 16 * this.portrait;
    this.camera.updateProjectionMatrix();
  }

  buildWorld() {
    this.city = buildCartoonCity(this, { LANE_W, DESPAWN_Z, SPAWN_Z });
    this.buildings = this.city.rows; // immeubles + murs à graffitis : défilent et se replacent
    // Traverses (qui défilent)
    this.sleepers = new THREE.InstancedMesh(box(1.6, 0.1, 0.38), mat(0x7a5236), N_SLEEPERS * 3);
    this.sleepers.receiveShadow = true;
    this.scene.add(this.sleepers);
    this.scroll = 0;
  }

  // Contours noirs façon dessin animé (un seul matériau partagé).
  setEffects(on) {
    this.fx = on;
    OUTLINE.visible = on;
  }

  // ---- Qualité : chaque joueur a sa propre carte graphique (jeu en ligne), donc on s'adapte
  // à SA machine. 3 = contours + ombres, 2 = ombres, 1 = rien de lourd, 0 = en plus 30 % de pixels en moins.
  setQuality(level, auto = false) {
    this.quality = level;
    this.autoQ = auto;
    this.setEffects(level >= 3);
    this.setShadows(level >= 2);
    const pr = Math.min(devicePixelRatio, 1.5) * (level >= 1 ? 1 : 0.7);
    if (pr !== this.renderer.getPixelRatio()) {
      this.renderer.setPixelRatio(pr);
      this.resize();
    }
    this.qT = this.qN = 0;
    this.qSkip = 1; // la fenêtre de mesure suivante contient la recompilation : on l'ignore
  }

  // Mesure la fluidité par tranches de 2 s, seulement en course (le chargement et l'accueil
  // faussent la mesure) ; deux tranches d'affilée sous ~48 images/s → on descend d'un cran.
  autoQuality(realDt) {
    if (!this.autoQ || this.quality <= 0 || (this.state !== 'play' && this.state !== 'watch')) return;
    this.qT += realDt;
    this.qN++;
    if (this.qT < 2) return;
    const avg = this.qT / this.qN;
    this.qT = this.qN = 0;
    if (this.qSkip > 0) return void this.qSkip--;
    this.qSlow = avg > 1 / 48 ? (this.qSlow || 0) + 1 : 0;
    if (this.qSlow >= 2) {
      this.qSlow = 0;
      this.setQuality(this.quality - 1, true);
      this.onEvent('quality', this.quality);
    }
  }

  buildPlayer() {
    this.me = makeCharacter('garcon');
    this.scene.add(this.me.group);
    this.player = this.me.group;
    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.55, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.scene.add(this.shadow);
  }

  // Ombres : ~1,5 ms de plus par image sur un petit GPU (Intel HD 5500), coupables dans les réglages.
  setShadows(on) {
    this.sun.castShadow = on; // three recompile ses matériaux une fois, puis saute la passe d'ombre
  }

  // 'garcon' ou 'fille'
  setCharacter(kind) {
    if (this.me.kind === kind) return;
    this.scene.remove(this.me.group);
    this.me = makeCharacter(kind);
    this.scene.add(this.me.group);
    this.player = this.me.group;
  }

  // Fantôme de l'adversaire : son personnage en gris transparent, un peu devant.
  // null = pas d'adversaire. Mettre à jour son état avec ghostState.
  setGhost(kind) {
    if (this.ghost) this.scene.remove(this.ghost.group);
    this.ghost = kind ? makeCharacter(kind, true) : null;
    if (this.ghost) {
      this.ghost.px = 0;
      this.ghost.phase = 0;
      this.ghost.fade = 1;
      this.ghost.z = -5;
      this.scene.add(this.ghost.group);
    }
  }

  // Position à l'écran (px) de la tête du fantôme, pour placer son prénom au-dessus.
  ghostLabelPos() {
    if (!this.ghost || !this.ghost.group.visible) return null;
    const v = new THREE.Vector3(this.ghost.px, 2.7 + (this.ghostState?.py || 0), this.ghost.z).project(this.camera);
    if (v.z > 1) return null;
    return { x: ((v.x + 1) / 2) * this.renderer.domElement.clientWidth, y: ((1 - v.y) / 2) * this.renderer.domElement.clientHeight };
  }

  resetRun(seed = (Math.random() * 2 ** 32) >>> 0) {
    this.rand = seeded(seed);
    for (const o of this.obstacles) this.release(o.type, o);
    for (const c of this.coins) this.release('coin', c);
    for (const p of this.pops) this.release('coin', p);
    this.obstacles = [];
    this.coins = [];
    this.pops = [];
    this.trauma = 0;
    this.hitStop = 0;
    this.squash = 0; // + = écrasé (atterrissage), − = étiré (impulsion du saut)
    this.squashV = 0;
    this.coinStreak = 0;
    this.lastCoinAt = -1;
    this.city?.reset(); // chaque partie commence le matin
    this.lane = 0;
    this.px = 0;
    this.py = 0;
    this.vy = 0;
    this.rollLeft = 0;
    this.distance = 0;
    this.coinCount = 0;
    this.lives = this.maxLives || 3;
    this.invincible = 0;
    this.run = 0; // 0 = à l'arrêt, 1 = pleine vitesse
    this.running = false;
    this.pace = 1; // allure demandée par le joueur (1 = normale), voir setPace
    this.speed = 0;
    this.nextRow = 40;
    this.clock = 0; // temps de jeu écoulé
    this.jumpWanted = -1;
    this.runPhase = 0;
  }

  start(seed, lives = 3) {
    this.qT = this.qN = 0;
    this.qSkip = 1; // la 1re tranche de course contient les premiers trains (compilation) : ignorée
    this.maxLives = Math.max(1, Math.min(10, lives | 0));
    this.resetRun(seed);
    this.state = 'play';
  }

  get score() {
    return Math.floor(this.distance) + this.coinCount * 10;
  }

  // ---- Commandes
  setRunning(on) {
    this.running = on;
  }
  // Multiplie la vitesse de course (cadence des sautillements du joueur).
  setPace(p) {
    this.pace = p;
  }
  setLane(l) {
    if (this.state === 'play') this.lane = Math.max(-1, Math.min(1, l));
  }
  moveLane(d) {
    this.setLane(this.lane + d);
  }
  jump() {
    if (this.state !== 'play') return;
    if (this.py > 0.05) {
      // Déjà en l'air : on retient la demande, le saut repartira à l'atterrissage.
      this.jumpWanted = this.clock + 0.3;
      return;
    }
    this.vy = JUMP_V;
    this.rollLeft = 0;
    this.kickSquash(-0.16); // s'étire en décollant
    this.onEvent('jump');
  }
  // Choc vu à l'écran (aussi utilisé en mode spectateur quand l'adversaire se cogne).
  addTrauma(amount) {
    this.trauma = Math.min(1, this.trauma + amount); // les chocs s'additionnent, sans repartir de zéro
  }
  kickSquash(amount) {
    this.squash = amount;
    this.squashV = 0;
  }
  roll() {
    if (this.state !== 'play') return;
    this.rollLeft = ROLL_TIME;
    if (this.py > 0) this.vy = Math.min(this.vy, -12); // en l'air : on redescend vite
    this.onEvent('roll');
  }

  // ---- Réserve d'objets : on cache au lieu de supprimer, on ressort au lieu de recréer.
  release(kind, o) {
    o.mesh.visible = false;
    this.pool[kind].push(o);
  }

  buildObstacle(type) {
    const g = new THREE.Group();
    let len = 0.4;
    const add = (geo, m, x, y, zz = 0) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, zz);
      mesh.castShadow = true;
      g.add(mesh);
    };
    if (ASSETS && type === 'low') {
      const m = ASSETS.barriere.clone();
      m.scale.set(2.1 / 1.56, 1.1, 1);
      const parts = [];
      m.traverse((o) => o.isMesh && parts.push(o)); // d'abord la liste : un contour ajouté serait re-parcouru
      for (const o of parts) {
        o.castShadow = true;
        o.material = toon(0xffffff, { map: o.material.map }); // même texture rayée, ombrage cartoon
        addOutline(o, 0.03);
      }
      g.add(m);
    } else if (ASSETS && type === 'train') {
      len = TRAIN_LEN;
      for (const geo of ASSETS.trains) {
        // Modèle couché sur x : on le tourne dans le sens des voies et on l'étire à 2 × 3,1 × 14 m.
        const size = geo.boundingBox.getSize(new THREE.Vector3());
        const m = new THREE.Mesh(geo, BAKED);
        m.rotation.y = Math.PI / 2;
        m.scale.set(TRAIN_LEN / size.x, 3.1 / size.y, 2.05 / size.z);
        m.castShadow = true;
        addOutline(m, 0.07);
        g.add(m);
      }
      // Phares (enfants ajoutés après les 3 modèles).
      for (const x of [-0.6, 0.6]) add(GEO.headlight, MAT.headlight, x, 0.8, TRAIN_LEN / 2 + 0.03);
    } else if (type === 'low') {
      add(GEO.lowBar, MAT.red, 0, LOW_H - 0.11);
      add(GEO.lowBar, MAT.white, 0, LOW_H - 0.45);
      add(GEO.lowLeg, MAT.dark, -0.9, LOW_H / 2);
      add(GEO.lowLeg, MAT.dark, 0.9, LOW_H / 2);
    } else if (type === 'high') {
      // Portique de chantier à bandes jaunes et noires → « passe dessous ».
      add(GEO.highBar, MAT.stripes, 0, HIGH_Y + 0.45);
      add(GEO.highLeg, MAT.red, -1.0, (HIGH_Y + 0.9) / 2);
      add(GEO.highLeg, MAT.red, 1.0, (HIGH_Y + 0.9) / 2);
      for (const m of g.children) addOutline(m, 0.04);
    } else {
      len = TRAIN_LEN;
      add(GEO.train, MAT.trains[0], 0, 1.65);
      add(GEO.trainStripe, MAT.white, 0, 1.2);
      add(GEO.trainFront, MAT.glass, 0, 2.3, TRAIN_LEN / 2 + 0.01);
    }
    this.scene.add(g);
    return { type, mesh: g, len };
  }

  // ---- Génération des obstacles
  addObstacle(type, lane, z) {
    const o = this.pool[type].pop() || this.buildObstacle(type);
    // Toujours un tirage pour la couleur du train (même ordre qu'avant) : parcours identique
    // chez les deux joueurs.
    if (type === 'train') {
      const k = (this.rand() * MAT.trains.length) | 0;
      if (ASSETS) o.mesh.children.forEach((m, i) => (m.visible = i >= ASSETS.trains.length || i === k % ASSETS.trains.length));
      else o.mesh.children[0].material = MAT.trains[k];
    }
    o.hit = false;
    o.graceUntil = undefined;
    o.mesh.visible = true;
    // z = face avant (côté joueur) de l'obstacle.
    o.mesh.position.set(lane * LANE_W, 0, z - o.len / 2);
    this.obstacles.push(o);
  }

  addCoins(lane, z, n, arc) {
    for (let i = 0; i < n; i++) {
      let c = this.pool.coin.pop();
      if (!c) {
        c = { mesh: new THREE.Mesh(GEO.coin, MAT.coin) };
        this.scene.add(c.mesh);
      }
      c.taken = false;
      c.t = 0;
      c.mesh.visible = true;
      c.mesh.scale.setScalar(1);
      c.mesh.rotation.set(Math.PI / 2, 0, 0);
      const k = n > 1 ? i / (n - 1) : 0.5;
      c.mesh.position.set(lane * LANE_W, arc ? 1.0 + 1.3 * Math.sin(Math.PI * k) : 1.0, z - i * 1.6);
      this.coins.push(c);
    }
  }

  // Range ce qui est passé derrière le joueur ; les pièces ramassées partent « poper ».
  sweep() {
    const out = (o) => o.mesh.position.z - (o.len || 0) / 2 > DESPAWN_Z;
    let n = 0;
    for (const o of this.obstacles) {
      if (out(o)) this.release(o.type, o);
      else this.obstacles[n++] = o;
    }
    this.obstacles.length = n;
    n = 0;
    for (const c of this.coins) {
      if (c.taken) this.pops.push(c);
      else if (out(c)) this.release('coin', c);
      else this.coins[n++] = c;
    }
    this.coins.length = n;
  }

  // La rangée apparaît pile au mètre prévu : on tient compte de ce qu'on a dépassé (over),
  // et la difficulté se calcule sur ce mètre-là. Ainsi le parcours est identique chez les
  // deux joueurs, quelle que soit la fluidité de leur ordinateur.
  spawnRow() {
    const over = Math.max(0, -this.nextRow);
    const at = this.distance - over;
    const z0 = SPAWN_Z + over;
    const level = Math.min(1, at / 900); // 0 = début facile, 1 = difficulté max
    const pick = () => {
      const r = this.rand();
      if (r < 0.34 - 0.14 * level) return 'empty';
      if (r < 0.58) return 'low';
      if (r < 0.78) return 'high';
      return 'train';
    };
    let row = [pick(), pick(), pick()];
    if (row.every((t) => t === 'empty')) row[(this.rand() * 3) | 0] = this.rand() < 0.5 ? 'low' : 'high';
    // Toujours au moins une voie franchissable (sans train).
    if (row.every((t) => t === 'train')) row[(this.rand() * 3) | 0] = 'low';
    // Au début : un seul type d'action demandé à la fois, et toujours une voie libre.
    if (level < 0.15) {
      const first = row.find((t) => t !== 'empty');
      row = row.map((t) => (t === 'empty' ? t : first));
      if (!row.includes('empty')) row[(this.rand() * 3) | 0] = 'empty';
    }
    row.forEach((type, i) => type !== 'empty' && this.addObstacle(type, i - 1, z0));

    // Des pièces sur une voie franchissable.
    const open = [0, 1, 2].filter((i) => row[i] !== 'train');
    const i = open[(this.rand() * open.length) | 0];
    if (row[i] === 'low') this.addCoins(i - 1, z0 + 3.2, 5, true);
    else if (row[i] === 'empty') this.addCoins(i - 1, z0 + 4, 5, false);

    const gapTime = 2.3 - 0.7 * level; // secondes entre deux rangées, à vitesse de course
    this.nextRow = -over + Math.max(this.speedMax(at) * gapTime, 20) + (row.includes('train') ? TRAIN_LEN : 0);
  }

  speedMax(at = this.distance) {
    return 12 + Math.min(12, at / 150);
  }

  // ---- Boucle
  update(dt) {
    this.time = (this.time || 0) + dt;
    this.autoQuality(dt);
    // Mini-gel au choc : le jeu tourne à 5 % pendant hitStop secondes RÉELLES. Le tremblement,
    // lui, continue en temps réel pour ne pas rester figé de travers.
    let simDt = dt;
    if (this.hitStop > 0) {
      this.hitStop = Math.max(0, this.hitStop - dt);
      simDt = dt * 0.05;
    }
    if (this.state === 'play') this.step(simDt);
    this.animate(simDt, dt);
    this.renderer.render(this.scene, this.camera);
  }

  step(dt) {
    this.clock += dt;
    this.run += ((this.running ? this.pace : 0) - this.run) * (1 - Math.exp(-dt / (this.running ? 0.25 : 0.4)));
    this.speed = this.speedMax() * this.run;
    const dz = this.speed * dt;
    this.distance += dz;
    this.scroll += dz;

    this.nextRow -= dz;

    // Joueur
    this.px += (this.lane * LANE_W - this.px) * (1 - Math.exp(-dt / 0.07));
    if (this.py > 0 || this.vy > 0) {
      this.vy -= GRAVITY * dt;
      this.py = Math.max(0, this.py + this.vy * dt);
      if (this.py === 0) {
        if (this.vy < -3) this.kickSquash(0.24 * Math.min(1, -this.vy / 12)); // s'écrase à l'atterrissage
        this.vy = 0;
        if (this.clock < this.jumpWanted) this.jump();
      }
    }
    this.rollLeft = Math.max(0, this.rollLeft - dt);
    this.invincible = Math.max(0, this.invincible - dt);
    const rolling = this.rollLeft > 0;

    for (const o of this.obstacles) {
      o.mesh.position.z += dz;
      if (o.hit || this.invincible > 0) continue;
      const z = o.mesh.position.z;
      const sameLane = Math.abs(o.mesh.position.x - this.px) <= 1.25;
      const touching = sameLane && Math.abs(z) <= o.len / 2 + 0.35;
      let blocked =
        o.type === 'train' || (o.type === 'low' && this.py < LOW_H - 0.4) || (o.type === 'high' && !rolling);
      if (o.type !== 'train') {
        if (o.graceUntil === undefined) {
          // Premier contact : on laisse GRACE secondes pour que l'esquive arrive.
          if (touching && blocked) o.graceUntil = this.clock + GRACE;
          blocked = false;
        } else if (!blocked || !sameLane) {
          o.hit = true; // esquivé de justesse
          blocked = false;
        } else blocked = this.clock >= o.graceUntil;
      } else blocked = touching;
      if (blocked) {
        o.hit = true;
        this.lives--;
        this.invincible = 1.6;
        this.addTrauma(HIT_TRAUMA[o.type]);
        this.me.hitT = 0.4;
        this.hitStop = Math.max(this.hitStop, HIT_STOP[o.type]); // deux chocs : le plus long gagne
        this.onEvent('hit', o.type);
        if (this.lives <= 0) {
          this.state = 'over';
          this.best = Math.max(this.best, this.score);
          localStorage.setItem('subway-sport-best', this.best);
          this.onEvent('over');
        }
      }
    }
    for (const c of this.coins) {
      c.mesh.position.z += dz;
      c.mesh.rotation.z += dt * 5;
      const p = c.mesh.position;
      const bodyY = this.py + (rolling ? 0.5 : 1.1);
      if (!c.taken && Math.abs(p.z) < 0.7 && Math.abs(p.x - this.px) < 0.9 && Math.abs(p.y - bodyY) < 1.1) {
        c.taken = true;
        this.coinCount++;
        // Série de pièces rapprochées : le son monte d'un cran à chaque pièce.
        this.coinStreak = this.clock - this.lastCoinAt < 0.5 ? this.coinStreak + 1 : 0;
        this.lastCoinAt = this.clock;
        this.onEvent('coin', this.coinStreak);
      }
    }
    // Après avoir avancé le reste : une rangée neuve est déjà à sa place exacte.
    if (this.nextRow <= 0) this.spawnRow();
    this.sweep();

    for (const b of this.buildings) {
      b.position.z += dz;
      if (b.position.z - b.userData.d / 2 > DESPAWN_Z + 10) b.position.z -= b.userData.span;
    }
  }

  // ---- Mode spectateur : rejoue la course de l'adversaire sur le même parcours (même graine).
  watchStart(seed, kind) {
    this.resetRun(seed);
    this.state = 'watch';
    this.setCharacter(kind);
  }

  // s = dernier état reçu de l'adversaire (distance prévue, voie, hauteur, roulade…)
  watchTo(s, dt) {
    let dz = Math.max(0, s.dist - this.distance);
    while (dz > 40) {
      // Rattrapage d'un coup en entrant en mode spectateur : le monde se construit mètre par mètre.
      this.advance(1.5, 0);
      dz -= 1.5;
    }
    this.advance(Math.min(dz, Math.max(dz * (1 - Math.exp(-dt / 0.12)), (s.speed || 0) * dt)), dt);
    this.clock += dt;
    this.lane = s.lane;
    this.px += (s.lane * LANE_W - this.px) * (1 - Math.exp(-dt / 0.07));
    this.py += ((s.py || 0) - this.py) * (1 - Math.exp(-dt / 0.05));
    this.rollLeft = s.roll ? 0.1 : 0;
    this.run = s.run || 0;
    this.speed = s.speed || 0;
    this.invincible = s.hurt ? 0.2 : 0;
  }

  // Fait défiler le monde de dz mètres, sans collisions (mode spectateur).
  advance(dz, dt) {
    this.distance += dz;
    this.scroll += dz;
    this.nextRow -= dz;
    for (const o of this.obstacles) o.mesh.position.z += dz;
    for (const c of this.coins) {
      c.mesh.position.z += dz;
      c.mesh.rotation.z += dt * 5;
      const p = c.mesh.position;
      if (Math.abs(p.z) < 0.7 && Math.abs(p.x - this.px) < 0.9 && Math.abs(p.y - this.py - 1.1) < 1.1) c.taken = true;
    }
    if (this.nextRow <= 0) this.spawnRow();
    this.sweep();
    for (const b of this.buildings) {
      b.position.z += dz;
      if (b.position.z - b.userData.d / 2 > DESPAWN_Z + 10) b.position.z -= b.userData.span;
    }
  }

  // dt = temps de jeu (ralenti pendant le mini-gel), realDt = temps réel.
  animate(dt, realDt = dt) {
    // Traverses
    const m = this._m;
    const off = this.scroll % SLEEPER_GAP;
    for (let l = 0; l < 3; l++)
      for (let i = 0; i < N_SLEEPERS; i++) {
        m.setPosition((l - 1) * LANE_W, 0, DESPAWN_Z - i * SLEEPER_GAP + off);
        this.sleepers.setMatrixAt(l * N_SLEEPERS + i, m);
      }
    this.sleepers.instanceMatrix.needsUpdate = true;
    this.city.update(this.scroll, this.px, this.distance);

    // Personnage
    const rolling = this.rollLeft > 0;
    const air = this.py > 0.05;
    this.runPhase += dt * (4 + this.speed * 0.6) * (this.state === 'play' || this.state === 'watch' ? this.run : 0);
    let bob = 0;
    if (this.me.mixer) {
      this.me.hitT = Math.max(0, (this.me.hitT || 0) - dt);
      const want =
        this.state === 'over' ? 'death' : rolling ? 'roll' : this.me.hitT > 0 ? 'hit' : this.run > 0.08 || air ? 'run' : 'idle';
      poseModel(this.me, want, air ? 0.35 : 0.7 + this.speed / 18, dt);
    } else bob = poseCharacter(this.me, this.runPhase, this.run, air, rolling, dt);
    this.player.position.set(this.px, this.py + bob, 0);
    this.player.rotation.z = (this.lane * LANE_W - this.px) * -0.12;
    // Écrasement / étirement : ressort amorti qui dépasse un peu puis revient pile à 1.
    if (this.squash || this.squashV) {
      this.squashV += (-400 * this.squash - 18 * this.squashV) * dt;
      this.squash += this.squashV * dt;
      if (Math.abs(this.squash) < 0.002 && Math.abs(this.squashV) < 0.05) this.squash = this.squashV = 0;
    }
    const sq = this.squash;
    this.player.scale.set(1 + sq * 0.6, 1 - sq, 1 + sq * 0.6);
    const visible = this.invincible <= 0 || Math.floor(this.time * 12) % 2 === 0;
    this.player.visible = visible;
    this.shadow.position.set(this.px, 0.01, 0);
    this.shadow.scale.setScalar(1 / (1 + this.py * 0.5));

    // Fantôme de l'adversaire. Sa distance suit l'écart de score, mais reste
    // toujours visible : à égalité il est un peu devant, s'il mène il s'éloigne.
    const gs = this.ghostState, gh = this.ghost;
    if (gh && gs) {
      gh.px += ((gs.lane ?? 0) * LANE_W - gh.px) * (1 - Math.exp(-dt / 0.08));
      const gap = Math.max(-4, Math.min(14, gs.gap || 0));
      gh.z += (-3.6 - gap * 0.5 - gh.z) * (1 - Math.exp(-dt / 0.3));
      gh.phase += dt * (4 + (gs.speed || 0) * 0.6) * (gs.run || 0);
      let gb = 0;
      if (gh.mixer) {
        const air = gs.py > 0.05;
        const want = gs.alive === false ? 'death' : gs.roll ? 'roll' : (gs.run || 0) > 0.08 || air ? 'run' : 'idle';
        poseModel(gh, want, air ? 0.35 : 0.7 + (gs.speed || 0) / 18, dt);
      } else gb = poseCharacter(gh, gh.phase, gs.run || 0, gs.py > 0.05, !!gs.roll, dt);
      gh.group.position.set(gh.px, (gs.py || 0) + gb, gh.z);
      gh.fade += ((gs.alive === false ? 0.12 : 1) - gh.fade) * (1 - Math.exp(-dt / 0.4));
      const blink = gs.hurt && Math.floor(this.time * 12) % 2 === 0;
      for (const m of gh.mats) m.opacity = (blink ? 0.2 : 0.62) * gh.fade;
      gh.group.visible = true;
    } else if (gh) gh.group.visible = false;

    // Pièces ramassées : elles suivent le joueur, grossissent puis rétrécissent à zéro.
    let n = 0;
    for (const c of this.pops) {
      c.t += realDt;
      const k = c.t / POP_TIME;
      if (k >= 1) {
        this.release('coin', c);
        continue;
      }
      c.mesh.scale.setScalar(k < 0.35 ? 1 + 0.7 * (k / 0.35) : 1.7 * (1 - (k - 0.35) / 0.65));
      c.mesh.position.x += (this.px - c.mesh.position.x) * (1 - Math.exp(-realDt / 0.05));
      c.mesh.position.y += realDt * 4;
      c.mesh.rotation.z += realDt * 25;
      this.pops[n++] = c;
    }
    this.pops.length = n;

    // Caméra : derrière le joueur, suit doucement la voie. Champ un peu plus large quand on va vite.
    const pt = this.portrait || 0;
    const fov = BASE_FOV + 16 * pt + FOV_BOOST * Math.max(0, Math.min(1, (this.speed - 8) / 16));
    if (Math.abs(fov - this.camera.fov) > 0.01) {
      this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-realDt / 0.5));
      this.camera.updateProjectionMatrix();
    }
    // Tremblement : somme de sinus (doux, jamais de « neige » image par image), amplitude trauma².
    this.trauma = Math.max(0, this.trauma - TRAUMA_DECAY * realDt);
    const sh = this.trauma * this.trauma * this.shakeStrength;
    const t = this.time * 30;
    this.camera.position.set(this.px * 0.55 + 0.45 * sh * Math.sin(t * 1.7), 4.0 + 1.4 * pt + this.py * 0.25 + 0.3 * sh * Math.sin(t * 2.3), 6.6 + 2.4 * pt);
    this.camera.lookAt(this.px * 0.75, 1.5 + this.py * 0.2, -9);
    if (sh) this.camera.rotateZ(0.05 * sh * Math.sin(t * 1.1));
  }
}

// ---- Personnages
const SKIN = 0xf2c29b;
const LOOKS = {
  garcon: { shirt: 0xff5a36, pants: 0x2d4b8e, shoe: 0xffffff, hat: 0x1f6feb },
  fille: { shirt: 0xe84393, pants: 0x6c3fc4, shoe: 0xffffff, hair: 0x4a2a16, band: 0xffd21f },
};

// Couleur en niveaux de gris (un peu éclaircie) pour le fantôme.
function grey(hex) {
  const c = new THREE.Color(hex);
  const l = 0.35 + 0.5 * (0.3 * c.r + 0.59 * c.g + 0.11 * c.b);
  return new THREE.Color(l, l, l * 1.04);
}

export function makeCharacter(kind, ghost = false) {
  if (ASSETS) return makeModelCharacter(kind, ghost);
  const look = LOOKS[kind] || LOOKS.garcon;
  const mats = [];
  const m = (color) => {
    const material = ghost
      ? new THREE.MeshLambertMaterial({ color: grey(color), transparent: true, opacity: 0.62, depthWrite: false })
      : mat(color);
    mats.push(material);
    return material;
  };
  const g = new THREE.Group();
  const body = new THREE.Group();
  g.add(body);
  const part = (geo, material, x, y, z, parent = body) => {
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };
  const skin = m(SKIN), shirt = m(look.shirt), pants = m(look.pants), shoe = m(look.shoe);
  part(box(0.62, 0.72, 0.36), shirt, 0, 1.2, 0);
  part(box(0.42, 0.42, 0.42), skin, 0, 1.82, 0);
  if (kind === 'fille') {
    // Cheveux longs, serre-tête, queue de cheval (côté caméra = +z), petite jupe.
    const hair = m(look.hair);
    part(box(0.46, 0.12, 0.46), hair, 0, 2.06, 0);
    part(box(0.46, 0.5, 0.1), hair, 0, 1.8, 0.21);
    part(box(0.08, 0.38, 0.4), hair, -0.23, 1.86, 0.03);
    part(box(0.08, 0.38, 0.4), hair, 0.23, 1.86, 0.03);
    part(box(0.48, 0.06, 0.1), m(look.band), 0, 2.1, -0.12);
    part(box(0.2, 0.5, 0.16), hair, 0, 1.68, 0.32);
    part(box(0.74, 0.22, 0.46), shirt, 0, 0.86, 0);
  } else {
    const hat = m(look.hat);
    part(box(0.46, 0.14, 0.46), hat, 0, 2.06, 0);
    part(box(0.46, 0.06, 0.3), hat, 0, 2.0, -0.3);
  }
  const limb = (x, y, len, material, tip) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    part(box(0.2, len, 0.22), material, 0, -len / 2, 0, pivot);
    if (tip) part(box(0.22, 0.14, 0.34), tip, 0, -len - 0.02, -0.05, pivot);
    body.add(pivot);
    return pivot;
  };
  const c = {
    kind, group: g, body, mats,
    armL: limb(-0.43, 1.52, 0.62, skin),
    armR: limb(0.43, 1.52, 0.62, skin),
    legL: limb(-0.17, 0.84, 0.72, pants, shoe),
    legR: limb(0.17, 0.84, 0.72, pants, shoe),
  };
  if (ghost) g.traverse((o) => o.isMesh && (o.renderOrder = 2));
  else g.traverse((o) => o.isMesh && (o.castShadow = true)); // le fantôme, lui, ne fait pas d'ombre
  return c;
}

// Personnage en modèle animé (Quaternius). Le fantôme = même modèle en gris transparent.
function makeModelCharacter(kind, ghost) {
  const src = ASSETS.chars[kind] || ASSETS.chars.garcon;
  const model = cloneSkinned(src.scene);
  model.rotation.y = Math.PI; // le modèle regarde +z (la caméra) : on lui fait voir la route
  model.scale.setScalar(CHAR_SCALE);
  const g = new THREE.Group();
  g.add(model);
  const mats = [];
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.frustumCulled = false; // la boîte d'un maillage animé ne suit pas ses os
    if (ghost) {
      o.material = [].concat(o.material).map((m) => {
        // Adversaire : ses couleurs, mais transparent (on voit à travers).
        const gm = toon(m.color.getHex(), { transparent: true, opacity: 0.55, depthWrite: false });
        mats.push(gm);
        return gm;
      });
      if (o.material.length === 1) o.material = o.material[0];
      o.renderOrder = 2;
    } else {
      o.castShadow = true;
      // Ombrage cartoon, mêmes couleurs que le modèle.
      o.material = [].concat(o.material).map((m) => toon(m.color.getHex()));
      if (o.material.length === 1) o.material = o.material[0];
    }
  });
  const mixer = new THREE.AnimationMixer(model);
  const clip = (n) => src.animations.find((a) => a.name.endsWith('|' + n));
  const actions = {};
  for (const [k, n] of Object.entries({ idle: 'Idle', run: 'Run', roll: 'Roll', hit: 'HitRecieve', death: 'Death' })) {
    const a = mixer.clipAction(clip(n));
    if (k !== 'idle' && k !== 'run') {
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
    }
    actions[k] = a;
  }
  actions.roll.timeScale = clip('Roll').duration / ROLL_TIME; // la roulade dure le temps du jeu
  return { kind, group: g, mats, mixer, actions, cur: null };
}

// Passe en douceur d'une animation à l'autre (fondu court pour roulade et choc).
function poseModel(c, want, runSpeed, dt) {
  if (c.cur !== want) {
    const next = c.actions[want];
    next.reset().play();
    if (c.curAction) c.curAction.crossFadeTo(next, want === 'roll' || want === 'hit' ? 0.08 : 0.18, false);
    c.cur = want;
    c.curAction = next;
  }
  if (want === 'run') c.curAction.timeScale = runSpeed;
  c.mixer.update(dt);
}

// Pose d'un personnage (course, saut, roulade). Renvoie le petit rebond vertical.
function poseCharacter(c, phase, run, air, rolling, dt) {
  const s = Math.sin(phase), amp = air ? 0.3 : Math.min(1.25, run * 1.2);
  c.legL.rotation.x = air ? -0.9 : s * amp;
  c.legR.rotation.x = air ? 0.5 : -s * amp;
  c.armL.rotation.x = air ? -2.6 : -s * amp;
  c.armR.rotation.x = air ? -2.6 : s * amp;
  const targetScale = rolling ? 0.45 : 1;
  c.body.scale.y += (targetScale - c.body.scale.y) * (1 - Math.exp(-dt / 0.05));
  c.body.rotation.x = rolling ? -0.5 : -0.14 * run; // plus il va vite, plus il se penche
  return air || rolling ? 0 : Math.abs(Math.cos(phase)) * 0.08 * run;
}

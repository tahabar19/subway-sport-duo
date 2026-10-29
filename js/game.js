// Le jeu lui-même : piste à 3 voies, obstacles, pièces, personnage (Three.js).
// Il ne sait rien de la caméra : on le pilote avec setLane / jump / roll / setRunning.
import * as THREE from '../vendor/three.module.js';

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
const mat = (color, opts = {}) => new THREE.MeshLambertMaterial({ color, ...opts });

const GEO = {
  lowBar: box(2.0, 0.22, 0.25),
  lowLeg: box(0.16, LOW_H, 0.2),
  highBar: box(2.1, 0.9, 0.3),
  highLeg: box(0.18, HIGH_Y + 0.9, 0.25),
  train: box(2.0, 3.1, TRAIN_LEN),
  trainFront: box(1.7, 1.0, 0.1),
  trainStripe: box(2.04, 0.35, TRAIN_LEN + 0.02),
  coin: new THREE.CylinderGeometry(0.32, 0.32, 0.08, 16),
};
const MAT = {
  red: mat(0xe5392f),
  white: mat(0xf5f5f5),
  yellow: mat(0xffc400),
  dark: mat(0x2b2f3a),
  glass: mat(0x9fe3ff),
  coin: new THREE.MeshLambertMaterial({ color: 0xffd21f, emissive: 0x7a5200 }),
  trains: [mat(0x2f7de1), mat(0x1fae6b), mat(0xd9552b), mat(0x8a4fd3)],
};

export class Game {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x8fd3ff);
    this.scene.fog = new THREE.Fog(0x8fd3ff, 45, 125);
    this.camera = new THREE.PerspectiveCamera(54, 1, 0.1, 200);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x6b7a8c, 1.9));
    const sun = new THREE.DirectionalLight(0xfff1d6, 1.6);
    sun.position.set(-6, 12, 6);
    this.scene.add(sun);

    this.buildWorld();
    this.buildPlayer();

    this.obstacles = [];
    this.coins = [];
    this.best = Number(localStorage.getItem('subway-sport-best') || 0);
    this.onEvent = () => {}; // 'coin' | 'hit' | 'over' | 'jump' | 'roll'
    this.state = 'idle';
    this.resetRun();
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  buildWorld() {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), mat(0x7fb069));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, -0.06, -100);
    this.scene.add(ground);
    const bed = new THREE.Mesh(new THREE.PlaneGeometry(LANE_W * 3 + 0.8, 400), mat(0x5a5f6b));
    bed.rotation.x = -Math.PI / 2;
    bed.position.set(0, -0.03, -100);
    this.scene.add(bed);

    // Rails (fixes) et traverses (qui défilent).
    const railGeo = box(0.09, 0.1, 400);
    const railMat = mat(0xc9ced6);
    for (let l = -1; l <= 1; l++)
      for (const s of [-0.55, 0.55]) {
        const r = new THREE.Mesh(railGeo, railMat);
        r.position.set(l * LANE_W + s, 0.03, -100);
        this.scene.add(r);
      }
    this.sleepers = new THREE.InstancedMesh(box(1.5, 0.06, 0.35), mat(0x4a3c31), N_SLEEPERS * 3);
    this.scene.add(this.sleepers);
    this.scroll = 0;

    // Immeubles sur les côtés.
    this.buildings = [];
    const colors = [0xf2a65a, 0xe76f51, 0x6a8caf, 0xd9c5a0, 0x9d8189, 0x80b192, 0xf4d35e];
    for (const side of [-1, 1]) {
      let z = DESPAWN_Z;
      while (z > SPAWN_Z - 30) {
        const w = 5 + Math.random() * 4, h = 5 + Math.random() * 13, d = 6 + Math.random() * 7;
        const b = new THREE.Mesh(box(w, h, d), mat(colors[(Math.random() * colors.length) | 0]));
        b.position.set(side * (LANE_W * 1.5 + 4.5 + w / 2), h / 2, z - d / 2);
        b.userData.d = d;
        this.scene.add(b);
        this.buildings.push(b);
        z -= d + 0.6;
      }
      // Longueur totale de la rangée : sert à replacer un immeuble sorti au bout de la file.
      for (const b of this.buildings) b.userData.span ??= DESPAWN_Z - z;
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
    return { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight };
  }

  resetRun(seed = (Math.random() * 2 ** 32) >>> 0) {
    this.rand = seeded(seed);
    for (const o of this.obstacles) this.scene.remove(o.mesh);
    for (const c of this.coins) this.scene.remove(c.mesh);
    this.obstacles = [];
    this.coins = [];
    this.lane = 0;
    this.px = 0;
    this.py = 0;
    this.vy = 0;
    this.rollLeft = 0;
    this.distance = 0;
    this.coinCount = 0;
    this.lives = this.maxLives || 3;
    this.invincible = 0;
    this.shake = 0;
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
    this.onEvent('jump');
  }
  roll() {
    if (this.state !== 'play') return;
    this.rollLeft = ROLL_TIME;
    if (this.py > 0) this.vy = Math.min(this.vy, -12); // en l'air : on redescend vite
    this.onEvent('roll');
  }

  // ---- Génération des obstacles
  addObstacle(type, lane, z) {
    const g = new THREE.Group();
    let len = 0.4;
    const add = (geo, m, x, y, zz = 0) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, zz);
      g.add(mesh);
    };
    if (type === 'low') {
      add(GEO.lowBar, MAT.red, 0, LOW_H - 0.11);
      add(GEO.lowBar, MAT.white, 0, LOW_H - 0.45);
      add(GEO.lowLeg, MAT.dark, -0.9, LOW_H / 2);
      add(GEO.lowLeg, MAT.dark, 0.9, LOW_H / 2);
    } else if (type === 'high') {
      add(GEO.highBar, MAT.yellow, 0, HIGH_Y + 0.45);
      add(GEO.highLeg, MAT.dark, -1.0, (HIGH_Y + 0.9) / 2);
      add(GEO.highLeg, MAT.dark, 1.0, (HIGH_Y + 0.9) / 2);
    } else {
      len = TRAIN_LEN;
      add(GEO.train, MAT.trains[(this.rand() * MAT.trains.length) | 0], 0, 1.65);
      add(GEO.trainStripe, MAT.white, 0, 1.2);
      add(GEO.trainFront, MAT.glass, 0, 2.3, TRAIN_LEN / 2 + 0.01);
    }
    // z = face avant (côté joueur) de l'obstacle.
    g.position.set(lane * LANE_W, 0, z - len / 2);
    this.scene.add(g);
    this.obstacles.push({ type, mesh: g, len, hit: false });
  }

  addCoins(lane, z, n, arc) {
    for (let i = 0; i < n; i++) {
      const mesh = new THREE.Mesh(GEO.coin, MAT.coin);
      mesh.rotation.x = Math.PI / 2;
      const k = n > 1 ? i / (n - 1) : 0.5;
      mesh.position.set(lane * LANE_W, arc ? 1.0 + 1.3 * Math.sin(Math.PI * k) : 1.0, z - i * 1.6);
      this.scene.add(mesh);
      this.coins.push({ mesh });
    }
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
    if (this.state === 'play') this.step(dt);
    this.animate(dt);
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
        this.shake = 0.35;
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
        this.onEvent('coin');
      }
    }
    // Après avoir avancé le reste : une rangée neuve est déjà à sa place exacte.
    if (this.nextRow <= 0) this.spawnRow();
    const gone = (o) => o.mesh.position.z - (o.len || 0) / 2 > DESPAWN_Z || o.taken;
    for (const list of [this.obstacles, this.coins])
      for (const o of list) if (gone(o)) this.scene.remove(o.mesh);
    this.obstacles = this.obstacles.filter((o) => !gone(o));
    this.coins = this.coins.filter((o) => !gone(o));

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
    const gone = (o) => o.mesh.position.z - (o.len || 0) / 2 > DESPAWN_Z || o.taken;
    for (const list of [this.obstacles, this.coins]) for (const o of list) if (gone(o)) this.scene.remove(o.mesh);
    this.obstacles = this.obstacles.filter((o) => !gone(o));
    this.coins = this.coins.filter((o) => !gone(o));
    for (const b of this.buildings) {
      b.position.z += dz;
      if (b.position.z - b.userData.d / 2 > DESPAWN_Z + 10) b.position.z -= b.userData.span;
    }
  }

  animate(dt) {
    // Traverses
    const m = new THREE.Matrix4();
    const off = this.scroll % SLEEPER_GAP;
    for (let l = 0; l < 3; l++)
      for (let i = 0; i < N_SLEEPERS; i++) {
        m.setPosition((l - 1) * LANE_W, 0, DESPAWN_Z - i * SLEEPER_GAP + off);
        this.sleepers.setMatrixAt(l * N_SLEEPERS + i, m);
      }
    this.sleepers.instanceMatrix.needsUpdate = true;

    // Personnage
    const rolling = this.rollLeft > 0;
    const air = this.py > 0.05;
    this.runPhase += dt * (4 + this.speed * 0.6) * (this.state === 'play' || this.state === 'watch' ? this.run : 0);
    const bob = poseCharacter(this.me, this.runPhase, this.run, air, rolling, dt);
    this.player.position.set(this.px, this.py + bob, 0);
    this.player.rotation.z = (this.lane * LANE_W - this.px) * -0.12;
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
      const gb = poseCharacter(gh, gh.phase, gs.run || 0, gs.py > 0.05, !!gs.roll, dt);
      gh.group.position.set(gh.px, (gs.py || 0) + gb, gh.z);
      gh.fade += ((gs.alive === false ? 0.12 : 1) - gh.fade) * (1 - Math.exp(-dt / 0.4));
      const blink = gs.hurt && Math.floor(this.time * 12) % 2 === 0;
      for (const m of gh.mats) m.opacity = (blink ? 0.2 : 0.62) * gh.fade;
      gh.group.visible = true;
    } else if (gh) gh.group.visible = false;

    // Caméra : derrière le joueur, suit doucement la voie.
    this.shake = Math.max(0, this.shake - dt);
    const k = this.shake * 0.6;
    this.camera.position.set(
      this.px * 0.55 + (Math.random() - 0.5) * k,
      4.0 + this.py * 0.25 + (Math.random() - 0.5) * k,
      6.6,
    );
    this.camera.lookAt(this.px * 0.75, 1.5 + this.py * 0.2, -9);
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
  return c;
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

// Détection des mouvements à partir des points du corps (MediaPipe Pose).
// Module pur (pas de DOM) : testable avec node, voir test/motion.test.mjs.
//
// Unités : tout est exprimé en "longueurs de torse" (distance épaules-hanches),
// ce qui rend les seuils indépendants de la distance à la caméra.
//   y > 0 : les hanches sont au-dessus de la position de repos
//   x > 0 : le joueur est à SA droite par rapport à la position calibrée
//
// Les valeurs chiffrées viennent de parties enregistrées (test/bilan.mjs) :
// en sautillant les hanches montent de 0,07 à 0,30 torse (médiane 0,15) ;
// un grand saut monte de 0,22 à 0,7 torse, à 1,7–3,7 torses/s.

export const DEFAULTS = {
  hop: 0.05, // amplitude mini d'un petit saut (fait avancer)
  // Hauteur des hanches qui déclenche un saut. Volontairement bas : les sauts fatigués (0,22–0,28)
  // se confondent avec les gros sautillements, et un saut en trop coûte moins qu'un saut raté.
  jump: 0.24,
  lane: 0.5, // décalage latéral (anticipé, voir LOOKAHEAD) pour changer de voie
  squat: 0.45, // descente des hanches pour un squat
  bend: 0.68, // torse "raccourci" à l'image (on se penche / s'accroupit) : compte comme un squat
  downMode: 'both', // 'pull' (traction), 'squat' ou 'both'
};

const L_SHOULDER = 11, R_SHOULDER = 12, L_WRIST = 15, R_WRIST = 16, L_HIP = 23, R_HIP = 24;
const L_ANKLE = 27, R_ANKLE = 28;

const PULL_HI = 0.75; // poignets nettement au-dessus des épaules : bras tendus en l'air
const PULL_LO = 0.4; // poignets revenus près des épaules : traction faite
const MAX_VX_FOR_JUMP = 0.8; // au-delà, c'est un saut latéral, pas un saut vertical
// Une fois les pieds décollés, la hauteur finale se déduit de la vitesse : apex = y + v²/2g.
// g ≈ 9,81 m/s² pour un torse d'environ 0,5 m. Ça annonce un grand saut avant d'atteindre `jump`.
const GRAVITY = 19.6; // torses/s²
const APEX_FROM = 0.4; // …et on ne s'y fie qu'une fois les hanches montées à 40 % de `jump`
const APEX_MARGIN = 1.25; // l'apex prévu doit dépasser `jump` de 25 %
const LOOKAHEAD = 0.2; // secondes d'anticipation sur le déplacement latéral
const MAX_CENTER_DRIFT = 0.25; // le centre ne se réajuste pas plus loin que ça du centre calibré

const median = (a) => {
  const s = [...a].sort((p, q) => p - q);
  return s[s.length >> 1];
};
const range = (a) => Math.max(...a) - Math.min(...a);
const ease = (dt, tau) => 1 - Math.exp(-dt / tau);

export class MotionDetector {
  constructor(cfg = {}) {
    this.cfg = { ...DEFAULTS, ...cfg };
    this.calibrated = false;
    this.samples = [];
    this.reset();
  }

  reset() {
    this.t = null;
    this.sx = this.sy = null;
    this.x = this.y = this.vx = this.vy = 0;
    this.p = 0;
    this.T = 1; // longueur du torse à l'image / longueur calibrée
    this.lane = 0;
    this.hopUp = false;
    this.trough = 0;
    this.peak = 0;
    this.jumpReady = true;
    this.jumpBlockUntil = 0;
    this.standUntil = 0;
    this.armTime = 0;
    this.pullArmed = false;
    this.squatTime = 0;
    this.squatReady = true;
    this.squatSince = 0;
    this.stillTime = 0;
    // Surveillance d'une calibration devenue fausse (voir checkCalibration).
    this.offScale = { time: 0, ratios: [] };
    this.highTime = 0;
    this.lowTime = 0;
    this.groundY = null;
    // Activité des pieds : vitesse verticale moyenne des chevilles (torses/s), lissée sur ~1 s.
    // Mesuré en jeu : 0,17 en sautillant doucement, 0,31 en rythme normal, 0,67 à fond
    // (la cadence, elle, reste autour de 2,5 sauts/s quelle que soit l'intensité).
    this.feet = 0;
    this.ankles = null;
  }

  // Extrait les mesures brutes d'une image. aspect = largeur/hauteur de la vidéo.
  measure(lm, aspect) {
    if (!lm) return null;
    const core = [L_SHOULDER, R_SHOULDER, L_HIP, R_HIP];
    if (core.some((i) => (lm[i].visibility ?? 1) < 0.5)) return null;
    // Image retournée (effet miroir) : la droite du joueur est à droite.
    const X = (i) => (1 - lm[i].x) * aspect;
    const Y = (i) => lm[i].y;
    const shX = (X(L_SHOULDER) + X(R_SHOULDER)) / 2, shY = (Y(L_SHOULDER) + Y(R_SHOULDER)) / 2;
    const hipX = (X(L_HIP) + X(R_HIP)) / 2, hipY = (Y(L_HIP) + Y(R_HIP)) / 2;
    const torso = Math.hypot(shX - hipX, shY - hipY);
    if (torso < 0.03) return null;
    const wristsOk = (lm[L_WRIST].visibility ?? 1) > 0.4 && (lm[R_WRIST].visibility ?? 1) > 0.4;
    // Hauteur moyenne des poignets au-dessus des épaules (en image, y vers le bas).
    const wristUp = wristsOk
      ? (Y(L_SHOULDER) - Y(L_WRIST) + Y(R_SHOULDER) - Y(R_WRIST)) / 2
      : -Infinity;
    // (une cheville "devinée" hors de l'image ne compte pas)
    const anklesOk = [L_ANKLE, R_ANKLE].every((i) => (lm[i].visibility ?? 1) > 0.5 && Y(i) < 1);
    return { hipX, hipY, torso, wristUp, ankles: anklesOk ? [Y(L_ANKLE), Y(R_ANKLE)] : null };
  }

  // Bras levés (geste pour démarrer) : ne dépend pas de la calibration.
  static handsUp(m) {
    return !!m && m.wristUp / m.torso > PULL_HI;
  }

  // Le joueur est-il en train de se déplacer entre deux mesures espacées de dt secondes ?
  // (on ne calibre pas quelqu'un qui recule encore vers sa place)
  static moving(a, b, dt) {
    if (!a || !b || dt <= 0) return true;
    const speed = Math.hypot(b.hipX - a.hipX, b.hipY - a.hipY) / b.torso / dt;
    const zoom = Math.abs(b.torso - a.torso) / b.torso / dt;
    return speed > 0.5 || zoom > 0.4;
  }

  startCalibration() {
    this.samples = [];
    this.calibrated = false;
  }

  addCalibrationSample(m) {
    if (m) this.samples.push(m);
  }

  finishCalibration() {
    const s = this.samples;
    if (s.length < 5) return false;
    const torso = median(s.map((q) => q.torso));
    // Mesures trop dispersées : le joueur a bougé, on recommence.
    if (range(s.map((q) => q.torso)) > 0.2 * torso) return false;
    if (range(s.map((q) => q.hipX)) > 0.3 * torso || range(s.map((q) => q.hipY)) > 0.3 * torso) return false;
    this.baseX = this.centerX = median(s.map((q) => q.hipX));
    this.baseY = median(s.map((q) => q.hipY));
    this.torso = torso;
    this.calibrated = true;
    this.reset();
    return true;
  }

  // Repart de la posture actuelle comme nouvelle référence (calibration devenue fausse).
  // scale : facteur à appliquer à la longueur de torse de référence (0 = inchangée).
  rebase(m, events, scale = 0) {
    if (scale) this.torso *= scale;
    this.baseY = scale ? this.sy : this.groundY;
    const keep = { t: this.t, sx: this.sx, sy: this.sy, lane: this.lane, groundY: this.sy, feet: this.feet, ankles: this.ankles };
    this.reset();
    Object.assign(this, keep);
  }

  // La calibration peut devenir fausse : calibré trop près puis reculé, caméra déplacée…
  // Sans ça, le joueur paraît en permanence "en l'air" ou "accroupi" et plus rien ne répond.
  checkCalibration(m, y, dt, events) {
    // 1. Échelle : le torse mesuré reste durablement très différent du torse calibré,
    //    3 s d'affilée (accroupi, on sort du suivi bien avant).
    const ratio = m.torso / this.torso, o = this.offScale;
    if (ratio < 0.7 || ratio > 1.3) {
      if (!o.time) o.ratios = [];
      o.ratios.push(ratio);
      o.time += dt;
      if (o.time > 3) return this.rebase(m, events, median(o.ratios)), true;
    } else o.time = 0;

    // 2. Hauteur de repos : personne ne reste plus d'une seconde au-dessus de la hauteur de saut.
    //    groundY suit le point le plus bas atteint récemment par les hanches (y image vers le bas).
    this.groundY = this.groundY === null ? this.sy : Math.max(this.sy, this.groundY - 0.3 * this.torso * dt);
    this.highTime = y > this.cfg.jump ? this.highTime + dt : 0;
    if (this.highTime > 1.2) return this.rebase(m, events), true;

    // 3. …ni debout (torse non replié) nettement sous sa hauteur de repos pendant 2 s.
    this.lowTime = y < -0.25 && ratio > 0.8 ? this.lowTime + dt : 0;
    if (this.lowTime > 2) {
      this.groundY = this.sy;
      return this.rebase(m, events), true;
    }
    return false;
  }

  updateFeet(m, dt) {
    if (!m.ankles) return void (this.ankles = null); // chevilles cachées : on garde la dernière valeur
    if (!this.ankles || dt === 0) return void (this.ankles = [...m.ankles]);
    // Chevilles lissées (~60 ms) avant de mesurer leur vitesse : leur suivi tremble un peu.
    const a = ease(dt, 0.06);
    let speed = 0;
    for (const i of [0, 1]) {
      const before = this.ankles[i];
      this.ankles[i] += (m.ankles[i] - before) * a;
      speed += Math.abs(this.ankles[i] - before) / this.torso / dt / 2;
    }
    // Plafonné : un grand saut ne doit pas compter comme dix sautillements.
    this.feet += (Math.min(speed, 1.5) - this.feet) * ease(dt, 0.8);
  }

  // m : résultat de measure() (ou null si corps non visible), t : temps en secondes.
  // Renvoie la liste des événements : {type:'hop'|'jump'|'down'} ou {type:'lane', lane:-1|0|1}.
  update(m, t) {
    const events = [];
    if (!this.calibrated || !m) {
      this.t = null;
      this.offScale.time = 0;
      this.feet *= 0.97; // corps perdu : l'allure retombe en quelques secondes
      this.ankles = null;
      return events;
    }
    const c = this.cfg;
    const dt = this.t === null ? 0 : Math.min(t - this.t, 0.2);
    this.t = t;

    // Lissage très léger (~25 ms) : le suivi est peu bruité, et chaque ms de retard se sent en jeu.
    if (this.sx === null || dt === 0) {
      this.sx = m.hipX;
      this.sy = m.hipY;
      this.T = m.torso / this.torso;
    } else {
      const a = ease(dt, 0.025);
      this.sx += (m.hipX - this.sx) * a;
      this.sy += (m.hipY - this.sy) * a;
      this.T += (m.torso / this.torso - this.T) * a;
    }
    this.updateFeet(m, dt);
    if (this.checkCalibration(m, (this.baseY - this.sy) / this.torso, dt, events)) return events;

    const x = (this.sx - this.baseX) / this.torso;
    const y = (this.baseY - this.sy) / this.torso;
    if (dt > 0) {
      const b = ease(dt, 0.04);
      this.vx += ((x - this.x) / dt - this.vx) * b;
      this.vy += ((y - this.y) / dt - this.vy) * b;
    } else {
      this.trough = this.peak = y;
    }
    this.x = x;
    this.y = y;
    this.p = m.wristUp / this.torso;

    // --- Voie : zones absolues autour de la position calibrée, avec hystérésis.
    // On regarde où le joueur sera dans 0,2 s (position + vitesse) : sinon le changement
    // de voie n'arrive qu'à la fin du saut latéral, ~0,4 s trop tard.
    const L = c.lane, H = c.lane * 0.25;
    const xp = x + this.vx * LOOKAHEAD;
    // Pour entrer dans une voie de côté, il faut déjà être un peu de ce côté : sinon un
    // retour rapide vers le centre serait "prolongé" jusqu'à la voie opposée.
    const right = xp > L && x > 0.15, left = xp < -L && x < -0.15;
    let lane = this.lane;
    if (lane === 0) {
      if (right) lane = 1;
      else if (left) lane = -1;
    } else if (lane === 1) {
      if (left) lane = -1;
      else if (xp < L - H) lane = 0;
    } else {
      if (right) lane = 1;
      else if (xp > -L + H) lane = 0;
    }
    if (lane !== this.lane) {
      this.lane = lane;
      events.push({ type: 'lane', lane });
    }

    // --- Petits sauts : on détecte une montée d'au moins `hop` depuis le dernier creux.
    if (!this.hopUp) {
      this.trough = Math.min(this.trough, y);
      // Le creux "oublie" lentement, pour suivre une dérive de la posture.
      this.trough += (y - this.trough) * ease(dt, 0.8);
      if (y - this.trough > c.hop && this.vy > 0) {
        this.hopUp = true;
        this.peak = y;
        events.push({ type: 'hop' });
      }
    } else {
      this.peak = Math.max(this.peak, y);
      if (this.peak - y > c.hop * 0.6) {
        this.hopUp = false;
        this.trough = y;
      }
    }

    // --- Traction : bras tendus au-dessus de la tête, puis on tire (les poignets
    // reviennent au niveau des épaules, que ce soit les mains qui descendent
    // ou le corps qui monte à la barre).
    const pullOn = c.downMode !== 'squat';
    if (pullOn && !this.pullArmed) {
      this.armTime = this.p > PULL_HI && y < c.jump * 0.6 ? this.armTime + dt : 0;
      if (this.armTime > 0.2) this.pullArmed = true;
    } else if (pullOn && this.p < PULL_LO) {
      this.pullArmed = false;
      this.armTime = 0;
      if (Number.isFinite(this.p)) {
        events.push({ type: 'down' });
        // Une vraie traction fait monter les hanches : ce n'est pas un saut.
        this.jumpReady = false;
        this.jumpBlockUntil = t + 0.6;
      }
    }
    if (!pullOn) this.pullArmed = false;

    // --- Saut : les hanches dépassent nettement la position de repos, ou y montent très vite.
    // L'anticipation par la vitesse est coupée quand on se relève d'un accroupissement
    // (montée rapide qui n'est pas un saut) ; un vrai saut enchaîné passe par le seuil `jump`.
    if (this.T < 0.75 || !this.squatReady) this.standUntil = t + 0.4;
    const apex = y + (this.vy * this.vy) / (2 * GRAVITY);
    const early = t >= this.standUntil && y > c.jump * APEX_FROM && apex > c.jump * APEX_MARGIN;
    if (this.jumpReady && (y > c.jump || early) && this.vy > 0) {
      this.jumpReady = false;
      const lateral = Math.abs(this.vx) > MAX_VX_FOR_JUMP;
      if (!this.pullArmed && !lateral && t >= this.jumpBlockUntil) events.push({ type: 'jump' });
    } else if (!this.jumpReady && y < c.jump * 0.4) {
      this.jumpReady = true;
    }

    // --- Squat : les hanches descendent franchement, ou le torse se replie (on se penche
    // en s'accroupissant : c'est le signe le plus précoce, avant que les hanches ne bougent).
    if (c.downMode !== 'pull') {
      this.squatTime = y < -c.squat ? this.squatTime + dt : 0;
      if (this.squatReady && (this.squatTime > 0.1 || this.T < c.bend)) {
        this.squatReady = false;
        this.squatSince = t;
        events.push({ type: 'down' });
      } else if (!this.squatReady && ((y > -c.squat * 0.5 && this.T > 0.8) || t - this.squatSince > 2.5)) {
        // (le délai évite de rester "accroupi" pour toujours si la posture de référence a changé)
        this.squatReady = true;
      }
    }

    // --- Réajustements lents de la référence, quand le joueur est debout (torse non replié).
    const upright = this.T > 0.8 && !this.pullArmed;
    // Hauteur de repos : quand il est immobile.
    const still = Math.abs(this.vy) < 0.25 && Math.abs(y) < 0.2 && upright;
    this.stillTime = still ? this.stillTime + dt : 0;
    if (this.stillTime > 0.5) this.baseY += (this.sy - this.baseY) * ease(dt, 1.0);
    // Échelle : le torse apparent change un peu si le joueur avance ou recule.
    const ratio = m.torso / this.torso;
    if (ratio > 0.7 && ratio < 1.3 && this.squatReady) this.torso += (m.torso - this.torso) * ease(dt, 5);
    // Centre : quand il joue sur la voie du milieu sans se déplacer, borné autour du centre calibré.
    if (upright && this.lane === 0 && Math.abs(x) < 0.3 && Math.abs(this.vx) < 0.3) {
      const target = this.baseX + (this.sx - this.baseX) * ease(dt, 4);
      const lim = MAX_CENTER_DRIFT * this.torso;
      this.baseX = Math.min(this.centerX + lim, Math.max(this.centerX - lim, target));
    }

    return events;
  }
}

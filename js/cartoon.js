// Décor « cartoon coloré » : ombrage en aplats (toon), contours noirs, immeubles aux couleurs vives,
// murs à graffitis le long des voies, trottoirs, arbres, lampadaires, nuages.
// Cycle de la journée selon la distance (identique chez les deux joueurs) :
// matin → après-midi → coucher de soleil → nuit (fenêtres et lampadaires s'allument).
import * as THREE from '../vendor/three.module.js';
import { mergeGeometries } from '../vendor/addons/utils/BufferGeometryUtils.js';

// ---- Ombrage cartoon : 3 tons nets au lieu d'un dégradé.
export const TOON = (() => {
  const t = new THREE.DataTexture(new Uint8Array([90, 90, 90, 255, 175, 175, 175, 255, 255, 255, 255, 255]), 3, 1);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
})();
export const toon = (color, o = {}) => new THREE.MeshToonMaterial({ color, gradientMap: TOON, ...o });

// Contour noir « dessin animé » : copie du maillage, retournée et un peu plus grosse.
// Un seul matériau partagé : OUTLINE.visible = false les coupe tous (qualité basse).
export const OUTLINE = new THREE.MeshBasicMaterial({ color: 0x1a1420, side: THREE.BackSide });
export function addOutline(mesh, t = 0.06) {
  const g = mesh.geometry;
  if (!g.boundingBox) g.computeBoundingBox();
  const s = g.boundingBox.getSize(new THREE.Vector3());
  const ps = mesh.scale; // épaisseur à peu près constante même si le parent est étiré
  const o = new THREE.Mesh(g, OUTLINE);
  o.scale.set(1 + (2 * t) / (s.x * ps.x || 1), 1 + (2 * t) / (s.y * ps.y || 1), 1 + (2 * t) / (s.z * ps.z || 1));
  o.raycast = () => {};
  mesh.add(o);
  return o;
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}
const tex = (c, srgb = true) => {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
};

// Façade : murs blancs (teintés par la couleur du matériau), fenêtres bleues à cadre blanc avec un
// reflet en biais. Deuxième texture : les fenêtres allumées la nuit.
function facadeTextures() {
  const COLS = 8, ROWS = 16, CW = 48, CH = 64;
  const [c, g] = canvas(COLS * CW, ROWS * CH);
  const [e, ge] = canvas(COLS * CW, ROWS * CH);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  ge.fillStyle = '#000000';
  ge.fillRect(0, 0, e.width, e.height);
  for (let y = 0; y < ROWS; y++) {
    // bandeau entre les étages
    g.fillStyle = '#e4e0ea';
    g.fillRect(0, y * CH + CH - 6, c.width, 6);
    for (let x = 0; x < COLS; x++) {
      const X = x * CW + 10, Y = y * CH + 12, W = CW - 20, H = CH - 26;
      g.fillStyle = '#f7f7f7';
      g.fillRect(X - 4, Y - 4, W + 8, H + 8);
      g.fillStyle = '#4f86c6';
      g.fillRect(X, Y, W, H);
      g.fillStyle = 'rgba(255,255,255,0.55)';
      g.beginPath();
      g.moveTo(X + 4, Y + H - 4);
      g.lineTo(X + W * 0.55, Y + 4);
      g.lineTo(X + W * 0.75, Y + 4);
      g.lineTo(X + W * 0.25, Y + H - 4);
      g.fill();
      if (Math.random() < 0.55) {
        ge.fillStyle = Math.random() < 0.8 ? '#ffc65a' : '#ffe9a8';
        ge.fillRect(X, Y, W, H);
      }
    }
  }
  return { map: tex(c), emissive: tex(e), cols: COLS, rows: ROWS };
}

// Graffitis (mots inventés, lettres gonflées avec contour) sur un mur de béton.
const TAGS = ['GO!', 'RUN', 'DUO', 'YO!', 'WOW', 'JUMP', 'COOL', 'SPORT', 'FAST', 'TOP'];
const SPRAY = ['#ff4d6d', '#ffbe0b', '#3a86ff', '#8338ec', '#06d6a0', '#fb5607', '#ff006e'];
function graffiti(i) {
  const [c, g] = canvas(768, 128);
  g.fillStyle = '#cfc8bd';
  g.fillRect(0, 0, 768, 128);
  g.fillStyle = 'rgba(0,0,0,0.06)';
  for (let k = 0; k < 6; k++) g.fillRect(k * 128, 0, 3, 128); // joints du béton
  const pick = (k) => SPRAY[(i * 3 + k) % SPRAY.length];
  // 2 graffitis par mur
  for (let k = 0; k < 2; k++) {
    const word = TAGS[(i * 2 + k) % TAGS.length];
    const cx = 190 + k * 390, cy = 66;
    g.save();
    g.translate(cx, cy);
    g.rotate((k ? 1 : -1) * 0.06);
    // nuage de fond
    g.fillStyle = pick(k + 2);
    g.beginPath();
    g.ellipse(0, 0, 165, 50, 0, 0, Math.PI * 2);
    g.fill();
    g.font = '900 78px Impact, "Arial Black", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = 16;
    g.strokeStyle = '#1a1420';
    g.strokeText(word, 0, 4, 300);
    const gr = g.createLinearGradient(0, -36, 0, 36);
    gr.addColorStop(0, '#ffffff');
    gr.addColorStop(0.45, pick(k));
    gr.addColorStop(1, pick(k + 1));
    g.fillStyle = gr;
    g.fillText(word, 0, 4, 300);
    g.restore();
  }
  return tex(c);
}

function gravelTexture() {
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#9b9488';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1400; i++) {
    const v = 120 + Math.random() * 90;
    g.fillStyle = `rgb(${v},${v - 6},${v - 14})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 3 + Math.random() * 4, 3 + Math.random() * 4);
  }
  return tex(c);
}

// Géométrie colorée par sommets à partir de pièces [geometry, couleur] (un seul appel de dessin).
function colored(parts) {
  return mergeGeometries(
    parts.map(([geo, color]) => {
      const g = geo.index ? geo.toNonIndexed() : geo;
      const c = new THREE.Color(color), n = g.attributes.position.count, a = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(a, 3));
      g.deleteAttribute('uv');
      return g;
    }),
  );
}

// ---- Moments de la journée (la distance en mètres décide).
const PHASES = [
  // d, ciel haut, horizon, soleil (couleur, force), ciel/sol (hémisphère, force), fenêtres, exposition, nom
  { d: 0, top: 0x7ec8ff, low: 0xffd9b8, sun: 0xffd6a8, sunI: 2.3, hs: 0xcfe6ff, hg: 0x8c7a63, hI: 1.2, win: 0, exp: 1.05, name: 'matin', sunY: 14 },
  { d: 900, top: 0x3b9dff, low: 0xc6ecff, sun: 0xffffff, sunI: 3.0, hs: 0xd8efff, hg: 0x7d8a5c, hI: 1.35, win: 0, exp: 1.05, name: 'après-midi', sunY: 60 },
  { d: 1900, top: 0x5a63c9, low: 0xffa45c, sun: 0xff9a52, sunI: 2.2, hs: 0xffc9a0, hg: 0x6b4f5e, hI: 1.0, win: 0.4, exp: 1.05, name: 'coucher de soleil', sunY: 6 },
  { d: 2500, top: 0x0f1a4a, low: 0x30478f, sun: 0x9fb4ff, sunI: 0.6, hs: 0x6f86d6, hg: 0x2a2440, hI: 0.55, win: 1, exp: 1.15, name: 'nuit', sunY: 45 },
];
const lerpC = (a, b, t, out) => out.set(a).lerp(new THREE.Color(b), t);

export function buildCartoonCity(game, { LANE_W, DESPAWN_Z, SPAWN_Z }) {
  const scene = game.scene;
  scene.fog = new THREE.Fog(0xc6ecff, 60, 150);
  scene.background = new THREE.Color(0xc6ecff);
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const EDGE = LANE_W * 1.5 + 0.45; // bord du ballast
  const WALL_X = EDGE + 0.35;
  const WALK_W = 4.2; // trottoir entre le mur et les immeubles
  const LEN = DESPAWN_Z - SPAWN_Z + 30;

  // Ciel : dôme en dégradé (couleurs mises à jour par le cycle), soleil/lune, nuages.
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { top: { value: new THREE.Color() }, low: { value: new THREE.Color() } },
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader:
      'uniform vec3 top; uniform vec3 low; varying vec3 vP; void main(){ float h = smoothstep(-0.05, 0.55, vP.y); gl_FragColor = vec4(mix(low, top, h), 1.0); }',
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(135, 32, 16), skyMat); // reste dans le champ de la caméra (200 m)
  sky.position.set(0, 0, -40);
  scene.add(sky);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(7, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }));
  scene.add(disc);
  const cloudGeo = colored(
    [[-2.2, 0, 0, 2.4], [0, 0.9, 0, 3.1], [2.4, 0.2, 0, 2.5], [0.8, -0.4, 1, 2.2], [-0.9, -0.3, -1, 2]].map(([x, y, z, r]) => [
      new THREE.IcosahedronGeometry(r, 1).translate(x, y, z),
      0xffffff,
    ]),
  );
  const cloudMat = toon(0xffffff, { vertexColors: true, fog: false });
  for (let i = 0; i < 9; i++) {
    const c = new THREE.Mesh(cloudGeo, cloudMat);
    const side = i % 2 ? 1 : -1;
    c.position.set(side * (25 + Math.random() * 60), 28 + Math.random() * 22, -40 - Math.random() * 100);
    c.scale.setScalar(1.2 + Math.random() * 1.4);
    c.rotation.y = Math.random() * 3;
    scene.add(c);
  }

  // Sol : herbe, ballast en cailloux, rails.
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), toon(0x7ccf5a));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, -0.06, -100);
  ground.receiveShadow = true;
  scene.add(ground);
  const gravel = gravelTexture();
  gravel.repeat.set(3, 120);
  const bed = new THREE.Mesh(new THREE.PlaneGeometry(EDGE * 2, 400), toon(0xffffff, { map: gravel }));
  bed.rotation.x = -Math.PI / 2;
  bed.position.set(0, -0.03, -100);
  bed.receiveShadow = true;
  scene.add(bed);
  game.gravel = gravel; // défile avec le monde
  const railMat = toon(0xb9c0cc);
  for (let l = -1; l <= 1; l++)
    for (const s of [-0.55, 0.55]) {
      const r = new THREE.Mesh(box(0.11, 0.14, 400), railMat);
      r.position.set(l * LANE_W + s, 0.05, -100);
      scene.add(r);
    }

  // Trottoirs (bordure claire).
  for (const side of [-1, 1]) {
    const w = new THREE.Mesh(box(WALK_W + 0.4, 0.22, 400), toon(0xd8d2c8));
    w.position.set(side * (WALL_X + WALK_W / 2), 0.11, -100);
    w.receiveShadow = true;
    scene.add(w);
  }

  // Murs à graffitis le long des voies (segments qui défilent avec les immeubles).
  const rows = [];
  const tags = Array.from({ length: 8 }, (_, i) => toon(0xffffff, { map: graffiti(i) }));
  const capMat = toon(0xa9a196);
  const wallGeo = new THREE.PlaneGeometry(12, 1.5);
  const capGeo = box(12, 0.14, 0.42); // dans le repère du panneau (tourné)
  const walls = [];
  for (const side of [-1, 1]) {
    let z = DESPAWN_Z, k = side > 0 ? 3 : 0;
    while (z > SPAWN_Z - 30) {
      // Un seul panneau tourné vers les voies (on ne voit jamais l'arrière) + chaperon en béton.
      const wl = new THREE.Mesh(wallGeo, tags[k++ % tags.length]);
      wl.rotation.y = side < 0 ? Math.PI / 2 : -Math.PI / 2;
      wl.position.set(side * WALL_X, 0.75, z - 6);
      wl.receiveShadow = true;
      const cap = new THREE.Mesh(capGeo, capMat);
      cap.position.set(0, 0.8, -0.1);
      wl.add(cap);
      wl.userData.d = 12;
      scene.add(wl);
      walls.push(wl);
      z -= 12;
    }
    for (const w of walls) w.userData.span ??= DESPAWN_Z - z;
  }
  rows.push(...walls);

  // Immeubles colorés : façade à fenêtres + corniche, toit, et parfois auvent, château d'eau, clim.
  const fac = facadeTextures();
  const COLORS = [0xff8a5c, 0xffc93c, 0x4ecdc4, 0xff6b9a, 0x9b7bff, 0x6bcB77, 0xf25f5c, 0x5ab0ff, 0xffa94d];
  const facades = COLORS.map((c) => toon(c, { map: fac.map, emissiveMap: fac.emissive, emissive: 0xffffff, emissiveIntensity: 0 }));
  const detailMat = toon(0xffffff, { vertexColors: true });
  const CELL_W = 2.2, CELL_H = 3.0;
  const buildings = [];
  for (const side of [-1, 1]) {
    let z = DESPAWN_Z;
    const startLen = buildings.length;
    while (z > SPAWN_Z - 30) {
      const w = 7 + Math.random() * 4, d = 9 + Math.random() * 8, h = 9 + Math.random() * 16;
      const geo = box(w, h, d);
      const uv = geo.attributes.uv;
      const ou = ((Math.random() * fac.cols) | 0) / fac.cols, ov = ((Math.random() * fac.rows) | 0) / fac.rows;
      const faces = [d, d, w, w, w, w];
      for (let f = 0; f < 6; f++)
        for (let k = 0; k < 4; k++) {
          const i = f * 4 + k;
          if (f === 2 || f === 3) uv.setXY(i, 0.002, 0.002);
          else uv.setXY(i, ou + (uv.getX(i) * faces[f]) / CELL_W / fac.cols, ov + (uv.getY(i) * h) / CELL_H / fac.rows);
        }
      const color = (Math.random() * COLORS.length) | 0;
      const b = new THREE.Mesh(geo, facades[color]);
      b.position.set(side * (WALL_X + WALK_W + 0.3 + w / 2), h / 2, z - d / 2);
      b.castShadow = false;
      addOutline(b, 0.08);
      // Détails fusionnés en un seul maillage coloré.
      const face = -side * (w / 2);
      const parts = [
        [box(w + 0.5, 0.6, d + 0.5).translate(0, h / 2 + 0.3, 0), 0xf3efe6], // corniche
        [box(w - 0.4, 0.25, d - 0.4).translate(0, h / 2 + 0.62, 0), 0x8d8a99], // toit
      ];
      if (Math.random() < 0.7) {
        // auvent rayé au rez-de-chaussée, côté voies
        const stripe = [0xffffff, SPRAY_HEX[(Math.random() * SPRAY_HEX.length) | 0]];
        for (let s = 0; s < 5; s++)
          parts.push([box(1.4, 0.18, d / 5 - 0.02).rotateZ(side * 0.35).translate(face - side * 0.7, -h / 2 + 3.1, -d / 2 + d / 10 + (s * d) / 5), stripe[s % 2]]);
      }
      if (Math.random() < 0.45) {
        // château d'eau en bois
        const tx = (Math.random() - 0.5) * (w - 3), tz = (Math.random() - 0.5) * (d - 3);
        parts.push([new THREE.CylinderGeometry(1, 1, 1.8, 10).translate(tx, h / 2 + 2.3, tz), 0x9a6b44]);
        parts.push([new THREE.ConeGeometry(1.15, 0.9, 10).translate(tx, h / 2 + 3.65, tz), 0x6e4a33]);
        for (const [lx, lz] of [[-0.6, -0.6], [0.6, 0.6], [-0.6, 0.6], [0.6, -0.6]])
          parts.push([box(0.12, 1.2, 0.12).translate(tx + lx, h / 2 + 1.2, tz + lz), 0x4a3a30]);
      } else if (Math.random() < 0.6) {
        parts.push([box(1.6, 0.9, 1.2).translate((Math.random() - 0.5) * (w - 3), h / 2 + 1.2, (Math.random() - 0.5) * (d - 3)), 0xc9ced6]); // clim
      }
      b.add(new THREE.Mesh(colored(parts), detailMat)); // pièces déjà placées par rapport au centre
      b.userData.d = d;
      scene.add(b);
      buildings.push(b);
      z -= d + 0.4;
    }
    for (let i = startLen; i < buildings.length; i++) buildings[i].userData.span = DESPAWN_Z - z;
  }
  rows.push(...buildings);

  // Arbres et lampadaires sur les trottoirs (défilent comme les traverses).
  const TREE_GAP = 18;
  const n = Math.ceil(LEN / TREE_GAP) + 1;
  const treeGeo = colored([
    [new THREE.CylinderGeometry(0.18, 0.25, 2, 7).translate(0, 1, 0), 0x8a5a3b],
    [new THREE.IcosahedronGeometry(1.5, 0).translate(0, 3, 0), 0x3fae49],
    [new THREE.IcosahedronGeometry(1.1, 0).translate(0.6, 3.9, 0.3), 0x5cc957],
    [new THREE.IcosahedronGeometry(0.9, 0).translate(-0.7, 3.6, -0.2), 0x37a043],
  ]);
  const trees = new THREE.InstancedMesh(treeGeo, toon(0xffffff, { vertexColors: true }), n * 2);
  trees.castShadow = true;
  const lampGeo = colored([
    [box(0.16, 4.6, 0.16).translate(0, 2.3, 0), 0x2f3542],
    [box(1.1, 0.12, 0.14).translate(-0.5, 4.55, 0), 0x2f3542],
  ]);
  const lamps = new THREE.InstancedMesh(lampGeo, toon(0xffffff, { vertexColors: true }), n * 2);
  const bulbMat = toon(0xfff2c2, { emissive: 0xffd36b, emissiveIntensity: 0 });
  const bulbs = new THREE.InstancedMesh(box(0.5, 0.16, 0.3), bulbMat, n * 2);
  for (const m of [trees, lamps, bulbs]) scene.add(m);

  // Lumière : ciel/sol + lampe douce qui suit le joueur la nuit (game.sun = soleil/lune).
  const hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 1.2);
  scene.add(hemi);
  const follow = new THREE.PointLight(0xfff0d0, 0, 14, 2);
  scene.add(follow);

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s1 = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
  const flip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  const c1 = new THREE.Color(), c2 = new THREE.Color();
  let phaseName = '';

  // Applique le moment de la journée pour la distance donnée.
  function daytime(dist) {
    let i = 0;
    while (i < PHASES.length - 1 && dist >= PHASES[i + 1].d) i++;
    const a = PHASES[i], b = PHASES[Math.min(i + 1, PHASES.length - 1)];
    // Transition sur les 300 derniers mètres avant le moment suivant.
    const t = a === b ? 0 : THREE.MathUtils.smoothstep(dist, b.d - 300, b.d);
    const L = (k) => a[k] + (b[k] - a[k]) * t;
    skyMat.uniforms.top.value.copy(lerpC(a.top, b.top, t, c1));
    skyMat.uniforms.low.value.copy(lerpC(a.low, b.low, t, c1));
    scene.fog.color.copy(skyMat.uniforms.low.value);
    scene.background.copy(scene.fog.color);
    game.sun.color.copy(lerpC(a.sun, b.sun, t, c1));
    game.sun.intensity = L('sunI');
    hemi.color.copy(lerpC(a.hs, b.hs, t, c1));
    hemi.groundColor.copy(lerpC(a.hg, b.hg, t, c2));
    hemi.intensity = L('hI');
    const win = L('win');
    for (const f of facades) f.emissiveIntensity = win;
    bulbMat.emissiveIntensity = win * 1.4;
    follow.intensity = win * 18;
    game.renderer.toneMappingExposure = L('exp');
    // soleil (jour) puis lune (nuit) dans le ciel
    const night = THREE.MathUtils.smoothstep(dist, PHASES[2].d + 200, PHASES[3].d);
    disc.material.color.copy(lerpC(t < 0.5 ? a.sun : b.sun, 0xf4f6ff, night, c1)).multiplyScalar(1.4 - night * 0.3);
    disc.position.set(-50 + night * 90, L('sunY'), -125);
    disc.lookAt(0, 4, 6.6);
    const name = t > 0.5 ? b.name : a.name;
    if (name !== phaseName) {
      if (phaseName) game.onEvent('daytime', name);
      phaseName = name;
    }
  }

  return {
    rows, // tout ce qui défile et se replace au bout de la rue (immeubles + murs)
    daytime,
    reset() {
      phaseName = '';
      daytime(0);
    },
    update(scroll, px, dist) {
      const off = scroll % TREE_GAP;
      for (let i = 0; i < n; i++)
        for (let s = 0; s < 2; s++) {
          const side = s ? 1 : -1, z = DESPAWN_Z - i * TREE_GAP + off, k = i * 2 + s;
          const tx = side * (WALL_X + WALK_W - 1.2);
          trees.setMatrixAt(k, m4.compose(p.set(tx, 0.22, z), q, s1));
          const lx = side * (WALL_X + 0.7);
          const rot = side < 0 ? flip : q;
          lamps.setMatrixAt(k, m4.compose(p.set(lx, 0.22, z - TREE_GAP / 2), rot, s1));
          bulbs.setMatrixAt(k, m4.compose(p.set(lx - side * 1.0, 0.22 + 4.45, z - TREE_GAP / 2), q, s1)); // au bout du bras, côté voies
        }
      for (const m of [trees, lamps, bulbs]) m.instanceMatrix.needsUpdate = true;
      gravel.offset.y = (scroll / 400) * 120; // le ballast défile avec le monde
      follow.position.set(px, 3.4, 2.6);
      daytime(dist);
    },
  };
}
const SPRAY_HEX = [0xff4d6d, 0xffbe0b, 0x3a86ff, 0x8338ec, 0x06d6a0, 0xfb5607];

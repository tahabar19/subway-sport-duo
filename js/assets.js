// Modèles 3D (glTF) du jeu : personnages animés, trains, barrière (la ville est générée dans cartoon.js).
// Tous en CC0 (Quaternius), voir assets/CREDITS.md.
import * as THREE from '../vendor/three.module.js';
import { GLTFLoader } from '../vendor/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from '../vendor/addons/utils/BufferGeometryUtils.js';

const FILES = ['garcon', 'fille', 'barriere', 'loco', 'voiture', 'wagon'];

export async function loadAssets(version = '') {
  const loader = new GLTFLoader();
  const g = Object.fromEntries(
    await Promise.all(FILES.map(async (n) => [n, await loader.loadAsync(`assets/modeles/${n}.glb${version}`)])),
  );
  return {
    chars: { garcon: g.garcon, fille: g.fille },
    barriere: g.barriere.scene,
    trains: [bake(g.loco.scene), bake(g.voiture.scene), bake(g.wagon.scene)],
  };
}

// Fusionne toutes les pièces d'un modèle en UNE géométrie, la couleur de chaque matériau
// passant dans les sommets : un seul appel de dessin par train au lieu de 5 à 13
// (skill performance : le GPU Intel HD 5500 partage la machine avec MediaPipe).
export function bake(root) {
  root.updateMatrixWorld(true);
  const parts = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = [].concat(o.material);
    let geo = o.geometry.clone();
    if (!geo.attributes.normal) geo.computeVertexNormals();
    if (geo.index) geo = geo.toNonIndexed();
    geo.applyMatrix4(o.matrixWorld);
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    const groups = geo.groups.length ? geo.groups : [{ start: 0, count: n, materialIndex: 0 }];
    for (const gr of groups) {
      const c = mats[gr.materialIndex ?? 0]?.color ?? new THREE.Color(1, 1, 1);
      for (let i = gr.start; i < Math.min(n, gr.start + gr.count); i++) col.set([c.r, c.g, c.b], i * 3);
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', geo.attributes.position);
    out.setAttribute('normal', geo.attributes.normal);
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(out);
  });
  const merged = mergeGeometries(parts);
  merged.computeBoundingBox();
  return merged;
}

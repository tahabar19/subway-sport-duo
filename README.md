# Subway Sport Duo

Version à deux joueurs de Subway Sport (`~/Bureau/subway-sport`), en ligne sur GitHub Pages.

- Les deux joueurs courent sur **le même parcours** (même graine aléatoire), le meilleur score gagne.
- Accueil : prénom, personnage fille / garçon, micro activé ou coupé (modifiable en jeu : bouton ou touche M).
- Ton score à gauche, celui de l'adversaire à droite ; son personnage en gris un peu devant toi, qui recule ou avance selon l'écart.
- Liaison directe entre les deux navigateurs (PeerJS / WebRTC, `vendor/peerjs.min.js`) : état du jeu + voix.
  Le serveur public de PeerJS sert seulement au rendez-vous ; une salle = un code, 2 joueurs maximum.

## Code

- `js/net.js` — liaison (salle, canal de données, appel audio)
- `js/main.js` — accueil, phases (prêt, calibrage, attente, compte à rebours, course, fin), scores
- `js/game.js` — jeu 3D ; `makeCharacter('fille' | 'garcon', fantome)`, `start(graine)`
- `js/motion.js` — détection des mouvements (copie de subway-sport)

## Tester sur un seul PC

`python3 -m http.server 8790` puis deux fenêtres sur `http://localhost:8790/?sanscamera` (jeu au clavier).

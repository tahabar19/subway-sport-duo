# Subway Sport Duo

Version à deux joueurs de Subway Sport (`~/Bureau/subway-sport`), en ligne sur GitHub Pages.

- Les deux joueurs courent sur **le même parcours** (même graine aléatoire), le meilleur score gagne.
- Accueil : prénom, personnage fille / garçon, micro activé ou coupé (modifiable en jeu : bouton ou touche M).
- Ton score à gauche, celui de l'adversaire à droite ; son personnage en gris un peu devant toi, qui recule ou avance selon l'écart.
- Liaison : les données du jeu passent par deux serveurs MQTT publics à la fois (`vendor/mqtt.min.js`,
  WebSocket sécurisé : marche sur tous les réseaux). Une salle = un code, 2 joueurs maximum.
- Voix : par le même relais (`js/voice.js`) : Opus via WebCodecs (~20 kbit/s), ou son de téléphone
  (8 kHz, loi µ) si un des navigateurs ne sait pas faire d'Opus. Envoyée seulement quand on parle.
  (Plus de WebRTC : les relais gratuits de PeerJS ne répondent plus, la voix ne passait pas entre deux réseaux.)

## Code

- `js/net.js` — liaison (salle via MQTT)
- `js/voice.js` — voix (micro, compression, lecture)
- `js/main.js` — accueil, phases (prêt, calibrage, attente, compte à rebours, course, fin), scores
- `js/game.js` — jeu 3D ; `makeCharacter('fille' | 'garcon', fantome)`, `start(graine)`
- `js/motion.js` — détection des mouvements (copie de subway-sport)

## Tester sur un seul PC

`python3 -m http.server 8790` puis deux fenêtres sur `http://localhost:8790/?sanscamera` (jeu au clavier).

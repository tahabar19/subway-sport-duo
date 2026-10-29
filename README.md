# Subway Sport Duo

Version à deux joueurs de Subway Sport (`~/Bureau/subway-sport`), en ligne sur GitHub Pages.

- Les deux joueurs courent sur **le même parcours** (même graine aléatoire, rangées au mètre près quelle que soit la fluidité), le meilleur score gagne.
- Accueil : prénom, personnage fille / garçon, micro activé ou coupé (modifiable en jeu : bouton ou touche M).
- Nombre de cœurs (1 à 10) choisi par celui qui crée la partie, le même pour les deux.
- Quand tu perds, tu regardes la course de l'adversaire (mode spectateur, `game.watchStart` / `watchTo`) jusqu'à la fin.
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

À chaque mise en ligne : augmenter le numéro `?v=` dans index.html et dans les import de js/main.js (cache GitHub de 10 min).

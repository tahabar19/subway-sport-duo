# Subway Sport Duo

Version multijoueur (seul, ou de 2 à 6 joueurs) de Subway Sport (`~/Bureau/subway-sport`), en ligne sur GitHub Pages.

- Tous les joueurs courent sur **le même parcours** (même graine aléatoire, rangées au mètre près quelle que soit la fluidité), le meilleur score gagne.
- Accueil : prénom, personnage fille / garçon, micro activé ou coupé (modifiable en jeu : bouton ou touche M).
- Nombre de cœurs (1 à 10) choisi par celui qui crée la partie, le même pour tous.
- Quand tu perds, tu regardes la course de celui qui mène encore (mode spectateur, `game.watchStart` / `watchTo`) jusqu'à la fin,
  puis classement de la manche (l'hôte envoie avec le départ la liste de ceux qui courent : même classement chez tous).
- Ton score à gauche, les adversaires à droite (une ligne compacte chacun à partir de 3 joueurs) ; leurs personnages en gris
  un peu devant toi, qui reculent ou avancent selon l'écart.
- Liaison : les données du jeu passent par deux serveurs MQTT publics à la fois (`vendor/mqtt.min.js`,
  WebSocket sécurisé : marche sur tous les réseaux). Une salle = un code, 6 joueurs maximum
  (sujet `subwayduo/v2/` : les versions à 2 joueurs restent entre elles).
- Voix : par le même relais (`js/voice.js`) : Opus via WebCodecs (~20 kbit/s), ou son de téléphone
  (8 kHz, loi µ) si un des navigateurs ne sait pas faire d'Opus. Envoyée seulement quand on parle.
  (Plus de WebRTC : les relais gratuits de PeerJS ne répondent plus, la voix ne passait pas entre deux réseaux.)

## Sur iPhone (appli)

Ouvrir https://tahabar19.github.io/subway-sport-duo/ dans **Safari** → bouton Partager → « Sur l'écran d'accueil ».
L'appli s'ouvre alors en plein écran, avec son icône (`icones/`, `manifest.webmanifest`).

- **Deux façons de jouer** : avec le corps (téléphone posé debout, caméra avant, recule à 2–3 m, lève les bras pour
  te mettre prêt) ou **au doigt** (bouton « Jouer au doigt » : glisser ⬅️ ➡️ = voie, ⬆️ = saut, ⬇️ = roulade, le personnage court tout seul).
- Le code de la partie s'affiche en gros, avec « Envoyer le lien » (feuille de partage : Messages, WhatsApp…).
  Depuis l'appli de l'écran d'accueil, un lien reçu s'ouvre dans Safari : on peut aussi taper le code dans l'appli.
- Pendant la course, boutons en bas à gauche : micro, caméra (aperçu), réglages (sensibilité, tremblement, graphismes)
  et **Quitter** (rouge). Sur les écrans de partie, les mêmes boutons sont en haut du panneau (✕ = quitter).
- **Quitter la partie** (confirmation demandée) : retour à l'accueil ; l'adversaire est prévenu tout de suite (message
  `bye`, `Net.stop`) et reste dans la salle, où il peut attendre quelqu'un d'autre. Au clavier : Échap.
- Habillage des menus façon jeu mobile : boutons en relief cernés d'encre, panneaux blancs, polices Lilita One
  (titres) et Fredoka (textes) dans `fonts/`, icônes dessinées en SVG dans `index.html`, portraits des personnages
  rendus depuis les modèles 3D (`icones/perso-*.png`).
- Portrait (conseillé) ou paysage ; en portrait la caméra du jeu recule pour montrer les 3 voies (`Game.resize`).
- L'écran reste allumé pendant la partie (Wake Lock) ; au retour dans l'appli, caméra et son repartent.
- `sw.js` garde sur le téléphone les gros fichiers (modèle de pose, moteur wasm ~15 Mo, modèles 3D) : démarrage
  rapide après la première fois. Si un fichier de `vendor/` ou `assets/` change, changer `LOURD` dans `sw.js`.

## Code

- `js/net.js` — liaison (salle via MQTT)
- `js/voice.js` — voix (micro, compression, lecture)
- `js/main.js` — accueil, phases (prêt, calibrage, attente, compte à rebours, course, fin), scores
- `js/game.js` — jeu 3D ; `makeCharacter('fille' | 'garcon', fantome)`, `start(graine)`
- `js/motion.js` — détection des mouvements (copie de subway-sport)

## Tester sur un seul PC

`python3 -m http.server 8790` puis deux fenêtres sur `http://localhost:8790/?sanscamera` (jeu au clavier).

À chaque mise en ligne : augmenter le numéro `?v=` dans index.html, manifest.webmanifest et dans les import de js/*.js (cache GitHub de 10 min), et `VERSION` dans sw.js.
Tester en taille iPhone : Chrome → outils de développement → mode appareil (iPhone), sur `http://localhost:8790/?sanscamera`.

## Modèles 3D

Ville cartoon générée en code (matin → après-midi → nuit) ; personnages, trains et barrières : modèles CC0 de Quaternius et Kenney (voir `assets/CREDITS.md`). Si leur chargement échoue, le jeu revient aux personnages en cubes.

- **Pause** pendant la course (bouton ⏸, touche P, ou automatiquement quand l'appli passe en arrière-plan) ; reprise après 3, 2, 1.
  À plusieurs, seule ta course s'arrête.
- **Trains qui foncent** vers le joueur (à partir de ~100 m) : leur voie reste libre devant eux, klaxon, phares et faisceau jaune.
- Graphismes « auto » : baissent d'un cran si le téléphone peine (< 40 images/s pendant 6 s), remontent quand c'est de nouveau
  fluide, jamais en dessous de « basse » tout seuls. Pas de message à l'écran (ni pour le moment de la journée).

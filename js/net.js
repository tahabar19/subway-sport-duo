// Liaison entre les joueurs d'une même partie (jusqu'à MAX_PLAYERS).
//
// Données du jeu : par deux serveurs MQTT publics à la fois (WebSocket sécurisé, comme un
// site web : ça passe sur tous les réseaux). Chaque message part sur les deux, on garde le
// premier arrivé. Une salle = un « sujet » MQTT dérivé du code de partie.
//
// La voix passe par le même chemin (voir voice.js). Pas de connexion directe WebRTC :
// les relais gratuits de PeerJS ne répondent plus (vérifié le 27/10/2026) et, entre deux
// réseaux différents, rien ne passait.

const BROKERS = ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt'];
const TOPIC = 'subwayduo/v2/'; // v2 : plusieurs joueurs par salle (les anciennes versions restent entre elles)
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PING_EVERY = 1000; // ms
const PARTNER_TIMEOUT = 6000; // ms sans nouvelles = joueur parti
export const MAX_PLAYERS = 6;

export const newCode = () => Array.from({ length: 5 }, () => ALPHABET[(Math.random() * ALPHABET.length) | 0]).join('');
export const cleanCode = (c) => (c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

export class Net {
  constructor() {
    this.id = randomId();
    this.code = null;
    this.clients = [];
    this.peers = new Map(); // identifiant d'un autre joueur -> dernière nouvelle (ms)
    this.seq = 0;
    this.seen = new Set(); // messages déjà reçus (ils arrivent en double, un par serveur)
    this.lastSeq = {}; // dernier n° reçu par joueur et type de flux continu (état, voix)
    this.gone = new Set(); // joueurs partis : leurs derniers messages en route ne les font pas revenir
    this.onMessage = () => {};
    this.onStatus = () => {}; // 'attente' | 'arrive' (id) | 'parti' (id, 'quitte'?) | 'erreur'
    this.timer = null;
  }

  // L'hôte (celui qui donne le départ) est choisi pareil chez tout le monde : le plus petit identifiant.
  get isHost() {
    for (const id of this.peers.keys()) if (id < this.id) return false;
    return true;
  }

  get connected() {
    return this.peers.size > 0;
  }

  host(code) {
    this.start(code);
  }
  join(code) {
    this.start(code);
  }

  start(code) {
    this.code = code;
    const topic = TOPIC + code;
    let anyUp = false;
    this.clients = BROKERS.map((url) => {
      const c = window.mqtt.connect(url, {
        clientId: 'sd_' + this.id + '_' + Math.random().toString(36).slice(2, 6),
        clean: true,
        connectTimeout: 8000,
        reconnectPeriod: 2000,
        keepalive: 20,
      });
      c.on('connect', () => {
        if (this.topic !== topic) return; // partie quittée entre-temps
        c.subscribe(topic, { qos: 0 });
        if (!anyUp) {
          anyUp = true;
          if (!this.peers.size) this.onStatus('attente');
        }
        this.ping();
      });
      c.on('message', (_t, payload) => this.topic === topic && this.receive(payload));
      c.on('error', () => {});
      return c;
    });
    this.topic = topic;
    // Aucun serveur joignable au bout de 10 s : on le dit (les essais continuent).
    setTimeout(() => !anyUp && this.topic === topic && this.onStatus('erreur', 'Serveur de jeu injoignable, nouvel essai…'), 10000);
    this.timer = setInterval(() => this.tick(), PING_EVERY);
  }

  // Quitter la salle. Les connexions restent ouvertes une seconde pour que le « bye » envoyé
  // juste avant ait le temps de partir ; ce qui arrive de l'ancienne salle entre-temps est ignoré.
  stop() {
    clearInterval(this.timer);
    this.timer = null;
    const old = this.clients;
    setTimeout(() => {
      for (const c of old) {
        try {
          c.end(false);
        } catch {}
      }
    }, 1000);
    this.clients = [];
    this.peers = new Map();
    this.topic = null;
    this.code = null;
    this.seen = new Set();
    this.lastSeq = {};
    this.gone = new Set();
    this.id = randomId(); // nouvel identifiant pour la prochaine partie
  }

  ping() {
    this.send({ t: 'ping' });
  }

  tick() {
    this.ping();
    const t = Date.now();
    for (const [id, seen] of this.peers)
      if (t - seen > PARTNER_TIMEOUT) {
        this.peers.delete(id);
        this.onStatus('parti', id);
      }
  }

  send(msg) {
    if (!this.topic) return;
    const data = JSON.stringify({ ...msg, from: this.id, seq: ++this.seq });
    // L'état continu (15×/s) en QoS 0 ; les événements en QoS 1 pour ne pas les perdre.
    const qos = msg.t === 'st' || msg.t === 'ping' || msg.t === 'v' ? 0 : 1;
    for (const c of this.clients) if (c.connected) c.publish(this.topic, data, { qos });
  }

  receive(payload) {
    let m;
    try {
      m = JSON.parse(payload.toString());
    } catch {
      return;
    }
    if (!m || typeof m !== 'object' || typeof m.from !== 'string' || m.from === this.id || this.gone.has(m.from)) return;
    const key = m.from + ':' + m.seq;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 600) this.seen = new Set([...this.seen].slice(-300));

    if (!this.peers.has(m.from)) {
      if (m.t === 'bye') return;
      if (this.peers.size >= MAX_PLAYERS - 1) return; // salle pleine
      this.peers.set(m.from, Date.now());
      this.onStatus('arrive', m.from);
    }
    this.peers.set(m.from, Date.now());
    if (m.t === 'ping') return;
    if (m.t === 'bye') {
      // Parti de la partie : on le sait tout de suite, sans attendre 6 s de silence.
      this.gone.add(m.from);
      this.peers.delete(m.from);
      this.onStatus('parti', m.from, 'quitte');
      return;
    }
    if (m.t === 'st' || m.t === 'v') {
      const k = m.from + m.t;
      if (m.seq < (this.lastSeq[k] || 0)) return; // arrivé en retard par l'autre serveur
      this.lastSeq[k] = m.seq;
    }
    this.onMessage(m);
  }
}

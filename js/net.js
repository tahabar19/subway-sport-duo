// Liaison entre les deux joueurs.
//
// Données du jeu : par deux serveurs MQTT publics à la fois (WebSocket sécurisé, comme un
// site web : ça passe sur tous les réseaux). Chaque message part sur les deux, on garde le
// premier arrivé. Une salle = un « sujet » MQTT dérivé du code de partie.
//
// La voix passe par le même chemin (voir voice.js). Pas de connexion directe WebRTC :
// les relais gratuits de PeerJS ne répondent plus (vérifié le 27/10/2026) et, entre deux
// réseaux différents, rien ne passait.

const BROKERS = ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt'];
const TOPIC = 'subwayduo/v1/';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PING_EVERY = 1000; // ms
const PARTNER_TIMEOUT = 6000; // ms sans nouvelles = adversaire parti

export const newCode = () => Array.from({ length: 5 }, () => ALPHABET[(Math.random() * ALPHABET.length) | 0]).join('');
export const cleanCode = (c) => (c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

export class Net {
  constructor() {
    this.id = randomId();
    this.code = null;
    this.clients = [];
    this.partner = null; // identifiant de l'autre joueur
    this.partnerSeen = 0;
    this.seq = 0;
    this.seen = new Set(); // messages déjà reçus (ils arrivent en double, un par serveur)
    this.lastSeq = {}; // dernier n° reçu par type de flux continu (état, voix)
    this.onMessage = () => {};
    this.onStatus = () => {}; // 'attente' | 'connecte' | 'perdu' | 'erreur'
    this.timer = null;
  }

  // L'hôte (celui qui donne le départ) est choisi pareil des deux côtés : le plus petit identifiant.
  get isHost() {
    return !!this.partner && this.id < this.partner;
  }

  get connected() {
    return !!this.partner && Date.now() - this.partnerSeen < PARTNER_TIMEOUT;
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
        c.subscribe(topic, { qos: 0 });
        if (!anyUp) {
          anyUp = true;
          if (!this.partner) this.onStatus('attente');
        }
        this.ping();
      });
      c.on('message', (_t, payload) => this.receive(payload));
      c.on('error', () => {});
      return c;
    });
    this.topic = topic;
    // Aucun serveur joignable au bout de 10 s : on le dit (les essais continuent).
    setTimeout(() => !anyUp && this.onStatus('erreur', 'Serveur de jeu injoignable, nouvel essai…'), 10000);
    this.timer = setInterval(() => this.tick(), PING_EVERY);
  }

  ping() {
    this.send({ t: 'ping' });
  }

  tick() {
    this.ping();
    if (this.partner && !this.connected) {
      this.partner = null;
      this.onStatus('perdu');
    }
  }

  send(msg) {
    if (!this.topic) return;
    const data = JSON.stringify({ ...msg, from: this.id, seq: ++this.seq, to: this.partner });
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
    if (!m || typeof m !== 'object' || typeof m.from !== 'string' || m.from === this.id) return;
    const key = m.from + ':' + m.seq;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 600) this.seen = new Set([...this.seen].slice(-300));

    // Une seule personne en face : la première qui se présente.
    if (!this.partner || !this.connected) {
      if (m.to && m.to !== this.id) return; // elle joue déjà avec quelqu'un d'autre
      const fresh = this.partner !== m.from;
      this.partner = m.from;
      this.partnerSeen = Date.now();
      this.lastSeq = {};
      if (fresh) this.onStatus('connecte');
    }
    if (m.from !== this.partner) return;
    this.partnerSeen = Date.now();
    if (m.t === 'ping') return;
    if (m.t === 'st' || m.t === 'v') {
      if (m.seq < (this.lastSeq[m.t] || 0)) return; // arrivé en retard par l'autre serveur
      this.lastSeq[m.t] = m.seq;
    }
    this.onMessage(m);
  }
}

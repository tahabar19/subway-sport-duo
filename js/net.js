// Liaison directe entre les deux navigateurs (WebRTC via PeerJS).
// Le premier joueur « crée » la salle : son identifiant PeerJS est dérivé du code.
// Le second s'y connecte. Un canal de données (état du jeu) + un appel audio (micro).
//
// Le serveur public de PeerJS ne sert qu'à se trouver ; ensuite tout passe
// de navigateur à navigateur (relais TURN de PeerJS si les box bloquent).

const PREFIX = 'subway-sport-duo-v1-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const newCode = () => Array.from({ length: 5 }, () => ALPHABET[(Math.random() * ALPHABET.length) | 0]).join('');
export const cleanCode = (c) => (c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

export class Net {
  constructor() {
    this.peer = null;
    this.conn = null;
    this.call = null;
    this.isHost = false;
    this.code = null;
    this.onMessage = () => {};
    this.onStatus = () => {}; // (état, détail) : 'attente' | 'connecte' | 'perdu' | 'erreur'
    this.onRemoteAudio = () => {};
    this.localAudio = null; // flux envoyé (micro, ou silence quand coupé)
    this.retry = null;
  }

  get connected() {
    return !!this.conn?.open;
  }

  send(msg) {
    if (this.conn?.open) {
      try {
        this.conn.send(msg);
      } catch {}
    }
  }

  // Le flux audio à envoyer ; changeable pendant la partie (micro activé / coupé).
  setLocalAudio(stream) {
    this.localAudio = stream;
    const track = stream?.getAudioTracks()[0];
    const pc = this.call?.peerConnection;
    if (track && pc) for (const s of pc.getSenders()) if (!s.track || s.track.kind === 'audio') s.replaceTrack(track).catch(() => {});
  }

  host(code) {
    this.isHost = true;
    this.code = code;
    this.open(PREFIX + code);
  }

  join(code) {
    this.isHost = false;
    this.code = code;
    this.open(undefined);
  }

  open(id) {
    clearTimeout(this.retry);
    try {
      this.peer?.destroy();
    } catch {}
    const peer = (this.peer = new window.Peer(id, { debug: 0 }));
    peer.on('open', () => {
      if (this.isHost) this.onStatus('attente');
      else this.connectToHost();
    });
    peer.on('connection', (conn) => {
      // Une seule personne à la fois : on refuse les suivantes.
      if (this.conn?.open) {
        conn.on('open', () => (conn.send({ t: 'complet' }), setTimeout(() => conn.close(), 500)));
        return;
      }
      this.useConn(conn);
    });
    peer.on('call', (call) => {
      call.answer(this.localAudio || undefined);
      this.useCall(call);
    });
    peer.on('disconnected', () => {
      // Perte du serveur de rendez-vous seulement : la partie en cours continue.
      if (!peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 1500);
    });
    peer.on('error', (err) => {
      if (peer !== this.peer) return;
      const type = err.type;
      if (type === 'unavailable-id') {
        // Salle encore tenue par une ancienne page (rechargement) : on réessaie.
        this.onStatus('erreur', 'Salle occupée, nouvel essai…');
        this.retry = setTimeout(() => this.open(id), 3000);
      } else if (type === 'peer-unavailable') {
        this.onStatus('erreur', "Personne n'a encore créé la salle " + this.code + '. Nouvel essai…');
        this.retry = setTimeout(() => this.connectToHost(), 3000);
      } else if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
        this.onStatus('erreur', 'Réseau indisponible, nouvel essai…');
        this.retry = setTimeout(() => this.open(id), 4000);
      } else this.onStatus('erreur', 'Erreur de connexion (' + type + ')');
    });
  }

  connectToHost() {
    if (!this.peer || this.peer.destroyed || this.conn?.open) return;
    if (this.peer.disconnected) return void (this.retry = setTimeout(() => this.connectToHost(), 2000));
    this.useConn(this.peer.connect(PREFIX + this.code, { reliable: true }));
  }

  useConn(conn) {
    this.conn = conn;
    conn.on('open', () => {
      if (conn !== this.conn) return;
      this.onStatus('connecte');
      // L'invité lance l'appel audio ; l'hôte répond.
      if (!this.isHost && this.localAudio) this.useCall(this.peer.call(PREFIX + this.code, this.localAudio));
    });
    conn.on('data', (msg) => conn === this.conn && msg && typeof msg === 'object' && this.onMessage(msg));
    const lost = () => {
      if (conn !== this.conn) return;
      this.conn = null;
      try {
        this.call?.close();
      } catch {}
      this.call = null;
      this.onStatus('perdu');
      if (!this.isHost) this.retry = setTimeout(() => this.connectToHost(), 2000);
    };
    conn.on('close', lost);
    conn.on('error', lost);
  }

  useCall(call) {
    try {
      if (this.call && this.call !== call) this.call.close();
    } catch {}
    this.call = call;
    call.on('stream', (stream) => this.onRemoteAudio(stream));
  }
}

// Voix entre les deux joueurs, par le même relais que le jeu (pas de connexion directe).
//
// Envoi : micro -> paquets de ~60 ms -> Opus (WebCodecs, ~20 kbit/s) ou, si l'un des deux
// navigateurs ne sait pas faire d'Opus, son de téléphone (8 kHz, loi µ, 64 kbit/s).
// Rien n'est envoyé quand personne ne parle.
// Réception : décodage, puis lecture avec un petit tampon (~150 ms) contre les à-coups.

const OPUS = { codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 20000 };
const GATE = 0.006; // volume (RMS) à partir duquel on considère qu'on parle
const GATE_WHILE_LISTENING = 0.03; // plus haut quand l'autre parle : limite l'écho par les haut-parleurs
const HANGOVER = 0.4; // s : on continue d'envoyer un peu après la fin de la phrase
const BUFFER = 0.15; // s de tampon à la lecture
const MAX_LAG = 0.6; // s : au-delà, on rattrape le retard en sautant

const b64 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Loi µ (G.711), 16 bits -> 8 bits
function muEncode(x) {
  let s = Math.max(-1, Math.min(1, x)) * 32635;
  const sign = s < 0 ? 0x80 : 0;
  s = Math.min(32635, Math.abs(s)) + 132;
  let exp = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; mask >>= 1) exp--;
  return ~(sign | (exp << 4) | ((s >> (exp + 3)) & 0x0f)) & 0xff;
}
function muDecode(u) {
  u = ~u & 0xff;
  const sign = u & 0x80, exp = (u >> 4) & 7, man = u & 0x0f;
  const s = (((man << 3) + 132) << exp) - 132;
  return (sign ? -s : s) / 32768;
}

export async function opusSupported() {
  try {
    if (typeof AudioEncoder === 'undefined' || typeof AudioDecoder === 'undefined') return false;
    const [e, d] = await Promise.all([AudioEncoder.isConfigSupported(OPUS), AudioDecoder.isConfigSupported(OPUS)]);
    return !!(e.supported && d.supported);
  } catch {
    return false;
  }
}

export class Voice {
  // send(paquet) : envoie un message au partenaire ; ctx : AudioContext déjà débloqué par un clic.
  constructor(ctx, send) {
    this.ctx = ctx;
    this.send = send;
    this.useOpus = false; // décidé selon ce que les DEUX navigateurs savent faire
    this.mic = null;
    this.on = false;
    this.level = 0; // volume du micro (0..1), pour l'affichage
    this.speakingUntil = 0;
    this.remoteUntil = 0; // l'autre parle jusqu'à…
    this.playAt = 0;
    this.out = ctx.createGain();
    this.out.gain.value = 1.4;
    this.out.connect(ctx.destination);
    this.decoder = null;
    this.encoder = null;
    this.pending = [];
    this.ts = 0;
    this.n = 0;
  }

  // Micro activé ou coupé (le flux reste ouvert : réactivation instantanée).
  async setMic(on) {
    this.on = on;
    if (!on || this.mic) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.mic = stream;
    const src = this.ctx.createMediaStreamSource(stream);
    // ScriptProcessor : ancien mais disponible partout, suffisant pour la voix.
    const proc = this.ctx.createScriptProcessor(2048, 1, 1);
    proc.onaudioprocess = (e) => this.capture(e.inputBuffer.getChannelData(0));
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    src.connect(proc);
    proc.connect(mute).connect(this.ctx.destination); // nécessaire pour que le traitement tourne
  }

  setOpus(on) {
    if (this.useOpus === on) return;
    this.useOpus = on;
    try {
      this.encoder?.close();
    } catch {}
    this.encoder = null;
  }

  capture(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);
    this.level += (rms - this.level) * 0.3;
    if (!this.on) return;
    const now = this.ctx.currentTime;
    const gate = now < this.remoteUntil ? GATE_WHILE_LISTENING : GATE;
    if (rms > gate) this.speakingUntil = now + HANGOVER;
    if (now > this.speakingUntil) return void (this.useOpus && this.flush());
    const rate = this.ctx.sampleRate;
    if (this.useOpus) this.encodeOpus(samples, rate);
    else this.sendMu(samples, rate);
  }

  encodeOpus(samples, rate) {
    if (!this.encoder) {
      this.encoder = new AudioEncoder({
        output: (chunk) => {
          const buf = new Uint8Array(chunk.byteLength);
          chunk.copyTo(buf);
          this.pending.push(b64(buf));
          if (this.pending.length >= 3) this.flush();
        },
        error: () => this.setOpus(false), // en cas de souci : son de téléphone
      });
      this.encoder.configure({ ...OPUS, sampleRate: rate });
      this.rate = rate;
    }
    const data = new Float32Array(samples);
    this.encoder.encode(
      new AudioData({ format: 'f32', sampleRate: rate, numberOfFrames: data.length, numberOfChannels: 1, timestamp: this.ts, data }),
    );
    this.ts += (data.length / rate) * 1e6;
  }

  flush() {
    if (!this.pending.length) return;
    this.send({ t: 'v', c: 'o', r: this.rate, f: this.pending });
    this.pending = [];
  }

  sendMu(samples, rate) {
    // 48 kHz (ou 44,1) -> 8 kHz : moyenne sur chaque pas
    const step = rate / 8000, n = Math.floor(samples.length / step);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * step), b = Math.floor((i + 1) * step);
      let s = 0;
      for (let j = a; j < b; j++) s += samples[j];
      out[i] = muEncode(s / (b - a));
    }
    this.send({ t: 'v', c: 'u', d: b64(out) });
  }

  // Paquet reçu du partenaire
  receive(m) {
    try {
      if (m.c === 'u' && typeof m.d === 'string') {
        const u = unb64(m.d);
        const f = new Float32Array(u.length);
        for (let i = 0; i < u.length; i++) f[i] = muDecode(u[i]);
        this.play(f, 8000);
      } else if (m.c === 'o' && Array.isArray(m.f)) {
        if (!this.decoder) {
          this.decoder = new AudioDecoder({
            output: (ad) => {
              const f = new Float32Array(ad.numberOfFrames);
              ad.copyTo(f, { planeIndex: 0, format: 'f32-planar' });
              this.play(f, ad.sampleRate);
              ad.close();
            },
            error: () => (this.decoder = null),
          });
          this.decoder.configure({ ...OPUS, sampleRate: Number(m.r) || 48000 });
        }
        for (const s of m.f.slice(0, 10)) {
          if (typeof s !== 'string') continue;
          const data = unb64(s);
          this.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: (this.n++) * 20000, data }));
        }
      }
    } catch {}
  }

  play(f, rate) {
    if (!f.length) return;
    const ctx = this.ctx, now = ctx.currentTime;
    if (this.playAt < now || this.playAt > now + MAX_LAG) this.playAt = now + BUFFER;
    const buf = ctx.createBuffer(1, f.length, rate);
    buf.copyToChannel(f, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.out);
    src.start(this.playAt);
    this.playAt += buf.duration;
    this.played = (this.played || 0) + buf.duration; // secondes de voix reçues (pour les tests)
    this.remoteUntil = this.playAt + 0.25;
  }

  // L'autre est-il en train de parler ?
  get remoteTalking() {
    return this.ctx.currentTime < this.remoteUntil;
  }
  get talking() {
    return this.on && this.ctx.currentTime < this.speakingUntil;
  }
}

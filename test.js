// Whisper-Test: Wandelt Sprache direkt im Browser in Text um und misst, wie lange das dauert.
// Bibliothek: transformers.js (Hugging Face). Sie wird beim Laden der Seite aus dem Internet geholt,
// die Modelle ebenfalls (beim ersten Mal). Danach liegen sie im Browser-Cache.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;   // Modelle immer von Hugging Face holen (und im Browser-Cache merken)

const ZIEL_RATE = 16000;        // Whisper erwartet 16 kHz, mono
const AUFNAHME_SEKUNDEN = 60;
const SPEICHER_SCHLUESSEL = 'whisper-test-ergebnisse';
const LAEUFT_SCHLUESSEL = 'whisper-test-laeuft';
const MODELL_NAMEN = { 'Xenova/whisper-tiny': 'tiny', 'Xenova/whisper-base': 'base' };

const $ = (id) => document.getElementById(id);

let audio = null;       // { samples: Float32Array, sekunden: Zahl }
let testLaeuft = false;
let aufnahme = null;    // { recorder, stream, timer } solange aufgenommen wird

// ---------- Kleine Helfer ----------

/** Browser-Speicher (kann in privaten Fenstern fehlen, darum immer abgesichert). */
function speicherLesen(schluessel) {
  try { return localStorage.getItem(schluessel); } catch (fehler) { return null; }
}
function speicherSchreiben(schluessel, wert) {
  try {
    if (wert === null) localStorage.removeItem(schluessel);
    else localStorage.setItem(schluessel, wert);
  } catch (fehler) { /* nicht schlimm */ }
}

function sekundenText(s) {
  return s < 90 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

function minutenText(minuten) {
  if (minuten < 1) return 'unter 1 Minute';
  if (minuten < 90) return `ca. ${Math.round(minuten)} Minuten`;
  return `ca. ${(minuten / 60).toFixed(1)} Stunden`;
}

// ---------- Geräteinfos und Schnellmodus ----------

function geraeteInfosZeigen() {
  const version = navigator.userAgent.match(/(Version\/[\d.]+|CriOS\/[\d.]+|Chrome\/[\d.]+|Firefox\/[\d.]+)/);
  const zeilen = [
    ['Browser', version ? version[0] : 'unbekannt'],
    ['Rechenkerne', navigator.hardwareConcurrency || 'unbekannt'],
    ['Mehrere Kerne nutzbar', crossOriginIsolated ? 'ja' : 'nein'],
    ['WebGPU (Grafikchip)', navigator.gpu ? 'verfügbar' : 'nicht verfügbar'],
    ['Sichere Seite (HTTPS)', isSecureContext ? 'ja' : 'nein'],
  ];
  if (navigator.deviceMemory) zeilen.push(['Arbeitsspeicher (ungefähr)', `${navigator.deviceMemory} GB`]);
  const liste = $('geraet');
  liste.replaceChildren();
  for (const [name, wert] of zeilen) {
    const eintrag = document.createElement('li');
    eintrag.textContent = `${name}: ${wert}`;
    liste.append(eintrag);
  }
}

function schnellmodusVorbereiten() {
  $('webgpu-wahl').hidden = !navigator.gpu;
  if (crossOriginIsolated || !isSecureContext || !('serviceWorker' in navigator)) return;

  $('schnell-bereich').hidden = false;
  if (speicherLesen('schnellmodus-versucht')) {
    // Wir haben es schon probiert und es hat nicht geklappt
    $('schnell-bereich').querySelector('p').textContent =
      'Der Schnellmodus funktioniert in diesem Browser leider nicht. Der Test läuft mit einem Kern.';
    $('schnell-knopf').hidden = true;
    return;
  }
  $('schnell-knopf').addEventListener('click', async () => {
    speicherSchreiben('schnellmodus-versucht', '1');
    try {
      await navigator.serviceWorker.register('sw.js');
      await navigator.serviceWorker.ready;   // erst neu laden, wenn der Worker aktiv ist
      location.reload();
    } catch (fehler) {
      $('schnell-bereich').querySelector('p').textContent = `Der Schnellmodus konnte nicht gestartet werden (${fehler.message}).`;
    }
  });
}

// ---------- Sprache: aufnehmen oder Datei wählen ----------

/** Wandelt Audiodaten (mp4, webm, wav, ...) in 16 kHz mono um. */
async function zuMono16k(arrayBuffer) {
  const AudioKlasse = window.AudioContext || window.webkitAudioContext;
  const kontext = new AudioKlasse();
  try {
    const buffer = await kontext.decodeAudioData(arrayBuffer);
    const offline = new OfflineAudioContext(1, Math.ceil(buffer.duration * ZIEL_RATE), ZIEL_RATE);
    const quelle = offline.createBufferSource();
    quelle.buffer = buffer;
    quelle.connect(offline.destination);
    quelle.start();
    const fertig = await offline.startRendering();
    return fertig.getChannelData(0);
  } finally {
    kontext.close().catch(() => {});
  }
}

async function audioSetzen(arrayBuffer, quelle) {
  $('audio-status').textContent = 'Sprache wird vorbereitet ...';
  try {
    const samples = await zuMono16k(arrayBuffer);
    audio = { samples, sekunden: samples.length / ZIEL_RATE };
    $('audio-status').textContent = `${quelle}: ${sekundenText(audio.sekunden)} Sprache bereit.`;
    $('start-knopf').disabled = testLaeuft;
  } catch (fehler) {
    audio = null;
    $('start-knopf').disabled = true;
    $('audio-status').textContent = 'Diese Audiodatei kann der Browser nicht lesen.';
  }
}

function mikrofonFehlerText(fehler) {
  switch (fehler && fehler.name) {
    case 'NotAllowedError': return 'Mikrofon verweigert. Bitte in den Browser-Einstellungen erlauben.';
    case 'NotFoundError': return 'Kein Mikrofon gefunden.';
    default: return 'Das Mikrofon konnte nicht gestartet werden.';
  }
}

async function aufnahmeStarten() {
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    $('audio-status').textContent = 'Dieser Browser kann nicht aufnehmen. Wähle stattdessen eine Audiodatei.';
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, autoGainControl: true, noiseSuppression: true, echoCancellation: false },
    });
  } catch (fehler) {
    $('audio-status').textContent = mikrofonFehlerText(fehler);
    return;
  }
  const format = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((f) => MediaRecorder.isTypeSupported(f));
  const recorder = format ? new MediaRecorder(stream, { mimeType: format }) : new MediaRecorder(stream);
  const stuecke = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) stuecke.push(e.data); };

  const start = Date.now();
  const anzeige = setInterval(() => {
    const rest = Math.max(0, AUFNAHME_SEKUNDEN - Math.round((Date.now() - start) / 1000));
    $('audio-status').textContent = `Aufnahme läuft ... noch ${rest} s (zum Beenden nochmal tippen)`;
  }, 500);
  const stoppTimer = setTimeout(() => recorder.state === 'recording' && recorder.stop(), AUFNAHME_SEKUNDEN * 1000);

  recorder.onstop = async () => {
    clearInterval(anzeige);
    clearTimeout(stoppTimer);
    stream.getTracks().forEach((spur) => spur.stop());
    aufnahme = null;
    $('aufnahme-knopf').textContent = '60 Sekunden aufnehmen';
    $('aufnahme-knopf').classList.remove('aufnahme');
    const blob = new Blob(stuecke, { type: recorder.mimeType || 'audio/webm' });
    await audioSetzen(await blob.arrayBuffer(), 'Aufnahme');
  };

  aufnahme = { recorder };
  $('aufnahme-knopf').textContent = 'Aufnahme beenden';
  $('aufnahme-knopf').classList.add('aufnahme');
  recorder.start();
}

$('aufnahme-knopf').addEventListener('click', () => {
  if (aufnahme) aufnahme.recorder.stop();
  else aufnahmeStarten();
});

$('datei-wahl').addEventListener('change', async (ereignis) => {
  const datei = ereignis.target.files[0];
  if (datei) await audioSetzen(await datei.arrayBuffer(), 'Datei');
});

// ---------- Test ----------

/** Wie viele Rechenkerne nutzt die Bibliothek wirklich? (Nur beim Prozessor-Modus sinnvoll.) */
function kerneZaehlen(geraet) {
  if (geraet === 'webgpu') return 'Grafikchip';
  return crossOriginIsolated ? (env.backends.onnx.wasm.numThreads || navigator.hardwareConcurrency || '?') : 1;
}

function ergebnisKarte(daten) {
  const karte = document.createElement('div');
  karte.className = 'karte ergebnis';
  const titel = document.createElement('h3');
  titel.textContent = `${daten.modell} (${daten.geraet === 'webgpu' ? 'Grafikchip' : 'Prozessor'})`;
  karte.append(titel);

  if (daten.fehler) {
    const f = document.createElement('p');
    f.className = 'fehler';
    f.textContent = `Fehlgeschlagen: ${daten.fehler}`;
    karte.append(f);
    return karte;
  }

  const tabelle = document.createElement('table');
  const faktor = daten.rechenzeit / daten.audioSekunden;
  const zeilen = [
    ['Sprache', sekundenText(daten.audioSekunden)],
    ['Modell laden (einmalig)', sekundenText(daten.ladezeit)],
    ['Umwandeln', sekundenText(daten.rechenzeit)],
    ['Faktor (Rechenzeit / Sprache)', `${faktor.toFixed(2)}x`],
    ['Hochgerechnet auf 45 Minuten', minutenText(faktor * 45)],
    ['Kerne', daten.kerne],
  ];
  for (const [name, wert] of zeilen) {
    const zeile = document.createElement('tr');
    const a = document.createElement('td');
    const b = document.createElement('td');
    a.textContent = name;
    b.textContent = wert;
    zeile.append(a, b);
    tabelle.append(zeile);
  }
  const text = document.createElement('div');
  text.className = 'text';
  text.textContent = daten.text || '(kein Text erkannt)';
  karte.append(tabelle, text);
  return karte;
}

function ergebnisseZeigen(liste, hinweis) {
  const bereich = $('ergebnisse');
  bereich.replaceChildren();
  if (hinweis) {
    const h = document.createElement('p');
    h.className = 'fehler';
    h.textContent = hinweis;
    bereich.append(h);
  }
  liste.forEach((daten) => bereich.append(ergebnisKarte(daten)));
}

function fortschrittZeigen(prozent) {
  $('fortschritt').hidden = prozent === null;
  if (prozent !== null) $('fortschritt-balken').style.width = `${Math.min(100, prozent)}%`;
}

async function testStarten() {
  if (testLaeuft || !audio) return;
  const modelle = [...document.querySelectorAll('input[name="modell"]:checked')].map((e) => e.value);
  const geraet = document.querySelector('input[name="geraet"]:checked').value;
  if (modelle.length === 0) {
    $('test-status').textContent = 'Bitte mindestens ein Modell wählen.';
    return;
  }

  testLaeuft = true;
  $('start-knopf').disabled = true;
  const ergebnisse = [];
  speicherSchreiben(SPEICHER_SCHLUESSEL, null);
  ergebnisseZeigen([]);

  for (const modell of modelle) {
    const name = MODELL_NAMEN[modell] || modell;
    // Merken, woran wir gerade arbeiten: Stürzt die Seite wegen zu wenig Speicher ab, steht es nach dem Neuladen da
    speicherSchreiben(LAEUFT_SCHLUESSEL, name);
    const daten = { modell: name, geraet, audioSekunden: audio.sekunden, kerne: kerneZaehlen(geraet) };
    try {
      $('test-status').textContent = `Modell ${name} wird geladen ... (Falls die Seite neu lädt, reicht der Speicher nicht.)`;
      const t0 = performance.now();
      const asr = await pipeline('automatic-speech-recognition', modell, {
        device: geraet,
        dtype: geraet === 'webgpu' ? 'fp32' : 'q8',
        progress_callback: (p) => {
          if (p.status === 'progress') fortschrittZeigen(p.progress);
        },
      });
      fortschrittZeigen(null);
      daten.ladezeit = (performance.now() - t0) / 1000;

      $('test-status').textContent = `Modell ${name} wandelt um ... (Handy nicht sperren)`;
      const t1 = performance.now();
      const antwort = await asr(audio.samples, { language: 'german', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
      daten.rechenzeit = (performance.now() - t1) / 1000;
      daten.text = (antwort.text || '').trim();
      await asr.dispose();   // Speicher freigeben, bevor das nächste Modell kommt
    } catch (fehler) {
      fortschrittZeigen(null);
      daten.fehler = fehler && fehler.message ? fehler.message : String(fehler);
    }
    ergebnisse.push(daten);
    speicherSchreiben(SPEICHER_SCHLUESSEL, JSON.stringify(ergebnisse));
    ergebnisseZeigen(ergebnisse);
  }

  speicherSchreiben(LAEUFT_SCHLUESSEL, null);
  $('test-status').textContent = 'Fertig. Notiere jetzt den Akkustand und schicke mir die Zahlen.';
  testLaeuft = false;
  $('start-knopf').disabled = false;
}

$('start-knopf').addEventListener('click', testStarten);

// ---------- Start der Seite ----------

geraeteInfosZeigen();
schnellmodusVorbereiten();

// Wurde die Seite mitten im Test neu geladen? Dann zeigen wir, was bis dahin fertig war.
const abgebrochen = speicherLesen(LAEUFT_SCHLUESSEL);
const gespeichert = speicherLesen(SPEICHER_SCHLUESSEL);
if (abgebrochen) {
  speicherSchreiben(LAEUFT_SCHLUESSEL, null);
  let liste = [];
  try { liste = JSON.parse(gespeichert || '[]'); } catch (fehler) { /* ignorieren */ }
  ergebnisseZeigen(liste, `Die Seite wurde beim Test von „${abgebrochen}“ neu geladen. Vermutlich reicht der Speicher für dieses Modell nicht.`);
}

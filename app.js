const STORAGE_KEYS = { settings: "spotify-chords.settings.v7", tokens: "spotify-chords.tokens.v7" };
const SPOTIFY_SCOPES = ["user-read-currently-playing", "user-read-playback-state"];
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const state = {
  settings: { clientId: "" }, tokens: null, currentTrack: null,
  authTone: "muted", authText: "Sin conectar", playbackTone: "muted", playbackText: "Esperando",
  lastTrackKey: "", lastSyncAt: 0, pollTimer: null, progressTimer: null,
  currentTranspose: 0 // Estado de la transposición
};

const el = {};

document.addEventListener("DOMContentLoaded", boot);

async function boot() {
  cacheElements(); bindEvents(); hydrateState(); renderSetup();
  await maybeFinishSpotifyLogin();
  if (state.tokens) startSpotifyPolling(); else startProgressLoop();
}

function cacheElements() {
  el.clientId = document.getElementById("spotify-client-id");
  el.redirectUri = document.getElementById("redirect-uri");
  el.copyUrlBtn = document.getElementById("copy-url-btn");
  el.connectBtn = document.getElementById("connect-btn");
  el.disconnectBtn = document.getElementById("disconnect-btn");
  el.authStatusPill = document.getElementById("auth-status-pill");
  el.playbackPill = document.getElementById("playback-pill");
  el.coverArt = document.getElementById("cover-art");
  el.trackKicker = document.getElementById("track-kicker");
  el.trackTitle = document.getElementById("track-title");
  el.trackArtist = document.getElementById("track-artist");
  el.progressLeft = document.getElementById("progress-left");
  el.progressRight = document.getElementById("progress-right");
  el.progressFill = document.getElementById("progress-fill");
  el.chordsView = document.getElementById("chords-view");
  el.controlsBar = document.getElementById("chords-controls");
  el.btnTransposeUp = document.getElementById("btn-transpose-up");
  el.btnTransposeDown = document.getElementById("btn-transpose-down");
  el.transposeLabel = document.getElementById("transpose-label");
  el.autoScrollCb = document.getElementById("auto-scroll-cb");
}

function bindEvents() {
  el.clientId.addEventListener("input", () => {
    state.settings.clientId = el.clientId.value.trim();
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(state.settings));
  });
  el.copyUrlBtn.addEventListener("click", async () => {
    await navigator.clipboard.writeText(getRedirectUri());
    setAuthStatus("live", "URI Copiada"); renderSetup();
  });
  el.connectBtn.addEventListener("click", startSpotifyLogin);
  el.disconnectBtn.addEventListener("click", disconnectSpotify);
  
  // Eventos de Transposición
  el.btnTransposeUp.addEventListener("click", () => aplicarTransposicion(1));
  el.btnTransposeDown.addEventListener("click", () => aplicarTransposicion(-1));
}

function hydrateState() {
  try {
    const savedSettings = JSON.parse(localStorage.getItem(STORAGE_KEYS.settings) || "null");
    if (savedSettings?.clientId) state.settings.clientId = savedSettings.clientId;
    const savedTokens = JSON.parse(localStorage.getItem(STORAGE_KEYS.tokens) || "null");
    if (savedTokens?.accessToken) { state.tokens = savedTokens; setAuthStatus("live", "Conectado"); }
  } catch (e) {}
}

async function startSpotifyLogin() {
  const clientId = state.settings.clientId.trim();
  const redirectUri = getRedirectUri();
  if (!clientId || !redirectUri) return alert("Falta Client ID.");
  const verifier = randomString(96);
  const challenge = await pkceChallengeFromVerifier(verifier);
  const authState = randomString(24);
  sessionStorage.setItem("spotify-chords.verifier", verifier);
  sessionStorage.setItem("spotify-chords.state", authState);
  const params = new URLSearchParams({
    client_id: clientId, response_type: "code", redirect_uri: redirectUri,
    scope: SPOTIFY_SCOPES.join(" "), code_challenge_method: "S256",
    code_challenge: challenge, state: authState
  });
  window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

async function maybeFinishSpotifyLogin() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  if (!code) return;
  try {
    const verifier = sessionStorage.getItem("spotify-chords.verifier");
    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: state.settings.clientId, code, redirect_uri: getRedirectUri(), code_verifier: verifier })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error("Fallo token");
    state.tokens = { accessToken: payload.access_token, refreshToken: payload.refresh_token, expiresAt: Date.now() + (payload.expires_in * 1000) - 60000 };
    localStorage.setItem(STORAGE_KEYS.tokens, JSON.stringify(state.tokens));
    setAuthStatus("live", "Conectado");
  } catch (e) { setAuthStatus("error", "Error al conectar"); } 
  finally { window.history.replaceState({}, "", window.location.pathname); renderSetup(); }
}

function disconnectSpotify() {
  stopSpotifyPolling(); localStorage.removeItem(STORAGE_KEYS.tokens);
  state.tokens = null; state.currentTrack = null;
  setAuthStatus("muted", "Sin conectar"); setPlaybackStatus("muted", "Esperando");
  el.chordsView.innerHTML = "Conecta Spotify y dale play a tu música para iniciar la extracción...";
  el.controlsBar.style.display = 'none';
  renderAll();
}

function startSpotifyPolling() { fetchSpotifyPlayback(); state.pollTimer = setInterval(fetchSpotifyPlayback, 4000); startProgressLoop(); }
function stopSpotifyPolling() { clearInterval(state.pollTimer); }

async function fetchSpotifyPlayback() {
  if (!state.tokens) return;
  try {
    const response = await fetch("https://api.spotify.com/v1/me/player", { headers: { Authorization: `Bearer ${state.tokens.accessToken}` } });
    if (response.status === 204) throw new Error("Pausado");
    const payload = await response.json();
    if (!payload.item || payload.currently_playing_type !== "track") throw new Error("No es canción");

    const track = {
      name: payload.item.name, artist: payload.item.artists[0].name,
      image: payload.item.album.images[0]?.url || "",
      durationMs: payload.item.duration_ms, progressMs: payload.progress_ms || 0,
      isPlaying: payload.is_playing
    };

    const trackKey = `${track.name}-${track.artist}`;
    state.currentTrack = track; state.lastSyncAt = Date.now();
    setPlaybackStatus(track.isPlaying ? "live" : "warn", track.isPlaying ? "Sonando" : "Pausado");
    
    if (trackKey !== state.lastTrackKey) {
      state.lastTrackKey = trackKey;
      renderNowPlaying();
      extraerAcordesNativos(track); 
    } else { renderNowPlaying(); }
  } catch (e) { setPlaybackStatus("muted", "En pausa o cerrado"); renderNowPlaying(); }
}

// ----------------------------------------------------
// MOTOR DE PROCESAMIENTO DE TEXTO, COLOR Y TRANSPOSICIÓN
// ----------------------------------------------------

async function extraerAcordesNativos(track) {
  const tituloLimpio = track.name.replace(/\(([^)]*(live|remaster|version|edit)[^)]*)\)/gi, "").trim();
  const artista = track.artist;
  
  el.chordsView.innerHTML = `Extrayendo acordes de "${tituloLimpio}"... ⏳<br>Si tarda, es porque el proxy gratuito está en cola.`;
  el.controlsBar.style.display = 'none'; // Ocultamos controles mientras carga

  const formatUrl = (str) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9\s]/g, "").trim().replace(/\s+/g, "-").toLowerCase();
  
  try {
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(`https://www.cifraclub.com/${formatUrl(artista)}/${formatUrl(tituloLimpio)}/imprimir.html`)}`;
    const res = await fetch(proxyUrl);
    const data = await res.json();
    const parser = new DOMParser();
    const doc = parser.parseFromString(data.contents, 'text/html');
    const bloqueAcordes = doc.querySelector('pre');

    if (bloqueAcordes && bloqueAcordes.textContent.trim().length > 0) {
      // Reseteamos el transpose
      state.currentTranspose = 0;
      el.transposeLabel.innerText = "Tono: 0";
      
      // Procesamos el texto para detectar y colorear acordes
      const textoFormateado = procesarTextoAcordes(bloqueAcordes.textContent);
      el.chordsView.innerHTML = textoFormateado;
      el.controlsBar.style.display = 'flex'; // Mostramos controles
    } else {
      el.chordsView.innerHTML = `No se encontró texto puro para esta canción en la base de datos de CifraClub.`;
    }
  } catch (error) {
    el.chordsView.innerHTML = "Error de conexión con el Proxy. Intenta pausar y darle play de nuevo.";
  }
}

// Función que detecta si una línea es de acordes y los envuelve en un <span> verde
function procesarTextoAcordes(textoPlano) {
  const lineas = textoPlano.split('\n');
  const chordPattern = /^[CDEFGAB][#b]?(m|maj|dim|aug|sus)?\d*(?:\/[CDEFGAB][#b]?)?$/;
  
  const lineasFormateadas = lineas.map(linea => {
    const tokens = linea.trim().split(/\s+/);
    if (tokens.length === 0 || tokens[0] === "") return linea;

    // Evaluamos si más del 60% de las palabras de esta línea parecen acordes
    let conteoAcordes = 0;
    for (let t of tokens) { if (chordPattern.test(t)) conteoAcordes++; }
    
    if ((conteoAcordes / tokens.length) > 0.6) {
      // Es una línea de acordes. Reemplazamos cada acorde con un span coloreado.
      return linea.replace(/([CDEFGAB][#b]?(m|maj|dim|aug|sus)?\d*(\/[CDEFGAB][#b]?)?)/g, '<span class="chord-token" data-original="$1">$1</span>');
    }
    return linea; // Es una línea de letra normal
  });
  
  return lineasFormateadas.join('\n');
}

// Función matemática para cambiar el tono (Transpose)
function aplicarTransposicion(pasos) {
  state.currentTranspose += pasos;
  el.transposeLabel.innerText = `Tono: ${state.currentTranspose > 0 ? '+' : ''}${state.currentTranspose}`;
  
  const spans = document.querySelectorAll('.chord-token');
  spans.forEach(span => {
    const original = span.getAttribute('data-original');
    const partes = original.split('/'); // Por si hay bajos como D/F#
    
    const partesTranspuestas = partes.map(parte => {
      const match = parte.match(/^([CDEFGAB][#b]?)(.*)$/);
      if (match) {
        let notaBase = match[1];
        const modificador = match[2];
        
        // Convertimos bemoles a sostenidos para el cálculo matemático
        const flatsToSharps = {'Cb':'B', 'Db':'C#', 'Eb':'D#', 'Fb':'E', 'Gb':'F#', 'Ab':'G#', 'Bb':'A#'};
        if (notaBase.includes('b')) notaBase = flatsToSharps[notaBase];
        
        let idx = NOTES.indexOf(notaBase);
        if (idx !== -1) {
          let nuevoIdx = (idx + state.currentTranspose) % 12;
          if (nuevoIdx < 0) nuevoIdx += 12;
          return NOTES[nuevoIdx] + modificador;
        }
      }
      return parte;
    });
    
    span.innerText = partesTranspuestas.join('/');
  });
}

// ----------------------------------------------------
// RENDERIZADO Y AUTO-SCROLL
// ----------------------------------------------------

function renderAll() { renderSetup(); renderNowPlaying(); }
function renderSetup() {
  el.clientId.value = state.settings.clientId; el.redirectUri.value = getRedirectUri();
  el.authStatusPill.className = `status-pill ${state.authTone === 'live' ? 'status-pill-live' : 'status-pill-muted'}`;
  el.authStatusPill.textContent = state.authText;
}
function renderNowPlaying() {
  const t = state.currentTrack;
  el.playbackPill.className = `status-pill ${state.playbackTone === 'live' ? 'status-pill-live' : 'status-pill-muted'}`;
  el.playbackPill.textContent = state.playbackText;
  if (!t) { el.trackTitle.textContent = "-"; el.trackArtist.textContent = "-"; el.coverArt.innerHTML = "🎵"; return; }
  el.trackTitle.textContent = t.name; el.trackArtist.textContent = t.artist; el.trackKicker.textContent = "Spotify Live";
  if (t.image) el.coverArt.innerHTML = `<img src="${t.image}" style="width:100%; height:100%; object-fit:cover;">`;
}

function startProgressLoop() { setInterval(updateProgressDisplay, 1000); }

function updateProgressDisplay() {
  if (!state.currentTrack || !state.currentTrack.isPlaying) return;
  const elapsed = Math.max(0, Date.now() - state.lastSyncAt);
  const progMs = Math.min(state.currentTrack.progressMs + elapsed, state.currentTrack.durationMs);
  
  el.progressLeft.textContent = formatMs(progMs);
  el.progressRight.textContent = formatMs(state.currentTrack.durationMs);
  
  const ratio = progMs / state.currentTrack.durationMs;
  el.progressFill.style.width = `${ratio * 100}%`;

  // LA MAGIA DEL AUTO-SCROLL
  if (el.autoScrollCb && el.autoScrollCb.checked && el.chordsView.scrollHeight > el.chordsView.clientHeight) {
    const maxScroll = el.chordsView.scrollHeight - el.chordsView.clientHeight;
    // Agregamos un pequeño retraso al inicio para que no baje de golpe en los intros
    el.chordsView.scrollTop = ratio * maxScroll;
  }
}

function formatMs(ms) { const s = Math.floor(ms / 1000); return `${Math.floor(s/60)}:${String(s%60).padStart(2, '0')}`; }
function getRedirectUri() { return `${window.location.origin}${window.location.pathname}`; }
function setAuthStatus(tone, text) { state.authTone = tone; state.authText = text; }
function setPlaybackStatus(tone, text) { state.playbackTone = tone; state.playbackText = text; }
function randomString(len) { return Array.from(crypto.getRandomValues(new Uint8Array(len)), v => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[v%62]).join(""); }
async function pkceChallengeFromVerifier(v) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

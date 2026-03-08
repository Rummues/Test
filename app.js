const STORAGE_KEYS = { settings: "spotify-chords.settings.ia1", tokens: "spotify-chords.tokens.ia1" };
const SPOTIFY_SCOPES = ["user-read-currently-playing", "user-read-playback-state"];
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const state = {
  settings: { clientId: "", geminiKey: "" }, tokens: null, currentTrack: null,
  authTone: "muted", authText: "Sin conectar", playbackTone: "muted", playbackText: "Esperando",
  lastTrackKey: "", lastSyncAt: 0, pollTimer: null, progressTimer: null,
  currentTranspose: 0, textoOriginalAcordes: ""
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
  el.geminiKey = document.getElementById("gemini-api-key");
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
  // Guardamos las llaves al escribirlas
  el.clientId.addEventListener("input", () => { state.settings.clientId = el.clientId.value.trim(); guardarConfig(); });
  el.geminiKey.addEventListener("input", () => { state.settings.geminiKey = el.geminiKey.value.trim(); guardarConfig(); });
  
  el.copyUrlBtn.addEventListener("click", async () => { await navigator.clipboard.writeText(getRedirectUri()); setAuthStatus("live", "URI Copiada"); renderSetup(); });
  el.connectBtn.addEventListener("click", startSpotifyLogin);
  el.disconnectBtn.addEventListener("click", disconnectSpotify);
  
  el.btnTransposeUp.addEventListener("click", () => aplicarTransposicion(1));
  el.btnTransposeDown.addEventListener("click", () => aplicarTransposicion(-1));
}

function guardarConfig() { localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(state.settings)); }

function hydrateState() {
  try {
    const savedSettings = JSON.parse(localStorage.getItem(STORAGE_KEYS.settings) || "null");
    if (savedSettings) {
      if (savedSettings.clientId) state.settings.clientId = savedSettings.clientId;
      if (savedSettings.geminiKey) state.settings.geminiKey = savedSettings.geminiKey;
    }
    const savedTokens = JSON.parse(localStorage.getItem(STORAGE_KEYS.tokens) || "null");
    if (savedTokens?.accessToken) { state.tokens = savedTokens; setAuthStatus("live", "Conectado"); }
  } catch (e) {}
}

async function startSpotifyLogin() {
  const clientId = state.settings.clientId.trim();
  const redirectUri = getRedirectUri();
  if (!clientId || !redirectUri) return alert("Falta tu Client ID de Spotify.");
  const verifier = randomString(96); const challenge = await pkceChallengeFromVerifier(verifier); const authState = randomString(24);
  sessionStorage.setItem("spotify-chords.verifier", verifier); sessionStorage.setItem("spotify-chords.state", authState);
  const params = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirectUri, scope: SPOTIFY_SCOPES.join(" "), code_challenge_method: "S256", code_challenge: challenge, state: authState });
  window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

async function maybeFinishSpotifyLogin() {
  const url = new URL(window.location.href); const code = url.searchParams.get("code"); if (!code) return;
  try {
    const verifier = sessionStorage.getItem("spotify-chords.verifier");
    const response = await fetch("https://accounts.spotify.com/api/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: state.settings.clientId, code, redirect_uri: getRedirectUri(), code_verifier: verifier }) });
    const payload = await response.json(); if (!response.ok) throw new Error("Fallo token");
    state.tokens = { accessToken: payload.access_token, refreshToken: payload.refresh_token, expiresAt: Date.now() + (payload.expires_in * 1000) - 60000 };
    localStorage.setItem(STORAGE_KEYS.tokens, JSON.stringify(state.tokens)); setAuthStatus("live", "Conectado");
  } catch (e) { setAuthStatus("error", "Error al conectar"); } finally { window.history.replaceState({}, "", window.location.pathname); renderSetup(); }
}

function disconnectSpotify() {
  stopSpotifyPolling(); localStorage.removeItem(STORAGE_KEYS.tokens); state.tokens = null; state.currentTrack = null;
  setAuthStatus("muted", "Sin conectar"); setPlaybackStatus("muted", "Esperando");
  el.chordsView.innerHTML = "Conecta Spotify e ingresa tu API Key de IA para comenzar...";
  el.controlsBar.style.display = 'none'; renderAll();
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
      image: payload.item.album.images[0]?.url || "", durationMs: payload.item.duration_ms, progressMs: payload.progress_ms || 0, isPlaying: payload.is_playing
    };
    const trackKey = `${track.name}-${track.artist}`;
    state.currentTrack = track; state.lastSyncAt = Date.now();
    setPlaybackStatus(track.isPlaying ? "live" : "warn", track.isPlaying ? "Sonando" : "Pausado");
    
    if (trackKey !== state.lastTrackKey) {
      state.lastTrackKey = trackKey; renderNowPlaying();
      generarAcordesConIA(track); 
    } else { renderNowPlaying(); }
  } catch (e) { setPlaybackStatus("muted", "En pausa"); renderNowPlaying(); }
}

// ----------------------------------------------------
// EL NUEVO CEREBRO: GOOGLE GEMINI AI
// ----------------------------------------------------
async function generarAcordesConIA(track) {
  if (!state.settings.geminiKey) {
    el.chordsView.innerHTML = "⚠️ ¡Atención! Falta tu clave de IA (Gemini API Key).<br>Ponla en el panel izquierdo (Setup) para que el robot funcione.";
    el.controlsBar.style.display = 'none';
    return;
  }

  const tituloLimpio = track.name.replace(/\(([^)]*(live|remaster|version|edit)[^)]*)\)/gi, "").trim();
  el.controlsBar.style.display = 'none'; 
  el.chordsView.innerHTML = `Pidiéndole a la Inteligencia Artificial que escriba la tablatura de "${tituloLimpio}"... 🤖🎸`;

  const prompt = `Actúa como el mejor músico de sesión del mundo. Necesito los acordes y la letra de la canción "${tituloLimpio}" del artista "${track.artist}".
  Reglas estrictas e inquebrantables:
  1. Escribe la letra completa de la canción, y justo encima de las palabras donde van los cambios, coloca el acorde.
  2. Usa notación americana (C, D, Em, G, etc.).
  3. NO uses bloques de formato markdown (no uses \`\`\`).
  4. SOLO devuelve el texto plano puro, sin decir "Aquí tienes", ni saludos, ni explicaciones extra. Solo Título, Artista y Tablatura.`;

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${state.settings.geminiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });

    if (!response.ok) throw new Error("La API Key es inválida o la IA falló.");

    const data = await response.json();
    let textoIA = data.candidates[0].content.parts[0].text;
    
    // Limpiamos los rastros de Markdown que a veces deja la IA
    textoIA = textoIA.replace(/```(html|plaintext)?/gi, '').replace(/```/g, '').trim();

    // Guardamos estado y mostramos
    state.currentTranspose = 0;
    el.transposeLabel.innerText = "Tono: 0";
    state.textoOriginalAcordes = textoIA;
    
    el.chordsView.innerHTML = procesarTextoAcordes(textoIA);
    el.controlsBar.style.display = 'flex'; // ¡AQUÍ ACTIVAMOS LA BARRA DE TRANSPOSICIÓN!

  } catch (error) {
    el.chordsView.innerHTML = "Hubo un error al conectar con la IA. Verifica que tu API Key sea correcta en el panel de Setup.";
  }
}

// ----------------------------------------------------
// LÉXICO Y TRANSPOSICIÓN
// ----------------------------------------------------
function procesarTextoAcordes(textoPlano) {
  const lineas = textoPlano.split('\n');
  const chordPattern = /^[CDEFGAB][#b]?(m|maj|dim|aug|sus)?\d*(?:\/[CDEFGAB][#b]?)?$/i;
  
  const lineasFormateadas = lineas.map(linea => {
    const tokens = linea.trim().split(/\s+/);
    if (tokens.length === 0 || tokens[0] === "") return linea;

    let conteoAcordes = 0;
    for (let t of tokens) { if (chordPattern.test(t)) conteoAcordes++; }
    
    if ((conteoAcordes / tokens.length) > 0.4) {
      return linea.replace(/\b([CDEFGAB][#b]?(m|maj|dim|aug|sus)?\d*(?:\/[CDEFGAB][#b]?)?)\b/g, '<span class="chord-token" data-original="$1">$1</span>');
    }
    return linea;
  });
  return lineasFormateadas.join('\n');
}

function aplicarTransposicion(pasos) {
  if (!state.textoOriginalAcordes) return;
  state.currentTranspose += pasos;
  el.transposeLabel.innerText = `Tono: ${state.currentTranspose > 0 ? '+' : ''}${state.currentTranspose}`;
  
  const textoPintado = procesarTextoAcordes(state.textoOriginalAcordes);
  el.chordsView.innerHTML = textoPintado; 
  
  const spans = el.chordsView.querySelectorAll('.chord-token');
  spans.forEach(span => {
    const original = span.getAttribute('data-original');
    const partes = original.split('/'); 
    
    const partesTranspuestas = partes.map(parte => {
      const match = parte.match(/^([CDEFGAB][#b]?)(.*)$/);
      if (match) {
        let notaBase = match[1];
        const modificador = match[2] || "";
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
  el.clientId.value = state.settings.clientId; el.geminiKey.value = state.settings.geminiKey; el.redirectUri.value = getRedirectUri();
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
  
  el.progressLeft.textContent = formatMs(progMs); el.progressRight.textContent = formatMs(state.currentTrack.durationMs);
  const ratio = progMs / state.currentTrack.durationMs; el.progressFill.style.width = `${ratio * 100}%`;

  if (el.autoScrollCb && el.autoScrollCb.checked && el.chordsView.scrollHeight > el.chordsView.clientHeight) {
    const maxScroll = el.chordsView.scrollHeight - el.chordsView.clientHeight;
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

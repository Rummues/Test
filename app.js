const STORAGE_KEYS = {
  settings: "spotify-chords.settings.v6",
  tokens: "spotify-chords.tokens.v6"
};

const SPOTIFY_SCOPES = ["user-read-currently-playing", "user-read-playback-state"];

const state = {
  settings: { clientId: "" },
  tokens: null,
  currentTrack: null,
  authTone: "muted", authText: "Sin conectar",
  playbackTone: "muted", playbackText: "Esperando",
  lastTrackKey: "", lastSyncAt: 0,
  pollTimer: null, progressTimer: null
};

const el = {};

document.addEventListener("DOMContentLoaded", boot);

async function boot() {
  cacheElements();
  bindEvents();
  hydrateState();
  renderSetup();
  await maybeFinishSpotifyLogin();
  if (state.tokens) startSpotifyPolling();
  else startProgressLoop();
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
}

function hydrateState() {
  try {
    const savedSettings = JSON.parse(localStorage.getItem(STORAGE_KEYS.settings) || "null");
    if (savedSettings?.clientId) state.settings.clientId = savedSettings.clientId;
    const savedTokens = JSON.parse(localStorage.getItem(STORAGE_KEYS.tokens) || "null");
    if (savedTokens?.accessToken) {
      state.tokens = savedTokens;
      setAuthStatus("live", "Conectado");
    }
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
      body: new URLSearchParams({
        grant_type: "authorization_code", client_id: state.settings.clientId,
        code, redirect_uri: getRedirectUri(), code_verifier: verifier
      })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error("Fallo token");
    
    state.tokens = {
      accessToken: payload.access_token, refreshToken: payload.refresh_token,
      expiresAt: Date.now() + (payload.expires_in * 1000) - 60000
    };
    localStorage.setItem(STORAGE_KEYS.tokens, JSON.stringify(state.tokens));
    setAuthStatus("live", "Conectado");
  } catch (e) {
    setAuthStatus("error", "Error al conectar");
  } finally {
    window.history.replaceState({}, "", window.location.pathname);
    renderSetup();
  }
}

function disconnectSpotify() {
  stopSpotifyPolling();
  localStorage.removeItem(STORAGE_KEYS.tokens);
  state.tokens = null; state.currentTrack = null;
  setAuthStatus("muted", "Sin conectar");
  setPlaybackStatus("muted", "Esperando");
  el.chordsView.textContent = "Conecta Spotify y dale play a tu música para iniciar la extracción...";
  renderAll();
}

function startSpotifyPolling() {
  fetchSpotifyPlayback();
  state.pollTimer = setInterval(fetchSpotifyPlayback, 4000);
  startProgressLoop();
}
function stopSpotifyPolling() { clearInterval(state.pollTimer); }

async function fetchSpotifyPlayback() {
  if (!state.tokens) return;
  try {
    const response = await fetch("https://api.spotify.com/v1/me/player", {
      headers: { Authorization: `Bearer ${state.tokens.accessToken}` }
    });
    if (response.status === 204) throw new Error("Pausado");
    
    const payload = await response.json();
    if (!payload.item || payload.currently_playing_type !== "track") throw new Error("No es canción");

    const track = {
      name: payload.item.name,
      artist: payload.item.artists[0].name,
      image: payload.item.album.images[0]?.url || "",
      durationMs: payload.item.duration_ms,
      progressMs: payload.progress_ms || 0,
      isPlaying: payload.is_playing
    };

    const trackKey = `${track.name}-${track.artist}`;
    state.currentTrack = track;
    state.lastSyncAt = Date.now();
    setPlaybackStatus(track.isPlaying ? "live" : "warn", track.isPlaying ? "Sonando" : "Pausado");
    
    if (trackKey !== state.lastTrackKey) {
      state.lastTrackKey = trackKey;
      renderNowPlaying();
      // ¡Llamamos al robot extractor nativo!
      extraerAcordesNativos(track); 
    } else {
      renderNowPlaying();
    }
  } catch (e) {
    setPlaybackStatus("muted", "En pausa o cerrado");
    renderNowPlaying();
  }
}

// EL ROBOT EXTRACTOR DE TEXTO
async function extraerAcordesNativos(track) {
  // Limpiamos el título para la búsqueda
  const tituloLimpio = track.name.replace(/\(([^)]*(live|remaster|version|edit)[^)]*)\)/gi, "").trim();
  const artista = track.artist;
  
  el.chordsView.textContent = `Extrayendo acordes de "${tituloLimpio}"...\nPor favor espera, el proxy está copiando el texto... ⏳`;

  // Formateamos el texto para la URL (minúsculas, guiones en vez de espacios)
  const formatUrl = (str) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9\s]/g, "").trim().replace(/\s+/g, "-").toLowerCase();
  
  const queryArtista = formatUrl(artista);
  const queryCancion = formatUrl(tituloLimpio);

  try {
    // Usamos el Proxy AllOrigins para extraer el HTML crudo de la versión de impresión
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(`https://www.cifraclub.com/${queryArtista}/${queryCancion}/imprimir.html`)}`;
    
    const res = await fetch(proxyUrl);
    const data = await res.json();

    // Leemos el HTML robado
    const parser = new DOMParser();
    const doc = parser.parseFromString(data.contents, 'text/html');
    
    // Buscamos la etiqueta <pre> que contiene los acordes
    const bloqueAcordes = doc.querySelector('pre');

    if (bloqueAcordes && bloqueAcordes.textContent.trim().length > 0) {
      // ¡Pegamos el texto puro en la pantalla!
      el.chordsView.textContent = bloqueAcordes.textContent.trim();
    } else {
      el.chordsView.textContent = `No se encontró texto puro para esta canción.\n\nEl proxy logró entrar, pero la página no tenía el formato esperado o la canción no existe en la base de datos abierta.\nIntenta con un clásico de pop/rock para probar el extractor.`;
    }

  } catch (error) {
    el.chordsView.textContent = "Error de extracción.\nEl sistema de seguridad de la página de tablaturas bloqueó al proxy.";
    console.error(error);
  }
}

function renderAll() { renderSetup(); renderNowPlaying(); }

function renderSetup() {
  el.clientId.value = state.settings.clientId;
  el.redirectUri.value = getRedirectUri();
  el.authStatusPill.className = `status-pill ${state.authTone === 'live' ? 'status-pill-live' : 'status-pill-muted'}`;
  el.authStatusPill.textContent = state.authText;
}

function renderNowPlaying() {
  const t = state.currentTrack;
  el.playbackPill.className = `status-pill ${state.playbackTone === 'live' ? 'status-pill-live' : 'status-pill-muted'}`;
  el.playbackPill.textContent = state.playbackText;

  if (!t) {
    el.trackTitle.textContent = "-"; el.trackArtist.textContent = "-";
    el.coverArt.innerHTML = "🎵"; return;
  }
  
  el.trackTitle.textContent = t.name;
  el.trackArtist.textContent = t.artist;
  el.trackKicker.textContent = "Spotify Live";
  if (t.image) el.coverArt.innerHTML = `<img src="${t.image}" style="width:100%; height:100%; object-fit:cover;">`;
}

function startProgressLoop() { setInterval(updateProgressDisplay, 1000); }
function updateProgressDisplay() {
  if (!state.currentTrack || !state.currentTrack.isPlaying) return;
  const elapsed = Math.max(0, Date.now() - state.lastSyncAt);
  const progMs = Math.min(state.currentTrack.progressMs + elapsed, state.currentTrack.durationMs);
  el.progressLeft.textContent = formatMs(progMs);
  el.progressRight.textContent = formatMs(state.currentTrack.durationMs);
  el.progressFill.style.width = `${(progMs / state.currentTrack.durationMs) * 100}%`;
}
function formatMs(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s/60)}:${String(s%60).padStart(2, '0')}`;
}
function getRedirectUri() { return `${window.location.origin}${window.location.pathname}`; }
function setAuthStatus(tone, text) { state.authTone = tone; state.authText = text; }
function setPlaybackStatus(tone, text) { state.playbackTone = tone; state.playbackText = text; }
function randomString(len) { return Array.from(crypto.getRandomValues(new Uint8Array(len)), v => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[v%62]).join(""); }
async function pkceChallengeFromVerifier(v) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
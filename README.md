# Spotify Chords Board

Sitio estatico para GitHub Pages que detecta la cancion actual desde Spotify Web API y luego hace dos cosas:

- intenta traer la letra automaticamente desde fuentes abiertas
- prepara busquedas exactas para acordes, orientadas a resultados utiles en sitios grandes

## Archivos

- `index.html`: estructura de la app
- `styles.css`: interfaz dark glass estilo Apple-like
- `app.js`: login Spotify PKCE, lectura de playback, letra automatica y launcher de busquedas

## Como funciona ahora

- Spotify detecta la pista actual.
- La app intenta obtener la letra automaticamente desde `LRCLIB` y luego `lyrics.ovh` como respaldo.
- Para acordes no intenta incrustar paginas fragiles dentro de un iframe.
- En vez de eso, construye consultas exactas para DuckDuckGo y Google usando artista + cancion + filtros de sitios.

## Por que este enfoque es mas solido

- Un frontend estatico puro no puede scrapear de forma robusta cualquier web de acordes.
- Muchos sitios bloquean lectura cruzada por `CORS`.
- Muchos sitios tambien bloquean iframes con `X-Frame-Options` o `CSP frame-ancestors`.
- Por eso la app ahora usa busquedas dirigidas en vez de un embed que falla por catalogo o por politicas del navegador.

## Como subirlo a GitHub Pages

1. Crea un repo nuevo en GitHub.
2. Sube estos tres archivos al root del repo.
3. En GitHub entra a `Settings > Pages`.
4. En `Build and deployment`, elige `Deploy from a branch`.
5. Selecciona tu rama principal y la carpeta `/ (root)`.
6. Guarda y espera a que GitHub Pages te entregue una URL tipo `https://tuusuario.github.io/tu-repo/`.

## Como conectarlo con Spotify

1. Abre la URL publicada de GitHub Pages.
2. Copia la `Redirect URI exacta` que muestra la app.
3. Crea una app en Spotify for Developers.
4. Pega esa URL exacta en la lista de Redirect URIs de Spotify.
5. Copia tu `Client ID` y pegalo en la app.
6. Pulsa `Conectar Spotify`.

## Verificacion local

- Valide sintaxis de `app.js` con `node --check`.
- No hice autenticacion real contra Spotify aqui porque requiere tu app registrada y tu URL final de Pages.

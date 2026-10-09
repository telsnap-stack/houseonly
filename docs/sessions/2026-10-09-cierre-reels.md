# 2026-10-09 — Cierre configurable en el Shot 3 de Stories/Reels

Solo frontend (`src/App.jsx`); worker y wrangler sin tocar. Rama
`claude/cierre-reels`, sacada de `main` (`fa9f7b7`).

## Qué cambia

- Selector **"Cierre del vídeo"** en el generador de Stories (sobre las vistas
  previas), con tres modos:
  - **Seguir** (por defecto) → `FOLLOW @ONLYHOUSEONLY`.
  - **Link in bio** → `LINK IN BIO`, para los discos que se quieren vender.
  - **Ninguno** → como antes: sin texto, solo el sticker de enlace.
- El modo se guarda en `localStorage` (`houseonly_story_cta`); si falta o es
  basura, vuelve a "Seguir".
- Una sola función, `drawShot3Cta(ctx, W, H, mode, elapsed)`, la llaman
  `Shot3Canvas` (preview) y `exDrawShot3` (export), así que no pueden divergir.
  `IG_HANDLE = '@onlyhouseonly'` está junto a ella.
- Estilo: Inter 900 56 px (baja de 2 en 2 si no cabe en W-160), lima `#c8ff00`,
  centrado en y=1440. Pulso a 120 BPM (+4 % en los primeros 160 ms de cada
  beat), calculado solo con `elapsed`: el export es determinista.
- Textos de la UI: "Shot 3 — tap to shop" pasa a **"Shot 3 — cierre"**. La nota
  bajo "Export — full story" dice "pon la URL en la bio" en modo Link in bio y
  "añade el sticker bajo el cierre" en los otros dos.
- Shot 1, Shot 2, audio y lógica de export intactos; solo se pasa `ctaMode`.

## Verificación

- `npm run build` OK. Lint: `main` ya falla (95 problemas en `App.jsx`); con el
  cambio, 93 y ninguno nuevo.
- Harness aparte con el código **exacto** de `drawShot3Cta` + `exDrawShot3`
  copiado de `App.jsx`, en Chrome headless con Inter cargada:
  - Píxeles lima bajo y=1200: Seguir 1408-1464, Link in bio 1415-1457,
    Ninguno nada. La línea del catálogo acaba hacia y≈1335 y la interfaz de
    Reels empieza hacia y≈1500: no pisa ni título ni artista.
  - WebM real (MediaRecorder, VP9) de 15 s con el Shot 3 en 10-15 s,
    decodificado otra vez: sin CTA en t=2/8/9.9 s y con CTA (y 1408-1463) en
    t=10.5/12/14.5 s.
- **No probado**: el admin de verdad (pide el secreto de admin), así que ni el
  selector en pantalla, ni la persistencia, ni un export con `StoryExporter` y
  audio. Pendiente de mirar en staging.

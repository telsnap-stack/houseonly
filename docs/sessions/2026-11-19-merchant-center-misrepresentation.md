# 2026-11-19 — Merchant Center: suspensión por "Misrepresentation"

## Qué pasó
- 18 nov (20:41 CDMX): dos correos de Merchant Center (cuenta 5807974617). Los
  ~1.270 productos pasaron a "Not approved" en todos los países por
  "Misrepresentation", detectado por un control automático tras unos días en
  revisión. Google no dice la causa concreta.
- El botón de revisión ("I disagree with the issue") está bloqueado hasta que
  Eduardo verifique su identidad en Merchant Center.

## Qué se cambió
- Merchant Center → Business info: Customer service (URL /contact/, email
  info@houseonly.store) y perfil social (Instagram). Estaban vacíos.
- Web (este PR):
  - `src/policies.mjs`: `BUSINESS`, `BUSINESS_LINE`, `HOME_TITLE`.
  - Pie de la app y pie prerenderizado: qué es la tienda y quién la opera
    (Telsnap S.L., NIF-IVA, dirección, correo) en todas las páginas.
  - Portada (`renderHomeHtml`): título, meta description y JSON-LD
    `OnlineStore`. Antes solo llevaba `<title>houseonly</title>`.
  - `<!--email_off-->` en políticas y pie: Cloudflare ofuscaba el correo y un
    robot sin JavaScript leía "[email protected]".

## Decidido / pendiente
- IVA: Eduardo NO cambia los precios (sin IVA, se añade en el checkout, como
  hace Shopify). No tocar.
- Pendiente de Eduardo: verificar identidad, teléfono de atención (opcional),
  confirmar el texto de envíos ("via Correos with tracking").
- Tras desplegar y verificar identidad: pedir la revisión en Merchant Center.

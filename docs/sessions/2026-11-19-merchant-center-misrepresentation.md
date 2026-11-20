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

## 2026-11-20 — Revisión rechazada; segunda ronda

- Google rechazó la revisión del 19 nov (correo "your review request has been
  completed", misma plantilla). Siguiente revisión: desde el **22 nov**. Quedan
  2 de 3. Sigue marcado "found through automated checks".
- Leídas la política de Misrepresentation y "Building trust with your
  customers". Suspensión sin aviso = "Unacceptable business practices" o
  "Dishonest pricing and transaction conditions".
- **Merchant Center, corregido a mano (Chrome):**
  - Devoluciones: la política decía "solo defectuosos", sin plazo, coste
    "Free", y solo España. Ahora: 14 días, solo producto nuevo/precintado, por
    correo, etiqueta a cargo del cliente, reembolso en 14 días; una política
    para España y otra igual para los otros 20 países del feed. Coincide con
    /returns. Google la revisa aparte (hasta 10 días).
  - Envíos: los plazos eran 0–31 / 0–31 / 0–45 días hábiles. Ahora coinciden
    con /shipping: España 4–10 (1–3 de preparación + 3–7), Europa y resto
    16–33 (1–3 + 15–30). Tarifas sin tocar (desde 7 / 16 / 22 €).
  - Nombre del negocio: "houseonly.store" → "House Only".
- **Web (PR nuevo):** página /about (texto en `policies.mjs`), Instagram y
  Discogs en el pie, y —en commit aparte— aviso de impuestos (`TAX_NOTE`) en el
  pie, en /about y bajo el total del carrito. Los precios y el IVA no cambian.
- Pendiente de Eduardo: aprobar el PR (con o sin el commit del aviso de
  impuestos), teléfono de atención (opcional), y confirmar "with tracking" en
  la política de envíos de Shopify.

### Mismo día, más tarde

- **Términos de Shopify decían "Prices are in euros and include Spanish VAT"**
  y la tienda cobra sin IVA incluido (`shop.taxesIncluded = false`,
  `taxShipping = true`). Corregido en el admin de Shopify (Settings → Policies):
  ahora dicen que los precios no incluyen IVA y que se añade en el checkout
  para la UE. Los precios y la configuración de impuestos no se tocaron.
- Envíos (Shopify y Términos): "usually via Correos and always with tracking".
- Devoluciones (Shopify): la devolución va a Madrid; desde fuera de España es
  envío internacional a cargo del comprador.
- La app de Shopify del conector no tiene `write_legal_policies`: las políticas
  se editaron desde el admin en Chrome.
- Las páginas de políticas de houseonly.store se generan en el build: estos
  textos no salen en la web hasta el siguiente deploy (PR #230).
- Merchant Center: "Ship-from locations" solo admite Francia, Alemania y
  EE. UU.; no se puede poner Madrid. Sin teléfono de atención (decisión de
  Eduardo). No se configuran los países incompletos.
- Google Business Profile: no se crea; Google no lo admite para negocios solo
  online sin atención presencial.
- Soporte de Merchant Center: el formulario de contacto exige un Google Ads
  Customer ID y la cuenta no tiene; no se pudo enviar.

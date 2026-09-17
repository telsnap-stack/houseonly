# Fase 7: textos para Bandsintown y NTS

Borradores para que Eduardo los envíe. En inglés, que es lo que leen los dos.
Nada se ha enviado. Ver `docs/entities.md`, "Fase 7".

**Por dónde se mandan.** No hay dirección verificada para ninguno de los dos,
así que no se inventa:

- **Bandsintown**: su documentación remite al *partnership program* para
  organizaciones que integran datos de varios artistas
  (<https://help.artists.bandsintown.com/en/articles/7053475-what-is-the-bandsintown-api>).
  Usar el formulario o contacto que enlace esa página.
- **NTS**: la página de contacto de <https://www.nts.live>. Sus términos
  publicados solo cubren Supporters; no hay contacto de API.

---

## 1. Bandsintown — solicitud de partnership

**Subject:** Data partnership request — HOUSE ONLY (independent record store)

Hi,

I run HOUSE ONLY (https://houseonly.store), an independent online record store
focused on house, techno and related music, selling vinyl from labels such as
Deep Jungle, Rawax, Fokuz and Pampa.

Our customers can follow the artists and labels whose records we stock, and
each one has its own page. About 180 of them carry enough of our catalogue to
matter, and we'd like those pages to show each artist's upcoming shows, linking
to Bandsintown for tickets and RSVPs.

I understand that API keys are tied to a single artist and that use across
several artists requires a partnership, so I'm writing to ask about one.

What we have in mind:

- **Read-only** use of artist events for the artists we stock (hundreds, not
  thousands), matched by a person, never by name alone.
- Refreshed **once a day** at most, with results cached for 24 hours.
- Every event links back to Bandsintown, with the attribution and branding you
  require.
- **No resale** of the data, no ticketing of our own, and no ads around it.
- Events are shown alongside the artist's records; they are not a product.

Could you tell me whether this fits your partnership program, and what the
terms and fees would be? I'm happy to share mock-ups or more detail about volume.

Thanks,
Eduardo Montagut
HOUSE ONLY — https://houseonly.store

---

## 2. NTS — nota sobre el uso de su API

**Subject:** Linking to NTS shows from HOUSE ONLY artist pages

Hi NTS team,

I run HOUSE ONLY (https://houseonly.store), an independent online record store.
Many of the artists we stock have shows or guest mixes on NTS (Omar S and Theo
Parrish among them), and we'd like our artist pages to point people to them.

Before going further I wanted to tell you how we'd do it and ask whether it's OK
with you:

- A **script run by hand**, not an automated service, queries the public
  `nts.live/api/v2` search and show endpoints to *suggest* which NTS show or
  artist page belongs to each of our ~180 artists and labels. At most about
  **one request per second**, and only when we run it (roughly weekly).
- **A person reviews every suggestion** before anything is published.
- On our site the sets are **linked, not embedded**, with NTS clearly shown as
  the source, so listeners go to nts.live to hear them.
- We don't copy or store audio, artwork or descriptions.

Is this acceptable? If you'd rather we used a different endpoint, a lower rate,
or a specific attribution, just say and we'll follow it. And if you'd prefer we
didn't use the API at all, we'll stick to links added by hand.

Thanks, and thanks for the radio.
Eduardo Montagut
HOUSE ONLY — https://houseonly.store

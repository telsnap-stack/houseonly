# Discogs ↔ Shopify: manual checks (2026-09-22)

After the relink on 22-09: 142 auto-fixes + 44 approved links + 5 manual relinks (VFS089, VFS089Y, DEFCL001LP, FR315R, SIG002RP2) written. Final dry run: 0 auto-fixable, 1 dead link (DES133). What remains needs a human.

## 1. Check physically (excluded from the commit)

| Discogs listing | Discogs record | Candidate Shopify SKU | Why |
|--|--|--|--|
| 4199021442 | BCee - Crystal EP  (12", EP) | `FOKUZ107_` | Discogs *Crystal EP* vs Shopify *Love Drunk EP* |
| 4199194059 | Intelligent Manners - Secret Feeling (12") | `FOKUZ059_` | Discogs *Secret Feeling* vs Shopify *Heavenly Feeling EP* |
| 4200207003 | Various - 99 The Remix EP (12", EP, Blu) | `FOKUZ099RP` | Discogs *99 The Remix EP* vs Shopify *S.T.L Project vs Love & Migration Remixes* |
| 4372181115 | Simoncino - Cosmic Warrior (12") | `HM029B` | Discogs *Cosmic Warrior* (2023) vs Shopify *Cosmic Warrior (Larry Heard & Ron Trent Remixes)* |

## 2. Dead link: a web sale would NOT take the live listing down

| Shopify SKU | Linked listing (dead) | Live listings | Status |
|--|--|--|--|
| `DES133` | 4221197949 (404) | 4228077405 **and** 4285854873 | Choose which one to keep. Shopify stock 1, **two live listings**. |

Fixed on 22-09 (relinked to the live listing): `VFS089` → 4281343725, `VFS089Y` → 4281343278, `DEFCL001LP` → 4337947446, `FR315R` → 4281256260.

## 3. For sale on Discogs with 0 Shopify stock

| Discogs listing | SKU | Record |
|--|--|--|
| 4187282202 | `SMALLVILLECD03` | asper clouds |

## 4. Several Shopify candidates

| Discogs listing | Discogs catno | Candidates | Record |
|--|--|--|--|
| 4271429463 | DAT 088 | `DAT088 A/B`, `DAT088 C/D` | Subjects (5) - Mash Up / Spaced Out / Fantasy / Rhodes Tune  (2x12") |

`SIG002` (4199281302) → `SIG002RP2`, linked on 22-09. `SIG002-2024` keeps its own listing, 4197671298.

## 5. Two live listings for one SKU (left as they are; see the follow-up)

| SKU | Shopify stock | Linked listing | Other live listing |
|--|--|--|--|
| `ATJ012` | 2 | 4156961763 | 4373219991 |
| `COOP007` | 2 | 4176318717 | 4156961805 |
| `RMCE021` | 3 | 4164934932 | 4156961652 |
| `RMCE028` | 2 | 4372179366 | 4373217150 |
| `RXT-08` | 2 | 4372182243 | 4373218131 |
| `SOULR055` | 2 | 4197674571 | 4200252492 |
| `VP014` | 2 | 4246949688 | 4258358799 |

## 6. No Shopify product found (64)

Discogs-only stock, or a product with a different SKU. If it is in Shopify, give me listing → SKU.

| Discogs listing | Discogs catno / cached | Record |
|--|--|--|
| 4190712009 | CRAFT001 | 11:68PM - CRAFT SERVICES 001 (12", EP) |
| 4373220480 | HOUSEWAX41 | Alton Miller - Summer Bliss (12") |
| 4258392909 | IT 55 | Andy Toth - Mind Lock EP (12", EP) |
| 4176934002 | HS02 | Anne Wirz - Guerrière (Four Tet Remixes) (12") |
| 4178355576 | WARPLP300-1 | Aphex Twin - Peel Session 2 TX 10/04/95 (12", EP) |
| 4225466070 | 2047Black | Blacks & Blues - Spin (12") |
| 4372180080 | 200052 | Blauert - Resonanz (12", EP, Blu) |
| 4337825883 | quintessentials 102 | Borrowed Identity & Mechanical Soul Brother - Return To Yourself EP (12", EP, Ltd, Sag) |
| 4200205335 | FOKUZLP013, FOKUZLP013CD1, FOKUZLP013CD2 | Brother (4) - Cold Shoulder (2x12" + 2xCD, Album) |
| 4337978625 | SIG007A | Calibre & High Contrast - Mr. Majestic / The Other Side (12", RE, RP) |
| 4337957169 | TR53V | Carl Craig - At Les (Christian Smith Remixes) (12", RE, Pur) |
| 4176306984 | BR221LP | Carles Viarnès - Post (LP, Album, Ltd, Num) |
| 4221276636 | yore-061 | Craig Alexander - Feel Good (12") |
| 4337824146 | yore-062 | Craig Alexander - Phenomenal Woman / Across My Mind (12", EP) |
| 4373518257 | 868 209-1 | Crystal Waters - Gypsy Woman (She's Homeless) (12", RP) |
| 4373524128 | MM07 | Delano Smith & Brian Kage - Keep 'Em Movin' EP (12", EP, RP) |
| 4337761569 | ROOTS008 | Demarkus Lewis / Josh Stone - Early Summer Compilation 2026 (12") |
| 4337656974 | C#CC23LP | Drexciya - Journey Of The Deep Sea Dweller II (2x12", Comp, RM) |
| 4281343617 | VFS089X | Ellis Dee - One For The Ladies / You Got To Believe (12", RE) |
| 4176861045 | EGLO36 | Fatima (12) - Yellow Memories (LP, Album) |
| 4372183464 | RXT-05 R | Fresh & Low - Wind On Water (12", EP, RE, Red) |
| 4373086095 | RXT-05 R | Fresh & Low - Wind On Water (12", EP, RE, Red) |
| 4176346836 | SNF120 | Fëlipë Görḋön* - The Lichtenberg Effect EP (12", EP, Tra) |
| 4190851683 | SJU12R24 (RED) | GU's Jaz Collective* - Afro Gente / Fuego De Sangre (12", W/Lbl, Red) |
| 4281251931 | UR-025 | Galaxy 2 Galaxy - Galaxy 2 Galaxy (12", RM) |
| 4176908241 | 0602547682031 | GoGo Penguin - Man Made Object (2xLP, Album) |
| 4337674407 | SCR0001 | Headhunters - Mojo Rhythm  (12", EP) |
| 4338032589 | #SMR008 | Humb, Iller Instinct (2), Buster (32) - #SMR008 (12", EP) |
| 4176907254 | 1-800-01 | James Blake - Voyeur (Dub) / And Holy Ghost (12", Whi) |
| 4190580342 | N°018 | Kareem Ali (2) - Mawimbi (12") |
| 4337835951 | WB02 | L.D.F.*, Tilman, Byron The Aquarius, Trinidadian Deep - World Beats Vol.2 (12", EP) |
| 4337949513 | LFNYCM001 | Lady Flic Ft. City Hayes - Inside Your Vibration (12", Single) |
| 4246950930 | CAT 017 | Leon Ware - For The Rainbow (12") |
| 4258397847 | 055 | Lesterr - 2 Jahre Dazwischen EP (12", EP, Cle) |
| 4225431048 | 2052Black | Lord* & Dego - BMX Beats (12") |
| 4176341883 | BTL015 | Mike Huckaby - The Jazz Republic (12", RE, 180) |
| 4219791423 | PT016 | Millos Kaiser - Te Quero Perto (12", EP) |
| 4337654211 | AWAY LMTD 002, AWAYLTD002 | Move D & Pete Namlook* - Reissued 002 (12") |
| 4337937294 | BBE763ELP | Musclecars - Double Honey Pack (2x12") |
| 4337943915 | IF1104LP | Nathan Fake - Evaporator (LP, Album, Ltd, cle) |
| 4337951247 | ROOTS 011 | Natural Rhythm - Disco Daze (12") |
| 4222644078 | AOS 1105 | Omar S* - All The Little Hands Around (12") |
| 4222641684 | AOS(2023) | Omar S* - Can't Get (12") |
| 4222642431 | AOS(2021) | Omar S* - Conant Gardens Party Store (12") |
| 4222639188 | AOS891 | Omar S* Featuring Desire (16) - Something Real (12") |
| 4222639845 | AOS(444) | Omar-S - Pain (12", EP) |
| 4222640310 | AOS-432-Z | Omar-S - Psychotic Photosynthesis (No Drum Mix) (12", S/Sided) |
| 4222643232 | AOS2020 | Omar-S - Record Packer Part 4 (Soundtrack) (7", Single, Gre) |
| 4222642821 | AOS2020 | Omar-S - Record Packer Part 4 (Soundtrack) (7", Single, Yel) |
| 4219808982 | WPH 024 | Red D - This Is Still Belgium Vol 2 (12", Cle) |
| 4246948029 | SACREDMEDICINE 05 | Ron Trent Ft. Angel Figueroa* And Pablo Color - Electric Jungle (12") |
| 4373538600 | IARC0112, 0112 | SML (4) - Spontaneous Music Live (LP, Album) |
| 4190905446 | none | Sepalot* - Munich Disco (2x7", Ltd, Col) |
| 4258397478 | 02 | Special Characters - Subsurface Incantations (12", EP) |
| 4372182822 | RV-02 | Termiten - Nordhorn (12", Ltd, RE, RM, Yel) |
| 4243833840 | CAT 016 | The SouL Pops - The Mask EP (12", EP) |
| 4333670103 | RAMAJAM02 | The Wet Steppahz VS. DAPASHU? - Everyone Is A Winner (12") |
| 4246950300 | FSRSV061 | Trinidadian Deep - Deep Rooted Isle (12") |
| 4199145081 | FOKUZ106RP3 | Various - Fokuz All Stars - Part 3 (12") |
| 4200210234 | FOKUZ080.3 | Various - Hateful Eighty Part 3 (12") |
| 4219795119 | KSSV003 | Various - King Street Sounds (12", Smplr) |
| 4200248325 | CPLV01 | Yaroslav Lenzyak - Blesk EP (12", EP) |
| 4372183191 | HZB-3 | Zoo Brazil - The Ambient House Trilogy Part 3 (12", Red) |
| 4219798380 | 015 | cv313 - Fading Lights (12", RE, RM, Gre) |

## Note
`DAT082-COL` (4269072429) shows up as *ambiguous*, but it is already linked correctly. It's a report quirk: the tool doesn't give priority to an exact existing link. No action needed.

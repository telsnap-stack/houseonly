/* === Mother Tongue MP3 + Genre scraper === */
/* Pega esto entero en la consola de Chrome estando en cualquier página de mothertonguerecords.com */
/* Tarda ~3-5 minutos. Al final descarga un JSON automáticamente. */
/* CHANGELOG vs v1: añade extracción de categorías de género desde .posted_in a / .tagged_as a / a[rel="tag"] */

(async () => {
  const URLS = ["https://www.mothertonguerecords.com/product/kaidi-tatham-galaxy/", "https://www.mothertonguerecords.com/product/k15-resonance/", "https://www.mothertonguerecords.com/product/shokazulu-2055-black/", "https://www.mothertonguerecords.com/product/soursop-mango-straight-forward-side-2000black/", "https://www.mothertonguerecords.com/product/2000black-circus-retreat/", "https://www.mothertonguerecords.com/product/shokazulu-vector-sector-what-you-gonna-say/", "https://www.mothertonguerecords.com/product/domu-them-things/", "https://www.mothertonguerecords.com/product/shokazulu/", "https://www.mothertonguerecords.com/product/lord-dego-blacklp009/", "https://www.mothertonguerecords.com/product/dego-love-was-never-your-goal/", "https://www.mothertonguerecords.com/product/2000black-27/", "https://www.mothertonguerecords.com/product/igaxx-echoes/", "https://www.dropbox.com/scl/fo/i41l6eh4h91gz1u7b4xje/h?rlkey=tx1kuj12sah6ol71hpud62vuj&dl=0", "https://www.dropbox.com/scl/fo/csfq3s06e1la80bj4osux/h?rlkey=d03nuoudu5zjxpis5fmxedeg5&dl=0", "https://www.mothertonguerecords.com/product/june-jazzin-show-up/", "https://www.mothertonguerecords.com/product/polyswitch-praise-the-sun/", "https://www.mothertonguerecords.com/product/ezel-rona-ray-hard-to-stay-away/", "https://www.mothertonguerecords.com/product/deon-jamar-ok-dub/", "https://www.mothertonguerecords.com/product/deon-jamar-altars-pt-3/", "https://www.mothertonguerecords.com/product/one-two/", "https://www.mothertonguerecords.com/product/three-four-five/", "https://www.mothertonguerecords.com/product/blacktongue03/", "https://www.mothertonguerecords.com/product/black-aroma-vol-2/", "https://www.mothertonguerecords.com/product/black-aroma-vol-3/", "https://www.mothertonguerecords.com/product/twice-black-aroma-vol-4/", "https://www.mothertonguerecords.com/product/black-aroma-vol-5/", "https://www.mothertonguerecords.com/product/twice-black-aroma-vol-6/", "https://www.mothertonguerecords.com/product/black-aroma-vol-7-repress/", "https://www.mothertonguerecords.com/product/black-aroma-vol-8/", "https://www.mothertonguerecords.com/product/black-aroma-vol-9-repress/", "https://www.mothertonguerecords.com/product/black-aroma-vol-10/", "https://www.mothertonguerecords.com/product/zephaniah-cool-affair-let-me-show-you/", "https://www.mothertonguerecords.com/product/vick-lavender-chicago-blue-line/", "https://www.mothertonguerecords.com/product/mark-francis-feat-nimiwari-exclusively/", "https://www.mothertonguerecords.com/product/coflo-feat-nimiwari/", "https://www.mothertonguerecords.com/product/cool-affair-motoric-patterns/", "https://www.mothertonguerecords.com/product/coflo-cee-loves-masquerade/", "https://www.mothertonguerecords.com/product/melchior-sultana-ghost/", "https://www.mothertonguerecords.com/product/aris-kokou-kalypsos-island-ep/", "https://www.mothertonguerecords.com/product/coflo-emmaculate-infinite-salutations/", "https://www.mothertonguerecords.com/product/vick-lavender-the-esthetic-ep/", "https://www.mothertonguerecords.com/product/vick-lavender-no-ones-going-to-love-you/", "https://www.mothertonguerecords.com/product/athony-nicholson-just-do-it/", "https://www.mothertonguerecords.com/product/anthony-nicholson-we-work-best/", "https://www.mothertonguerecords.com/product/scientific-map-feat-rey-khan-sunrise/", "https://www.mothertonguerecords.com/product/musclecars-shelter/", "https://www.mothertonguerecords.com/product/javonntte-mr-machine/", "https://www.mothertonguerecords.com/product/dj-spinna-og-flips/", "https://www.mothertonguerecords.com/product/laseech-astral-destiny/", "https://www.mothertonguerecords.com/product/terry-tester-space-million/", "https://www.mothertonguerecords.com/product/terry-tester-space-million-remixes/", "https://www.mothertonguerecords.com/product/nejrup-manda-ep/", "https://www.mothertonguerecords.com/product/terry-tester-walkin/", "https://www.mothertonguerecords.com/product/astrid-engberg-trust/", "https://www.mothertonguerecords.com/product/synchojack-sugarhouse/", "https://www.mothertonguerecords.com/product/naquil-krem-de-la-krem/", "https://www.mothertonguerecords.com/product/zopelar-just-like-heaven/", "https://www.mothertonguerecords.com/product/toyin-agbetu-the-dark-knight-rises/", "https://www.mothertonguerecords.com/product/oye-manny-living-water/", "https://www.mothertonguerecords.com/product/guohan-transient-response/", "https://www.mothertonguerecords.com/product/peter-abdul-get-down-with-me/", "https://www.mothertonguerecords.com/product/price-bolingo-ababa-airende/", "https://www.mothertonguerecords.com/product/helen-nkume/", "https://www.mothertonguerecords.com/product/black-beat-disco-nag-funk-machine/", "https://www.mothertonguerecords.com/product/alphonsus-idigo-search/", "https://www.mothertonguerecords.com/product/psk-spell-bound-revolution/", "https://www.mothertonguerecords.com/product/clive-matthewsno-more-victims-this-could-be-loved/", "https://www.mothertonguerecords.com/product/abeng-roberto-sanchez-sun-will-rise-eastern-lights/", "https://www.mothertonguerecords.com/product/bg-and-fibre/", "https://www.mothertonguerecords.com/product/isaiahcollier-cosmictransitions/", "https://www.mothertonguerecords.com/product/isaiah-collier-the-almighty/", "https://www.mothertonguerecords.com/product/oraculu/", "https://www.mothertonguerecords.com/product/hugo-lx-the-platinum-wave/", "https://www.mothertonguerecords.com/product/hugo-lx-what-does-it-do-ep/", "https://www.mothertonguerecords.com/product/collettivo-immaginario-tempo-al-tempo/", "https://www.mothertonguerecords.com/product/collettivo-immaginario-trasforma/", "https://www.mothertonguerecords.com/product/tommaso-cappellato-anti-planeting/", "https://www.mothertonguerecords.com/product/rosa-brunello-reworks/", "https://www.mothertonguerecords.com/product/darand-land-whispers-from-the-lake/", "https://www.mothertonguerecords.com/product/stefan-ringer-marquinn-mason-bounce-lessons/", "https://www.mothertonguerecords.com/product/last-nubian-we-celebrate-us-ep/", "https://www.mothertonguerecords.com/product/eglo-records-volume-3-sampler/", "https://www.mothertonguerecords.com/product/alex-nut-under-construction/", "https://www.mothertonguerecords.com/product/giles-smith-i-can-change-your-life/", "https://www.mothertonguerecords.com/product/pau-roca-feat-laura-elle-your-energy/", "https://www.mothertonguerecords.com/product/uptown-funk-empire-youve-got-to-have-freedom-the-dance-culture-remixes/", "https://www.mothertonguerecords.com/product/brighter-darker/", "https://www.mothertonguerecords.com/product/culross-close-pressure/", "https://www.mothertonguerecords.com/product/k15-rituals/", "https://www.mothertonguerecords.com/product/culross-close-learning-to-let-go/", "https://www.mothertonguerecords.com/product/k15-hope-is-perseverance/", "https://www.mothertonguerecords.com/product/drasii-spirito-celeste/", "https://www.mothertonguerecords.com/product/dimdi-welcome-to-this-world-ep/", "https://www.mothertonguerecords.com/product/coma-chi-water/", "https://www.mothertonguerecords.com/product/aleqs-notal-supply-shuttle/", "https://www.mothertonguerecords.com/product/laseech-desney-bailey-hey-love/", "https://www.mothertonguerecords.com/product/specter-in-case-u-forgot-ep/", "https://www.mothertonguerecords.com/product/innervibe-memory-playground/", "https://www.mothertonguerecords.com/product/v-a-various-shades-vol-1/", "https://www.mothertonguerecords.com/product/zopelar-primal-vision/", "https://www.mothertonguerecords.com/product/stefano-nardon-mangrovia-underwater/", "https://www.mothertonguerecords.com/product/peven-everett-tony-touch-no-wonder/", "https://www.mothertonguerecords.com/product/soul-ii-soul-nothing-compares-to-you/", "https://www.mothertonguerecords.com/product/lanote-rebirth/", "https://www.mothertonguerecords.com/product/deborah-jordan-the-light/", "https://www.mothertonguerecords.com/product/mark-rapson-darkvslight/", "https://www.mothertonguerecords.com/product/mark-grusane-bad-cavity-ep/", "https://www.mothertonguerecords.com/product/mark-grusane/", "https://www.mothertonguerecords.com/product/josh-milan-dance-with-me/", "https://www.mothertonguerecords.com/product/cesar-de-melero-mr-claude/", "https://www.mothertonguerecords.com/product/dubbyman-obsession/", "https://www.mothertonguerecords.com/product/pau-roca-late-night-illusions/", "https://www.mothertonguerecords.com/product/constantine-weir-aka-yahya-people-power/", "https://www.mothertonguerecords.com/product/zy-the-way-then-and-now/", "https://www.mothertonguerecords.com/product/corica-normanno-byron-the-aquarius-oltremare/", "https://www.mothertonguerecords.com/product/urban-art-orchestra-live-in-detroit-vol-1/", "https://www.mothertonguerecords.com/product/urban-art-orchestra-live-in-detroit-vol-2/", "https://www.mothertonguerecords.com/product/game-plan-offset/", "https://www.mothertonguerecords.com/product/fabrizio-fattore-magic-happens/", "https://www.mothertonguerecords.com/product/fabrizio-fattore-shades/", "https://www.mothertonguerecords.com/product/loftsoul-new-version-ep/", "https://www.mothertonguerecords.com/product/los-hermanos-on-another-level/", "https://www.mothertonguerecords.com/product/salaam-remi/", "https://www.mothertonguerecords.com/product/mkl-forever-love/", "https://www.mothertonguerecords.com/product/theo-parrish-lovely-edits-vol-1/", "https://www.mothertonguerecords.com/product/maytra-dusk-to-dawn/", "https://www.mothertonguerecords.com/product/steal-vybe-terrance-down-when-you-feel/", "https://www.mothertonguerecords.com/product/afronaut-feat-just-one-ground-zero/", "https://www.mothertonguerecords.com/product/shezar-vibrational-sounds-ep/", "https://www.mothertonguerecords.com/product/demuir-seasons-ep/", "https://www.mothertonguerecords.com/product/trinidadian-deep-project-nasty-ep/", "https://www.mothertonguerecords.com/product/javonntte-jamesey-mars-theory-kai-alce-edits/", "https://www.mothertonguerecords.com/product/mdcl-midnight-snacks-02/", "https://www.mothertonguerecords.com/product/mark-de-clive-lowe-mbms03/", "https://www.mothertonguerecords.com/product/midnight-snacks-remixed-mark-de-clive-lowe/", "https://www.mothertonguerecords.com/product/tommaso-cappellaio-explorare/", "https://www.mothertonguerecords.com/product/julio-deangelo-maybe-hill-ep/", "https://www.mothertonguerecords.com/product/julion-deangelo-consciousness/", "https://www.mothertonguerecords.com/product/char-create-the-life/", "https://www.mothertonguerecords.com/product/bread-souls-chapter-1/", "https://www.mothertonguerecords.com/product/bread-souls-a-family-gathering-chapter-2/", "https://www.mothertonguerecords.com/product/bread-souls-chapter-4/", "https://www.mothertonguerecords.com/product/bread-souls-find-the-beauty/", "https://www.mothertonguerecords.com/product/jovonn-mt-neroli-ep/", "https://www.mothertonguerecords.com/product/tommaso-cappellato-butterflying/", "https://www.mothertonguerecords.com/product/gin-tonic-orchestra-stefania-ep/", "https://www.mothertonguerecords.com/product/sofea-ft-dj-spinna-galactic-funk-rmx/", "https://www.mothertonguerecords.com/product/the-aquarius-years-feat-robert-glasper-bilal-ecussionist/", "https://www.mothertonguerecords.com/product/volume-1/", "https://www.mothertonguerecords.com/product/mario-acquaviva/", "https://www.mothertonguerecords.com/product/mark-de-clive-lowe-andrea-lombardini-tommaso-cappellato/", "https://www.mothertonguerecords.com/product/los-hermanos-gerald-mitchell-billy-love-bob-rogue/", "https://www.mothertonguerecords.com/product/gerald-mitchell/", "https://www.mothertonguerecords.com/product/madre-lingua-repress/", "https://www.mothertonguerecords.com/product/malik-alston-in-a-better-way/", "https://www.mothertonguerecords.com/product/madre-lingua-remixes/", "https://www.mothertonguerecords.com/product/edb-the-long-way-up/", "https://www.mothertonguerecords.com/product/tiombe-lockhart-an-isirian-dream/", "https://www.mothertonguerecords.com/product/k15-curloss-colse-volume-2/", "https://www.mothertonguerecords.com/product/los-hermanos-family/", "https://www.mothertonguerecords.com/product/julion-deangelo-nownormal/", "https://www.mothertonguerecords.com/product/patrick-gibin-strenght-in-numbers/", "https://www.mothertonguerecords.com/product/trombe-lockhart-coming-forth-by-day/", "https://www.mothertonguerecords.com/product/patrick-gibin-joe-claussell-remixes/", "https://www.mothertonguerecords.com/product/dreamweavers-ii/", "https://www.mothertonguerecords.com/product/edb-koeru/", "https://www.mothertonguerecords.com/product/gary-superfly-feat-other-lands/", "https://www.mothertonguerecords.com/product/sexy-suzy-on-a-sunday-feat-bilal-remixes/", "https://www.mothertonguerecords.com/product/zopelar-entreviagens-vista/", "https://www.dropbox.com/scl/fo/v2wmn7xkxu8axejzvyfj3/h?rlkey=zog9kok6i186ic0j1pkhsrc2i&dl=0", "https://www.dropbox.com/scl/fo/crrolb5mncveibr0yb0yr/h?rlkey=7sw6sq9lipco3lmua1c2d8m8j&dl=0", "https://www.mothertonguerecords.com/product/amane-moments-of-solace/", "https://www.mothertonguerecords.com/product/samuele-strufaldi-davorio/", "https://www.mothertonguerecords.com/product/yelfris-valdes-for-the-ones-remixed/", "https://www.mothertonguerecords.com/product/domu-vs-dego/", "https://www.mothertonguerecords.com/product/patrice-scott-chasing-dreams/", "https://www.mothertonguerecords.com/product/reaching-for-the-stars/", "https://www.mothertonguerecords.com/product/emotional-intelligence-its-up-to-me/", "https://www.mothertonguerecords.com/product/some-sweet-ting-atmospheric-funk-sounds-of-the-rebel/", "https://www.mothertonguerecords.com/product/love-to-the-world/", "https://www.mothertonguerecords.com/product/deenamic/", "https://www.mothertonguerecords.com/product/lee-pearson-jr-collective/", "https://www.mothertonguerecords.com/product/the-abstract-eye-epileptixep/", "https://www.mothertonguerecords.com/product/va-inside-pt2/", "https://www.mothertonguerecords.com/product/lord-kaidi-find-another-way/", "https://www.mothertonguerecords.com/product/dego-2000blackfamily-ep-iv/", "https://www.mothertonguerecords.com/product/nathan-haines-phil-asher-journey-to-the-peak/", "https://www.mothertonguerecords.com/product/kirk-degiorgio-robe-of-dreams/", "https://www.mothertonguerecords.com/product/domu-down-and-up/", "https://www.mothertonguerecords.com/product/inside-vol-3/", "https://www.mothertonguerecords.com/product/kirk-degiorgio-the-statement/", "https://www.mothertonguerecords.com/product/trinidadian-deep-light-work-productions-ep/", "https://www.mothertonguerecords.com/product/neroli-the-secondo-circle/", "https://www.mothertonguerecords.com/product/nicola-kramer-nrlfta001/", "https://www.mothertonguerecords.com/product/ricardo-miranda-peace-and-strength/", "https://www.mothertonguerecords.com/product/inside-vol-1/", "https://www.mothertonguerecords.com/product/lee-pearson-jr-artistry-ep/", "https://www.mothertonguerecords.com/product/trinidadian-deep-lars-bartkuhn-sonics-movements/", "https://www.mothertonguerecords.com/product/our-own-organization-2-finger-hash-band/", "https://www.mothertonguerecords.com/product/simon-paw-inner-space/", "https://www.mothertonguerecords.com/product/pezzate-002/", "https://www.mothertonguerecords.com/product/marcello-napoletano-private-collection-001/", "https://www.mothertonguerecords.com/product/fred-p/", "https://www.mothertonguerecords.com/product/fred-p-private-society-vol2/", "https://www.mothertonguerecords.com/product/fred-p-private-society-3/", "https://www.mothertonguerecords.com/product/fred-p-abstract-soul/", "https://www.mothertonguerecords.com/product/fred-p-private-society-vol4/", "https://www.mothertonguerecords.com/product/fred-p-state-of-bliss-pt1/", "https://www.mothertonguerecords.com/product/fred-p-2/", "https://www.mothertonguerecords.com/product/fred-p-smbd-when-the-mantras-return/", "https://www.mothertonguerecords.com/product/fred-p-private-society-vol5/", "https://www.mothertonguerecords.com/product/darand-land-the-vermillion-room/", "https://www.mothertonguerecords.com/product/osunlade-malcolm-bliss/", "https://www.mothertonguerecords.com/product/william-florelle-red-velvet/", "https://www.mothertonguerecords.com/product/dj-spinna/", "https://www.mothertonguerecords.com/product/dj-spinna-refreakedvol-2/", "https://www.mothertonguerecords.com/product/trinidadian-deep-sonic-vibrations/", "https://www.mothertonguerecords.com/product/heat05/", "https://www.mothertonguerecords.com/product/darone-sassounian-synthetic-instincts/", "https://www.mothertonguerecords.com/product/ron-trent-joe-claussel-black-magic-woman/", "https://www.mothertonguerecords.com/product/ron-trent-magic-carnival/", "https://www.mothertonguerecords.com/product/ron-trent-sensual/", "https://www.mothertonguerecords.com/product/coflo-tsunamis-muse/", "https://www.mothertonguerecords.com/product/dj-f-clima-futuros/", "https://www.mothertonguerecords.com/product/patrice-scott-my-desire/", "https://www.mothertonguerecords.com/product/alton-miller-last-africa-jams/", "https://www.mothertonguerecords.com/product/reggie-dokes-electronic-dreams-2025-revision/", "https://www.mothertonguerecords.com/product/computer-jay-feat-orfeo-cocaine-kisses/", "https://www.mothertonguerecords.com/product/the-abstract-eye-you-cant-unsee-me/", "https://www.mothertonguerecords.com/product/the-abstract-eye-nine-oh-nine-ep/", "https://www.mothertonguerecords.com/product/gb-yamaheaters/", "https://www.mothertonguerecords.com/product/the-reflektor-taino-ep/", "https://www.mothertonguerecords.com/product/va-best-of-various-tlm025/", "https://www.mothertonguerecords.com/product/takashi-nakazato-toshiafroep/", "https://www.mothertonguerecords.com/product/future-jazz-ensemble-roughtimes/", "https://www.mothertonguerecords.com/product/best-of-various-tlm029/", "https://www.mothertonguerecords.com/product/v-a-best-of-various-tlm030/", "https://www.mothertonguerecords.com/product/best-of-various-tlm031/", "https://www.mothertonguerecords.com/product/cumulative-collective-refill-the-coin-vol-1/", "https://www.mothertonguerecords.com/product/best-of-various-tlm035/", "https://www.mothertonguerecords.com/product/v-a-the-coin-ep-vol-2/", "https://www.mothertonguerecords.com/product/marcello-cassanelli-caruso-helen-mccormack-the-coin-ep-vol-3/", "https://www.mothertonguerecords.com/product/frisson-ep-part-1/", "https://www.mothertonguerecords.com/product/sofatalk-organica-untoldstories/", "https://www.mothertonguerecords.com/product/javonntte-wind-of-seven-seas/", "https://www.mothertonguerecords.com/product/stefano-de-santis-barra-nova/", "https://www.mothertonguerecords.com/product/marcello-cassanelli-espresso-they-groove/", "https://www.mothertonguerecords.com/product/caruso-thank-you-breath-for-me/", "https://www.mothertonguerecords.com/product/patrick-gibin-javonntte-flash-point-wind-of-seven-seas/", "https://www.mothertonguerecords.com/product/stretto-erik-escobar/", "https://www.mothertonguerecords.com/product/javonntte-flight77/", "https://www.mothertonguerecords.com/product/33-10-3402-labyrinths-and-coral-caves/", "https://www.mothertonguerecords.com/product/anatolian-weapons-desert-sun/", "https://www.mothertonguerecords.com/product/colosimo-shoshin/", "https://www.mothertonguerecords.com/product/reekee-no-one/", "https://www.mothertonguerecords.com/product/v-a-time-to-play-first-step/", "https://www.mothertonguerecords.com/product/zepherin-saint-feat-aint-gonna-do-you-wrong/", "https://www.mothertonguerecords.com/product/malik-alston-outside-of-the-box/", "https://www.mothertonguerecords.com/product/malik-alston-beyond-jazz-vol1/", "https://www.mothertonguerecords.com/product/malik-alston-beyond-jazz-vol-2/", "https://www.mothertonguerecords.com/product/takuya-matsumoto-drawer-tracks/", "https://www.mothertonguerecords.com/product/v-a-the-jazz-avengers/", "https://www.mothertonguerecords.com/product/hanna-game-set-e-match/", "https://www.mothertonguerecords.com/product/va-galactic-disco-ep/", "https://www.mothertonguerecords.com/product/your-ex-lost-shadows-ep/", "https://www.mothertonguerecords.com/product/takuya-matsumoto-vertical-stories/", "https://www.mothertonguerecords.com/product/dj-compufunk-deep-space-protocol/", "https://www.mothertonguerecords.com/product/theevolutionphasethree/", "https://www.mothertonguerecords.com/product/gordonbass-perpetualpeace-ep/", "https://www.mothertonguerecords.com/product/alexattias-el-mustang/", "https://www.mothertonguerecords.com/product/petros-klampanis-chroma-reworks/", "https://www.mothertonguerecords.com/product/alex-attias-pres-el-mustang/", "https://www.mothertonguerecords.com/product/sohan-wilson/", "https://www.mothertonguerecords.com/product/evolution-phase-four-visio048/", "https://www.mothertonguerecords.com/product/sohan-wilson-love-is-the-key/", "https://www.mothertonguerecords.com/product/alex-attias-stephane-attias-in-my-mind-ep/", "https://www.mothertonguerecords.com/product/specter-julian-deangelo-tango-drunken-noodles/", "https://www.mothertonguerecords.com/product/alex-attias-i-wanna-know-remixes/", "https://www.mothertonguerecords.com/product/terri-walker-my-love-story/", "https://www.mothertonguerecords.com/product/mikekon-bta-lets-start-again/", "https://www.mothertonguerecords.com/product/kat-rose-mikekon-i-see-you/", "https://www.mothertonguerecords.com/product/a-conversation-through-music/", "https://www.mothertonguerecords.com/product/carmen-rodgers-again-and-again-dj-spinna/", "https://www.mothertonguerecords.com/product/let-it-fall-dj-spinna-galactic-soul-remix/", "https://www.mothertonguerecords.com/product/mr-chameleon-red-eye-dj-spinna-remixes/", "https://www.mothertonguerecords.com/product/back-to-us-ft-dj-spinna-remixes/", "https://www.mothertonguerecords.com/product/hugo-lx-transcendance-ep/", "https://www.mothertonguerecords.com/product/stim-dzyl-kilomanjaro/", "https://www.mothertonguerecords.com/product/reggie-b-inkswel-gods-way/", "https://www.mothertonguerecords.com/product/carmen-rodgers-free/", "https://www.mothertonguerecords.com/product/yellow-jackets-vol-1/", "https://www.mothertonguerecords.com/product/ron-trent-other-lands-yellow-jackets-vol2/", "https://www.mothertonguerecords.com/product/yellow-jackets-vol3/", "https://www.mothertonguerecords.com/product/fred-p-specter-jose-rico-yellow-jackets-4/", "https://www.mothertonguerecords.com/product/marcellus-pittman-hieroglyphic-being-yellow-jackets-5/", "https://www.mothertonguerecords.com/product/yellow-jackets-vol-6/", "https://www.mothertonguerecords.com/product/yellow-jackets-vol-7/", "https://www.mothertonguerecords.com/product/yellow-jackets-vol-8/", "https://www.mothertonguerecords.com/product/rawb-boss-coafeella/", "https://www.mothertonguerecords.com/product/nomadics-better-man-yoruba-soul/"];
  const results = [];
  const errors = [];
  let done = 0;

  console.log(`%c🎵 Mother Tongue scraper iniciado · ${URLS.length} releases`, 'color:#c8ff00;font-weight:bold;font-size:14px');

  // Concurrencia: 4 requests en paralelo (educado con su servidor)
  const BATCH_SIZE = 4;
  const DELAY_BETWEEN_BATCHES = 200; // ms

  // Helper: extract WooCommerce category names from a parsed document.
  // Mother Tongue uses standard WooCommerce single-product markup, where
  // categories live in a `.posted_in` span (and tags in `.tagged_as`),
  // each containing one or more `<a rel="tag" href="/product-category/...">`.
  // We scan both selectors plus any `a[rel="tag"]` whose href points at
  // `/product-category/` to be resilient to theme variations. The text
  // inside each <a> is the human-readable category name.
  function extractGenres(doc) {
    const seen = new Set();
    const genres = [];

    const collectFrom = (selector) => {
      doc.querySelectorAll(selector).forEach(a => {
        const text = a.textContent.trim();
        if (!text) return;
        // Skip the literal label text "Categories:" / "Tags:" if it gets matched.
        if (/^(Categories?|Tags?):?$/i.test(text)) return;
        const key = text.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        genres.push(text);
      });
    };

    collectFrom('.posted_in a');
    collectFrom('.tagged_as a');
    // Some WC themes put rel=tag links outside of .posted_in; only accept those
    // pointing to /product-category/ to avoid grabbing unrelated tag widgets.
    doc.querySelectorAll('a[rel="tag"]').forEach(a => {
      const href = a.getAttribute('href') || '';
      if (!href.includes('/product-category/')) return;
      const text = a.textContent.trim();
      if (!text) return;
      if (/^(Categories?|Tags?):?$/i.test(text)) return;
      const key = text.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      genres.push(text);
    });

    return genres;
  }

  async function fetchOne(url) {
    try {
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const html = await res.text();

      // Extraer todas las URLs de MP3 que aparezcan en el HTML
      const mp3Regex = /https:\/\/www\.mothertonguerecords\.com\/wp-content\/uploads\/[^"'\s)]+\.mp3/gi;
      const mp3s = [...new Set((html.match(mp3Regex) || []))];

      // Intentar extraer nombres de track del HTML
      // Pattern típico de WP audio shortcode: <strong>Track Name</strong> ... <a href="...mp3">
      // O títulos cerca del player
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      // Buscar título del producto
      const productTitle = doc.querySelector('h1')?.textContent?.trim() || '';

      // Buscar artist (segundo h1 o h2 cerca del precio)
      const allHeadings = [...doc.querySelectorAll('h1, h2')].map(h => h.textContent.trim()).filter(Boolean);

      // Cover image
      const coverImg = doc.querySelector('meta[property="og:image"]')?.content || '';

      // Extraer descripción desde meta
      const description = doc.querySelector('meta[property="og:description"]')?.content || '';

      // NEW: extract WooCommerce product categories as genres.
      const genres = extractGenres(doc);

      // Intentar mapear cada MP3 a su nombre de track
      // Estrategia: buscar el contexto cercano al link del MP3 en el HTML
      const tracks = mp3s.map(mp3Url => {
        const filename = mp3Url.split('/').pop().replace(/\.mp3$/i, '');
        // Buscar el bloque que contiene este URL y extraer el <strong> más cercano antes
        const idx = html.indexOf(mp3Url);
        let trackName = filename;
        if (idx > 0) {
          // Mirar 800 chars antes del URL para encontrar <strong>...</strong>
          const before = html.substring(Math.max(0, idx - 800), idx);
          const strongs = [...before.matchAll(/<strong>([^<]+)<\/strong>/gi)];
          if (strongs.length > 0) {
            trackName = strongs[strongs.length - 1][1].trim();
          }
        }
        return { name: trackName, filename: filename, url: mp3Url };
      });

      return {
        url: url,
        ok: true,
        page_title: productTitle,
        headings: allHeadings,
        cover: coverImg,
        description: description,
        genres: genres,           // NEW
        tracks: tracks,
        track_count: tracks.length,
      };
    } catch (e) {
      return { url: url, ok: false, error: String(e) };
    }
  }

  for (let i = 0; i < URLS.length; i += BATCH_SIZE) {
    const batch = URLS.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(fetchOne));
    for (const r of batchResults) {
      if (r.ok) results.push(r);
      else errors.push(r);
      done++;
    }
    const pct = Math.round(done / URLS.length * 100);
    // Show genres found in last batch alongside track count, so progress log
    // confirms the new field is being populated.
    const lastSummary = batchResults.map(b => {
      if (!b.ok) return 'X';
      return `${b.tracks?.length ?? 0}t/${b.genres?.length ?? 0}g`;
    }).join(',');
    console.log(`  ${done}/${URLS.length} (${pct}%) · last batch: ${lastSummary}`);
    if (i + BATCH_SIZE < URLS.length) {
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_BATCHES));
    }
  }

  const totalTracks = results.reduce((s, r) => s + r.tracks.length, 0);
  const totalGenres = results.reduce((s, r) => s + (r.genres?.length || 0), 0);
  const releasesWithGenres = results.filter(r => (r.genres?.length || 0) > 0).length;
  console.log(`%c✅ Listo · ${results.length} releases · ${totalTracks} tracks · ${totalGenres} genre tags (${releasesWithGenres}/${results.length} releases tagged) · ${errors.length} errores`, 'color:#c8ff00;font-weight:bold;font-size:14px');
  if (errors.length > 0) console.log('Errores:', errors);

  // Descargar JSON
  const payload = {
    scraped_at: new Date().toISOString(),
    total_releases: results.length,
    total_tracks: totalTracks,
    total_genre_tags: totalGenres,
    errors: errors,
    releases: results,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'mt_enrichment_' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(url);
  console.log('%c📥 JSON descargado. Súbelo a Claude.', 'color:#c8ff00;font-weight:bold');

  window._mtScrapeResults = payload; // por si quieres inspeccionar
})();

import { useState, useRef, useEffect } from "react";

const S = {
  bg:'#080808', surf:'#111', border:'#1e1e1e',
  text:'#efefef', muted:'#585858', accent:'#c8ff00', danger:'#ff4040',
};

// ── SHOPIFY ────────────────────────────────────────────────────
const SHOPIFY = {
  domain: 'house-only-2.myshopify.com',
  token:  import.meta.env.VITE_SHOPIFY_TOKEN || '3edf470af24f9bd4b81bca274121eec4',
  api:    '2024-01',
};

async function shopifyQuery(query, variables={}) {
  const resp = await fetch(
    `https://${SHOPIFY.domain}/api/${SHOPIFY.api}/graphql.json`,
    { method:'POST', headers:{ 'Content-Type':'application/json', 'X-Shopify-Storefront-Access-Token':SHOPIFY.token }, body:JSON.stringify({ query, variables }) }
  );
  const data = await resp.json();
  if (data.errors) throw new Error(data.errors[0].message);
  return data.data;
}

const GENRE_TAGS = ['Detroit House','Chicago House','Afro House','Soulful House','Acid House','Disco House','Tech House','Deep House','Electronic','Nu-Disco','Funk','Soul','Jazz','Electronica','Ambient','Techno','Drum & Bass','Breakbeat','Reggae','Dub','Hip Hop','R&B'];
const SKIP_TAGS  = ['vinyl','house','kudos',...GENRE_TAGS.map(g=>g.toLowerCase())];

// ── SLUG (industry-standard SEO-friendly URLs: artist-title) ───
function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // strip accents
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}
function makeSlug(artist, title, catalog) {
  const base = [artist, title].filter(Boolean).join(' ');
  const s = slugify(base);
  if (s) return s;
  return slugify(catalog) || 'release';
}

function parseProduct({ node }) {
  const v    = node.variants.edges[0]?.node;
  const img  = node.images.edges[0]?.node;
  const tags = node.tags || [];
  const genre = GENRE_TAGS.find(g => tags.some(t => t.toLowerCase() === g.toLowerCase()))
    || tags.find(t => !SKIP_TAGS.some(s => s.toLowerCase()===t.toLowerCase()) && !/^\d{4}$/.test(t) && !/^label:/i.test(t) && !/^(12|excl|lp|ep|single|vinyl|kudos)/i.test(t))
    || '';
  const year  = parseInt(tags.find(t => /^\d{4}$/.test(t)) || '0');
  const label = tags.find(t => t.toLowerCase().startsWith('label:'))?.slice(6).trim()
    || tags.find(t => !SKIP_TAGS.some(s => s.toLowerCase()===t.toLowerCase()) && !/^\d{4}$/.test(t) && !/^(12|excl|lp|ep|single)/i.test(t)) || '';
  const bodyHtml = node.descriptionHtml || '';
  const cleanHtml = bodyHtml.replace(/<script[\s\S]*?<\/script>/gi, '');
  const desc  = cleanHtml.replace(/<[^>]+>/g,'').trim() || '';
  const artist= node.vendor || (desc.includes(' — ') ? desc.split(' — ')[0].trim() : '');
  let tracks = [];
  const tracksMatch = bodyHtml.match(/<script[^>]+id="tracks"[^>]*>([\s\S]*?)<\/script>/);
  if (tracksMatch) { try { tracks = JSON.parse(tracksMatch[1]); } catch {} }
  const catalog = v?.sku||'';
  const title = node.title||'';
  return {
    id: node.id, shopifyVariantId: v?.id,
    title, artist, label,
    catalog, genre, year,
    slug: makeSlug(artist, title, catalog),
    month: new Date().getMonth()+1,
    price: parseFloat(v?.price?.amount||18.99),
    stock: v?.quantityAvailable??10,
    coverUrl: img?.url||null, tracks, desc, g:'135deg,#1a1a2e,#16213e',
  };
}

async function fetchShopifyProducts(cursor=null) {
  const after = cursor ? `, after: "${cursor}"` : '';
  const data = await shopifyQuery(`{
    products(first: 24${after}) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id title vendor descriptionHtml tags
          variants(first:1) { edges { node { id sku price { amount currencyCode } quantityAvailable } } }
          images(first:1) { edges { node { url } } }
        }
      }
    }
  }`);
  const { edges, pageInfo } = data.products;
  return { products: edges.map(parseProduct), hasNextPage: pageInfo.hasNextPage, endCursor: pageInfo.endCursor };
}

// ── CHECKOUT ───────────────────────────────────────────────────
async function shopifyCheckout(cartItems) {
  const lines = cartItems
    .filter(i => i.shopifyVariantId)
    .map(i => ({ merchandiseId: i.shopifyVariantId, quantity: i.qty }));
  if (!lines.length) throw new Error('No items in cart.');
  const data = await shopifyQuery(
    `mutation cartCreate($input: CartInput!) {
      cartCreate(input: $input) {
        cart { checkoutUrl }
        userErrors { field message }
      }
    }`,
    { input: { lines } }
  );
  const errs = data.cartCreate?.userErrors;
  if (errs?.length) throw new Error(errs.map(e => e.message).join(', '));
  const rawUrl = data.cartCreate?.cart?.checkoutUrl;
  if (!rawUrl) throw new Error('No checkoutUrl in response: ' + JSON.stringify(data));
  window.open(rawUrl.replace('houseonly.store', 'checkout.houseonly.store'), '_blank');
}

// ── WORKER / R2 ────────────────────────────────────────────────
const WORKER_URL = import.meta.env.VITE_WORKER_URL || 'https://houseonly-worker.emontagut.workers.dev';

async function uploadToR2(blob, key, mimeType) {
  const fd = new FormData();
  fd.append('file', new File([blob], key.split('/').pop(), { type: mimeType }));
  fd.append('key', key);
  const r = await fetch(`${WORKER_URL}?action=upload`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`R2 upload failed: ${r.status}`);
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.url;
}

async function fetchCoverArt(title, artist, ean, label='', year='', catno='') {
  try {
    const params = new URLSearchParams();
    if (ean)    params.set('ean', String(ean).trim());
    if (title)  params.set('title', title);
    if (artist) params.set('artist', artist);
    if (label)  params.set('label', label);
    if (year)   params.set('year', String(year));
    if (catno)  params.set('catno', catno);
    const r = await fetch(`${WORKER_URL}?${params.toString()}`);
    if (!r.ok) return '';
    const d = await r.json();
    return d.imageUrl || '';
  } catch { return ''; }
}

// ── LOGO ──────────────────────────────────────────────────────
function Logo({ scale=1, onClick }) {
  return (
    <svg width={160*scale} height={52*scale} viewBox="0 0 160 52" style={{ display:'block', cursor:onClick?'pointer':'default', flexShrink:0 }} onClick={onClick}>
      <text x="0" y="34" fontSize="36" fontWeight="900" fill="#efefef" fontFamily="'Inter',system-ui,sans-serif" letterSpacing="-1">HOUSE</text>
      <rect x="0" y="38" width="148" height="3" fill="#c8ff00"/>
      <text x="0" y="52" fontSize="36" fontWeight="900" fill="#c8ff00" fontFamily="'Inter',system-ui,sans-serif" letterSpacing="-1">ONLY</text>
    </svg>
  );
}

// ── SHARED UI ──────────────────────────────────────────────────
function Btn({ ch, onClick, variant='primary', disabled, full }) {
  const v = {
    primary:{ background:S.accent, color:'#080808', border:'none' },
    ghost:{ background:'transparent', color:S.text, border:`1px solid ${S.border}` },
    dark:{ background:S.border, color:S.muted, border:'none' },
  };
  return (
    <button onClick={disabled?null:onClick} style={{ ...v[variant], cursor:disabled?'not-allowed':'pointer', fontFamily:'inherit', fontWeight:700, letterSpacing:1.5, textTransform:'uppercase', fontSize:10, borderRadius:2, padding:'10px 18px', opacity:disabled?0.35:1, width:full?'100%':undefined, transition:'opacity 0.15s', whiteSpace:'nowrap' }}>{ch}</button>
  );
}

function coverSrc(url) {
  if (!url) return null;
  if (url.includes('discogs.com')) return `https://images.weserv.nl/?url=${encodeURIComponent(url)}&w=300&output=jpg`;
  return url;
}

function AudioPlayer({ src }) {
  const ref = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [prog, setProg] = useState(0);
  const toggle = () => {
    if (!src) return;
    if (playing) { ref.current.pause(); setPlaying(false); }
    else { ref.current.play().catch(()=>{}); setPlaying(true); }
  };
  useEffect(() => {
    const a = ref.current; if (!a) return;
    const u = () => setProg((a.currentTime/a.duration)*100||0);
    const e = () => { setPlaying(false); setProg(0); };
    a.addEventListener('timeupdate',u); a.addEventListener('ended',e);
    return () => { a.removeEventListener('timeupdate',u); a.removeEventListener('ended',e); };
  }, []);
  return (
    <div style={{ display:'flex', alignItems:'center', gap:10 }}>
      {src&&<audio ref={ref} src={src} />}
      <button onClick={toggle} disabled={!src} style={{ width:32, height:32, borderRadius:'50%', background:src?S.accent:S.border, border:'none', cursor:src?'pointer':'not-allowed', fontSize:12, color:src?'#080808':S.muted, flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center' }}>{playing?'⏸':'▶'}</button>
      <div style={{ flex:1, height:2, background:S.border, borderRadius:1, overflow:'hidden' }}>
        <div style={{ width:`${prog}%`, height:'100%', background:S.accent, transition:'width 0.1s' }} />
      </div>
      <span style={{ fontSize:9, color:S.muted, letterSpacing:1, whiteSpace:'nowrap' }}>{src?'SNIPPET':'NO PREVIEW'}</span>
    </div>
  );
}

// ── RECORD CARD ────────────────────────────────────────────────
function RecordCard({ r, onOpen, onAdd }) {
  const [hov, setHov] = useState(false);
  return (
    <div onMouseEnter={()=>setHov(true)} onMouseLeave={()=>setHov(false)} style={{ background:S.surf, border:`1px solid ${hov?'#2e2e2e':S.border}`, borderRadius:3, overflow:'hidden', transition:'border 0.15s, transform 0.15s', transform:hov?'translateY(-2px)':'none' }}>
      <div style={{ position:'relative', paddingBottom:'100%', cursor:'pointer' }} onClick={()=>onOpen(r)}>
        <div style={{ position:'absolute', inset:0, background:`linear-gradient(${r.g})`, backgroundImage:coverSrc(r.coverUrl)?`url(${coverSrc(r.coverUrl)})`:'none', backgroundSize:'cover', backgroundPosition:'center' }}>
          <div style={{ position:'absolute', bottom:0, left:0, right:0, padding:'4px 8px', background:'rgba(0,0,0,0.5)', fontFamily:'monospace', fontSize:7, color:'rgba(255,255,255,0.35)', letterSpacing:2 }}>{r.catalog}</div>
          {hov&&<div style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.55)', display:'flex', alignItems:'center', justifyContent:'center', backdropFilter:'blur(2px)' }}><span style={{ color:S.text, fontSize:10, letterSpacing:2, fontWeight:700, textTransform:'uppercase' }}>View Details</span></div>}
        </div>
      </div>
      <div style={{ padding:'12px 12px 14px' }}>
        <div style={{ fontSize:9, color:S.muted, letterSpacing:1.5, textTransform:'uppercase', marginBottom:3 }}>{r.label}</div>
        <div style={{ fontSize:13, fontWeight:700, color:S.text, lineHeight:1.3, marginBottom:2 }}>{r.title}</div>
        <div style={{ fontSize:11, color:S.muted, marginBottom:10 }}>{r.artist}</div>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <span style={{ fontSize:15, fontWeight:800, color:S.accent }}>€{r.price.toFixed(2)}</span>
          <button onClick={e=>{e.stopPropagation();onAdd(r);}} disabled={r.stock===0} style={{ background:hov&&r.stock>0?S.accent:S.border, color:hov&&r.stock>0?'#080808':S.muted, border:'none', borderRadius:2, cursor:r.stock===0?'not-allowed':'pointer', fontSize:9, fontWeight:700, letterSpacing:1.5, padding:'5px 10px', textTransform:'uppercase', transition:'all 0.15s', opacity:r.stock===0?0.4:1 }}>{r.stock===0?'Sold Out':'+ Cart'}</button>
        </div>
        {r.stock>0&&r.stock<=3&&<div style={{ fontSize:8, color:'#ff8800', marginTop:5, letterSpacing:1, textTransform:'uppercase' }}>Only {r.stock} left</div>}
        {r.stock===0&&<div style={{ fontSize:8, color:S.danger, marginTop:5, letterSpacing:1, textTransform:'uppercase' }}>Out of stock</div>}
      </div>
    </div>
  );
}

// ── MODAL ──────────────────────────────────────────────────────
function cleanTrackName(name) {
  return name.replace(/^\d+_\d+_/, '').trim();
}

function TrackPlayer({ tracks }) {
  const [playing, setPlaying] = useState(null);
  const [prog, setProg] = useState(0);
  const audioRef = useRef(null);
  const play = (i) => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.src = ''; }
    if (playing === i) { setPlaying(null); setProg(0); return; }
    const a = new Audio(tracks[i].url);
    audioRef.current = a;
    a.play().catch(()=>{});
    setPlaying(i);
    a.ontimeupdate = () => setProg((a.currentTime / a.duration) * 100 || 0);
    a.onended = () => { setPlaying(null); setProg(0); };
  };
  useEffect(() => () => audioRef.current?.pause(), []);
  return (
    <div style={{ marginBottom:14 }}>
      {tracks.map((t, i) => (
        <div key={i} onClick={() => play(i)} style={{ display:'flex', alignItems:'center', gap:10, padding:'7px 8px', borderBottom:`1px solid ${S.border}`, cursor:'pointer', background: playing===i ? '#141400' : 'transparent', borderRadius:2 }}>
          <div style={{ width:20, height:20, borderRadius:'50%', background: playing===i ? S.accent : S.border, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:9, color: playing===i ? '#080808' : S.muted }}>
            {playing===i ? '⏸' : '▶'}
          </div>
          <span style={{ fontSize:11, color: playing===i ? S.accent : S.muted, flex:1 }}>{cleanTrackName(t.name)}</span>
          {playing===i && (
            <div style={{ width:60, height:2, background:S.border, borderRadius:1, overflow:'hidden', flexShrink:0 }}>
              <div style={{ width:`${prog}%`, height:'100%', background:S.accent, transition:'width 0.1s' }} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Modal({ r, onClose, onAdd }) {
  if (!r) return null;
  const tracks = r.tracks || [];
  return (
    <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.88)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000, padding:20, backdropFilter:'blur(4px)' }}>
      <div onClick={e=>e.stopPropagation()} style={{ background:S.surf, border:`1px solid ${S.border}`, borderRadius:4, maxWidth:680, width:'100%', maxHeight:'90vh', overflow:'auto' }}>
        <div style={{ display:'flex', flexWrap:'wrap' }}>
          <div style={{ width:240, flexShrink:0, position:'relative' }}>
            <div style={{ paddingBottom:'100%', position:'relative', background:`linear-gradient(${r.g})` }}>
              {coverSrc(r.coverUrl) && <img src={coverSrc(r.coverUrl)} alt="" style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover', display:'block' }} />}
            </div>
          </div>
          <div style={{ flex:1, minWidth:220, padding:'28px 26px 24px' }}>
            <button onClick={onClose} style={{ float:'right', background:'none', border:'none', color:S.muted, cursor:'pointer', fontSize:20 }}>×</button>
            <div style={{ fontSize:9, color:S.muted, letterSpacing:2, textTransform:'uppercase', marginBottom:4 }}>{r.label} · {r.catalog}</div>
            <h2 style={{ margin:'0 0 4px', fontSize:18, fontWeight:800, color:S.text }}>{r.title}</h2>
            <div style={{ fontSize:12, color:S.muted, marginBottom:12 }}>{r.artist}</div>
            <div style={{ display:'flex', gap:6, marginBottom:14, flexWrap:'wrap' }}>
              {[r.genre,r.year].filter(Boolean).map(v=><span key={v} style={{ fontSize:9, fontWeight:700, letterSpacing:1, padding:'2px 8px', borderRadius:2, background:S.border, color:S.muted, textTransform:'uppercase' }}>{v}</span>)}
            </div>
            {r.desc && <p style={{ fontSize:11, color:S.muted, lineHeight:1.75, marginBottom:16 }}>{r.desc}</p>}
            {tracks.length > 0
              ? <TrackPlayer tracks={tracks} />
              : (r.tracks||[]).length > 0 && (
                <div style={{ marginBottom:14 }}>
                  {(r.tracks||[]).map((t,i)=>(
                    <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'5px 0', borderBottom:`1px solid ${S.border}`, fontSize:11, color:S.muted }}>
                      <span>{String.fromCharCode(65+i)}. {t.t}</span>
                      <span style={{ fontFamily:'monospace' }}>{t.d}</span>
                    </div>
                  ))}
                </div>
              )
            }
            <div style={{ marginTop:20, display:'flex', alignItems:'center', gap:14 }}>
              <span style={{ fontSize:22, fontWeight:800, color:S.accent }}>€{r.price.toFixed(2)}</span>
              <Btn ch={r.stock===0?'Out of Stock':'Add to Cart'} disabled={r.stock===0} onClick={()=>{onAdd(r);onClose();}} full />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── CART ───────────────────────────────────────────────────────
function CartDrawer({ cart, open, onClose, onRemove, onCheckout }) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const total = cart.reduce((s,i)=>s+i.price*i.qty,0);
  const count = cart.reduce((s,i)=>s+i.qty,0);
  const handleCheckout = async () => {
    setErr(''); setLoading(true);
    try { await onCheckout(); } catch(e) { setErr(e.message || 'Checkout failed.'); }
    setLoading(false);
  };
  return (
    <>
      {open&&<div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:900 }} />}
      <div style={{ position:'fixed', top:0, right:0, bottom:0, width:Math.min(340,window.innerWidth), background:S.surf, borderLeft:`1px solid ${S.border}`, zIndex:1000, transform:open?'translateX(0)':'translateX(100%)', transition:'transform 0.25s ease', display:'flex', flexDirection:'column' }}>
        <div style={{ padding:'18px 22px', borderBottom:`1px solid ${S.border}`, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <span style={{ fontWeight:800, fontSize:11, letterSpacing:2, textTransform:'uppercase' }}>Cart ({count})</span>
          <button onClick={onClose} style={{ background:'none', border:'none', color:S.muted, cursor:'pointer', fontSize:20 }}>×</button>
        </div>
        <div style={{ flex:1, overflowY:'auto', padding:'16px 22px' }}>
          {cart.length===0?<div style={{ textAlign:'center', color:S.muted, fontSize:12, marginTop:60 }}>Your cart is empty</div>:
            cart.map(item=>(
              <div key={item.id} style={{ display:'flex', gap:10, marginBottom:14, paddingBottom:14, borderBottom:`1px solid ${S.border}` }}>
                <div style={{ width:48, height:48, borderRadius:2, background:`linear-gradient(${item.g})`, backgroundImage:coverSrc(item.coverUrl)?`url(${coverSrc(item.coverUrl)})`:'none', backgroundSize:'cover', flexShrink:0 }} />
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:12, fontWeight:700, color:S.text }}>{item.title}</div>
                  <div style={{ fontSize:10, color:S.muted }}>{item.artist}</div>
                  <div style={{ fontSize:11, color:S.accent, marginTop:2 }}>€{item.price.toFixed(2)} × {item.qty}</div>
                </div>
                <button onClick={()=>onRemove(item.id)} style={{ background:'none', border:'none', color:S.muted, cursor:'pointer', fontSize:16, alignSelf:'flex-start' }}>×</button>
              </div>
            ))
          }
        </div>
        {cart.length>0&&(
          <div style={{ padding:'16px 22px', borderTop:`1px solid ${S.border}` }}>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:14 }}>
              <span style={{ fontSize:10, color:S.muted, textTransform:'uppercase', letterSpacing:1 }}>Total</span>
              <span style={{ fontSize:20, fontWeight:800, color:S.accent }}>€{total.toFixed(2)}</span>
            </div>
            {err&&<div style={{ fontSize:10, color:S.danger, marginBottom:10, lineHeight:1.5 }}>{err}</div>}
            <Btn ch={loading?'Creating Checkout…':'Checkout via Shopify'} onClick={handleCheckout} disabled={loading} full />
            <div style={{ fontSize:8, color:S.muted, textAlign:'center', marginTop:8, letterSpacing:1.5 }}>CARD · PAYPAL · CRYPTO</div>
          </div>
        )}
      </div>
    </>
  );
}

// ── FILTERS ────────────────────────────────────────────────────
function Filters({ filters, onChange, records }) {
  const labels = [...new Set(records.map(r=>r.label))].sort();
  const genres = [...new Set(records.map(r=>r.genre))].sort();
  const years  = [...new Set(records.map(r=>r.year).filter(Boolean))].sort((a,b)=>b-a);
  const pill = (key,val,label) => {
    const active = filters[key]===val;
    return <button key={String(val)} onClick={()=>onChange(key,active?null:val)} style={{ background:active?S.accent:S.border, color:active?'#080808':S.muted, border:'none', borderRadius:20, cursor:'pointer', fontSize:9, fontWeight:active?700:400, letterSpacing:1.5, padding:'6px 14px', textTransform:'uppercase', transition:'all 0.15s', whiteSpace:'nowrap', flexShrink:0 }}>{label||val}</button>;
  };
  const sel = (key, opts, placeholder) => (
    <div style={{ position:'relative', flexShrink:0 }}>
      <select value={filters[key]||''} onChange={e=>onChange(key,e.target.value||null)} style={{ appearance:'none', WebkitAppearance:'none', background:filters[key]?S.accent:S.surf, color:filters[key]?'#080808':S.muted, border:`1px solid ${filters[key]?S.accent:S.border}`, borderRadius:20, cursor:'pointer', fontSize:9, fontWeight:filters[key]?700:400, letterSpacing:1.5, padding:'6px 28px 6px 14px', textTransform:'uppercase', fontFamily:'inherit', outline:'none', minWidth:100 }}>
        <option value="">{placeholder}</option>
        {opts.map(o=><option key={o} value={o}>{o}</option>)}
      </select>
      <span style={{ position:'absolute', right:10, top:'50%', transform:'translateY(-50%)', pointerEvents:'none', fontSize:8, color:filters[key]?'#080808':S.muted }}>▼</span>
    </div>
  );
  return (
    <div style={{ marginBottom:24 }}>
      <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:10 }}>
        {sel('genre', genres, 'All Genres')}{sel('label', labels, 'All Labels')}
      </div>
      <div style={{ display:'flex', gap:6, overflowX:'auto', paddingBottom:4, scrollbarWidth:'none' }}>
        {pill('year',null,'All')}{years.map(y=>pill('year',y,y))}
      </div>
    </div>
  );
}

// ── CLAUDE API ─────────────────────────────────────────────────
function extractJSON(txt) {
  const si = txt.indexOf('[') === -1 ? txt.indexOf('{') : txt.indexOf('{') === -1 ? txt.indexOf('[') : Math.min(txt.indexOf('['), txt.indexOf('{'));
  if (si === -1) throw new Error('No JSON found');
  const open=txt[si], close=open==='['?']':'}';
  let depth=0,inStr=false,esc=false;
  for (let i=si;i<txt.length;i++) {
    const c=txt[i];
    if(esc){esc=false;continue;} if(c==='\\'&&inStr){esc=true;continue;}
    if(c==='"'){inStr=!inStr;continue;} if(inStr) continue;
    if(c===open) depth++; if(c===close){depth--;if(depth===0) return JSON.parse(txt.slice(si,i+1));}
  }
  throw new Error('Malformed JSON');
}

async function claudeJSON(sys, msg, search=false) {
  const body={model:"claude-sonnet-4-20250514",max_tokens:3000,system:sys,messages:[{role:"user",content:msg}]};
  if(search) body.tools=[{type:"web_search_20250305",name:"web_search"}];
  const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  const d=await r.json(); if(d.error) throw new Error(d.error.message);
  return extractJSON((d.content||[]).filter(b=>b.type==='text').map(b=>b.text).join(''));
}

const SCHEMA=`{"title":"","artist":"","label":"","genre":"","year":0,"price":18.99,"catalog":"","tracks":[{"t":"","d":""}],"desc":"","coverUrl":"","audioUrl":""}`;
const GLIST='Deep House, Tech House, Afro House, Chicago House, Soulful House, Acid House, Detroit House, Disco House';

// ── DESCRIPTION BUILDERS (shared by all importers) ─────────────
// Customer-first: every product gets a consistent, well-formatted, SEO-friendly
// description. Source notes (from W&S salespapers, Kudos API, DBH CSV) are
// included only when they pass quality checks. No "Pfei ff er" disasters.

function decodeHtmlEntities(s) {
  if (!s) return '';
  let out = String(s);
  // Multi-pass for double-encoding (e.g. &amp;amp; → &amp; → &)
  for (let i = 0; i < 3; i++) {
    out = out
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/&euro;/g, '€').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—')
      .replace(/&hellip;/g, '…').replace(/&rsquo;/g, "'").replace(/&lsquo;/g, "'")
      .replace(/&ldquo;/g, '"').replace(/&rdquo;/g, '"').replace(/&bdquo;/g, '„');
  }
  return out;
}

// Cleans source notes from PDFs/APIs. Fixes the obvious & safe stuff;
// leaves ambiguous cases alone (e.g. "She fi nished" vs "Pfei ff er" — they
// look identical to a regex; only a dictionary can disambiguate).
function cleanSourceNotes(text) {
  if (!text) return '';
  let s = decodeHtmlEntities(text);

  // Strip HTML tags but preserve paragraph breaks
  s = s.replace(/<\/(p|div|li|h[1-6])\s*>/gi, '\n\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');

  // Strip W&S salespaper footer leakage
  s = s.replace(/\bWord\s+and\s+Sound[\s\S]*$/i, '');
  s = s.replace(/\bwordandsound\.net[\s\S]*$/i, '');

  // Strip metadata header blocks at the start.
  // DBH descriptions begin with lines like:
  //   Artist: X
  //   Title: Y
  //   Label: Z
  //   Collective Cuts          ← continuation of multi-word label value
  //   Catalogue No: ABC123
  //   Release Date: July 2025
  //   Format: Vinyl, Digital
  // We already render all this in the lead paragraph — drop it from the prose.
  const META_FIELDS = /^(artist|title|label|catalogue?\s*no\.?|cat\.?\s*no\.?|cat|catalog|release\s*date|format|genre|style|distributor)\s*[:#]/i;
  const lines = s.split('\n');
  let firstProseIdx = 0;
  let inMetaBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) {
      // Blank line. If we were in a meta block, a blank ends it.
      if (inMetaBlock) inMetaBlock = false;
      continue;
    }
    if (META_FIELDS.test(t)) {
      inMetaBlock = true;
      continue;
    }
    // Continuation of a meta value: short line, no period, no comma-list,
    // when the previous non-blank line was part of the meta block.
    if (inMetaBlock && t.length < 60 && !/[.!?]/.test(t)) {
      continue;
    }
    // First real prose line.
    firstProseIdx = i;
    break;
  }
  if (firstProseIdx > 0) s = lines.slice(firstProseIdx).join('\n');

  // Strip embedded tracklists at the END (we render our own from the tracks array).
  // Patterns: "Track list:" / "Tracklist:" / "Tracklisting:" followed by entries.
  s = s.replace(/\n\s*track\s*list(?:ing)?\s*[:.][\s\S]*$/i, '');
  s = s.replace(/\n\s*tracklist\s*[:.][\s\S]*$/i, '');

  // Safe ligature fixes — only apply where the join is unambiguous:
  // a letter, then space, then a ligature pair, then space, then a lowercase letter.
  // This catches "Pfei ff er" → "Pfeiffer" but doesn't touch "She fi nished"
  // (which would need a dictionary to resolve correctly).
  s = s.replace(/([a-zA-Z])\s+(ff[il]?|fi|fl)\s+([a-z])/g, '$1$2$3');

  // Normalize whitespace, collapse runs of blank lines
  s = s.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();

  return s;
}

// Quality check: should we include the source notes at all?
// We measure damage in the RAW text (before cleaning), because the cleaner
// fixes some patterns and would mask the original damage level.
function notesPassQualityCheck(rawText, cleanedText) {
  if (!cleanedText || cleanedText.length < 50) return false;          // too short = noise
  // Count "obvious break" patterns in the raw text:
  //  - "<letter> fi/fl/ff <letter>"  (Pfei ff er)
  //  - "<letters>fi/fl <space><letter>"  (herfi rst, thefl ipside)
  const raw = String(rawText || '');
  const damageA = (raw.match(/[a-z]\s+(ff[il]?|fi|fl)\s+[a-z]/gi) || []).length;
  const damageB = (raw.match(/[a-z](fi|fl|ff)\s+[a-z]/gi) || []).length;
  const damage = damageA + damageB;
  const wordCount = raw.split(/\s+/).filter(Boolean).length;
  if (wordCount === 0) return false;
  // If more than 2% of words show ligature damage, the cleaning would leave
  // residual artifacts that hurt the customer experience. Better to omit.
  return (damage / wordCount) <= 0.02;
}

// Build the canonical description HTML for a product. Used by all importers
// so every product gets the same clean, SEO-friendly format.
function buildDescriptionHtml({ artist, title, label, year, tracks, sourceNotes }) {
  const parts = [];

  // Lead paragraph: facts in prose, with keywords for SEO.
  const leadBits = [];
  if (artist && title) leadBits.push(`<strong>${title}</strong> by ${artist}`);
  else if (title)      leadBits.push(`<strong>${title}</strong>`);
  if (label)           leadBits.push(`released on ${label}`);
  if (year)            leadBits.push(`(${year})`);
  if (leadBits.length) {
    parts.push(`<p>${leadBits.join(' ')}.</p>`);
  }

  // Source notes — included only if they pass quality checks
  const cleaned = cleanSourceNotes(sourceNotes);
  if (notesPassQualityCheck(sourceNotes, cleaned)) {
    const paragraphs = cleaned.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
    parts.push(...paragraphs.map(p => `<p>${p.replace(/\n/g, '<br/>')}</p>`));
  }

  // Tracklist — formatted as ordered list when we have it
  if (tracks && tracks.length) {
    const items = tracks.map(t => {
      // Track may be {name, url} (from importer ZIP) or {t, d} (legacy)
      const label = t.name || t.t || '';
      const dur   = t.d ? ` <span style="opacity:.6">(${t.d})</span>` : '';
      return `<li>${label}${dur}</li>`;
    }).join('');
    parts.push(`<p><strong>Tracklist</strong></p><ol>${items}</ol>`);
  }

  // Closing line: format + shipping. Universal across the catalogue.
  parts.push(`<p>12" vinyl. Worldwide shipping from House Only.</p>`);

  return parts.join('');
}


// ── ZIP IMPORTER ───────────────────────────────────────────────
async function loadJSZip() {
  if (window.JSZip) return window.JSZip;
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    s.onload = () => res(window.JSZip);
    s.onerror = () => rej(new Error('Failed to load JSZip'));
    document.head.appendChild(s);
  });
}

async function loadXLSX() {
  if (window.XLSX) return window.XLSX;
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => res(window.XLSX);
    s.onerror = () => rej(new Error('Failed to load XLSX'));
    document.head.appendChild(s);
  });
}

function catnoFromFilename(name) {
  const base = name.replace(/\.zip$/i, '').replace(/\s*\(\d+\)\s*$/, '').trim();
  const m = base.match(/^\d+-(.+)$/);
  return (m ? m[1] : base).toUpperCase().trim();
}

async function loadPDFJS() {
  if (window.pdfjsLib) return window.pdfjsLib;
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      res(window.pdfjsLib);
    };
    s.onerror = rej;
    document.head.appendChild(s);
  });
}

async function extractSalesPaperText(pdfBlob) {
  try {
    const pdfjsLib = await loadPDFJS();
    const arrayBuffer = await pdfBlob.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = '';
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      fullText += content.items.map(i => i.str).join(' ') + '\n';
    }
    const extract = (pattern) => {
      const m = fullText.match(pattern);
      return m ? m[1].trim().split(/\s{2,}|\n/)[0].trim() : '';
    };
    const label = extract(/Label[:\s]+([^\n\r]+)/i);
    const genreRaw = extract(/(?:Genre|Style)[:\s]+([^\n\r]+)/i);
    const GENRE_MAP = {
      'deep house': 'Deep House', 'tech house': 'Tech House',
      'afro house': 'Afro House', 'chicago house': 'Chicago House',
      'soulful house': 'Soulful House', 'acid house': 'Acid House',
      'detroit house': 'Detroit House', 'disco house': 'Disco House',
      'electronic': 'Electronic', 'house': 'Deep House',
    };
    const genreLower = genreRaw.toLowerCase();
    const genre = Object.entries(GENRE_MAP).find(([k]) => genreLower.includes(k))?.[1] || '';
    const descMatch = fullText.match(/Releasetext:\s*([\s\S]+)/i);
    let desc = '';
    if (descMatch) {
      desc = descMatch[1].trim();
      desc = desc.replace(/\bWord\s+and\s+Sound[\s\S]*/i, '').trim();
      desc = desc.replace(/\bwordandsound\.net[\s\S]*/i, '').trim();
      desc = desc.replace(/\s{3,}/g, '\n\n').trim();
    }
    return { desc, label, genre };
  } catch { return { desc: '', label: '', genre: '' }; }
}

function ZipImporter() {
  const [excelFile, setExcelFile] = useState(null);
  const [zipFiles, setZipFiles]   = useState([]);
  const [status, setStatus]       = useState('idle');
  const [progress, setProgress]   = useState({ done:0, total:0, current:'' });
  const [results, setResults]     = useState([]);
  const [skippedCount, setSkippedCount] = useState(0);
  const [error, setError]         = useState('');
  const [margin, setMargin]       = useState(60);
  const excelRef = useRef(null);
  const zipRef   = useRef(null);

  const assignFiles = (files) => {
    const xlsxFiles = files.filter(f => /\.xlsx?$/i.test(f.name));
    const zips      = files.filter(f => /\.zip$/i.test(f.name));
    if (xlsxFiles[0]) setExcelFile(xlsxFiles[0]);
    if (zips.length)  setZipFiles(prev => {
      const existing = new Set(prev.map(f => f.name));
      return [...prev, ...zips.filter(f => !existing.has(f.name))];
    });
  };

  const process = async () => {
    if (!excelFile || !zipFiles.length) return;
    setError(''); setStatus('processing'); setResults([]);
    try {
      setProgress({ done:0, total:0, current:'Loading libraries…' });
      const [JSZip, XLSX] = await Promise.all([loadJSZip(), loadXLSX()]);
      setProgress({ done:0, total:0, current:'Parsing Excel…' });
      const buf = await excelFile.arrayBuffer();
      const wb  = XLSX.read(buf);
      const ws  = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval:'' });
      const rowMap = {};
      rows.forEach(r => {
        const catno = String(r.ArtNo || '').toUpperCase().trim();
        if (catno) rowMap[catno] = r;
      });
      const matchedZips = zipFiles.filter(f => rowMap[catnoFromFilename(f.name)]);
      const total = matchedZips.length;
      const processed = [];
      for (let i = 0; i < matchedZips.length; i++) {
        const zipFile = matchedZips[i];
        const catno   = catnoFromFilename(zipFile.name);
        const row     = rowMap[catno];
        const safeKey = catno.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+/g,'-').replace(/^-|-$/g,'');
        setProgress({ done:i, total, current:`${catno} — extracting…` });
        let coverUrl='', tracks=[], desc='', pdfLabel='', pdfGenre='', itemError='';
        try {
          const zip   = await JSZip.loadAsync(zipFile);
          const files = Object.values(zip.files).filter(f => !f.dir);
          const imgFiles  = files.filter(f => /\.(jpg|jpeg|png)$/i.test(f.name));
          const coverFile = imgFiles.find(f => /front|cover|artwork/i.test(f.name.toLowerCase())) || imgFiles[0];
          const pdfFile = files.find(f => /SALESPAPER\.pdf$/i.test(f.name));
          const audioFiles = files.filter(f => /\.(mp3|wav|flac|aac|ogg)$/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
          if (coverFile) {
            setProgress({ done:i, total, current:`${catno} — uploading cover…` });
            const blob = await coverFile.async('blob');
            const ext  = coverFile.name.split('.').pop().toLowerCase();
            coverUrl = await uploadToR2(blob, `covers/${safeKey}.${ext}`, ext==='png'?'image/png':'image/jpeg');
          }
          if (pdfFile) {
            setProgress({ done:i, total, current:`${catno} — reading press text…` });
            const blob = await pdfFile.async('blob');
            const extracted = await extractSalesPaperText(blob);
            desc=extracted.desc; pdfLabel=extracted.label; pdfGenre=extracted.genre;
          }
          for (const af of audioFiles) {
            const filename = af.name.split('/').pop();
            const safeFilename = filename.replace(/[^A-Za-z0-9._-]+/g, '-');
            setProgress({ done:i, total, current:`${catno} — uploading ${filename}…` });
            const blob = await af.async('blob');
            const url  = await uploadToR2(blob, `audio/${safeKey}/${safeFilename}`, 'audio/mpeg');
            tracks.push({ name: filename.replace(/\.[^.]+$/, ''), url });
          }
        } catch (e) { itemError = e.message; }
        const title  = String(row.Title  || '');
        const artist = String(row.Artist || '');
        const ean    = row.EAN ? String(Math.round(Number(row.EAN))) : '';
        const label  = pdfLabel || String(row.Label || row.label || '');
        const genre  = pdfGenre || 'Deep House';
        const year   = row.Releasedate ? new Date(row.Releasedate).getFullYear() : '';
        const rawPrice = parseFloat(row.UnitPrice || 18.99) * (1 + margin / 100);
        const price  = String((Math.ceil(rawPrice) - 0.01).toFixed(2));
        const is2LP  = /2[\s-]?lp|double\s*lp|3[\s-]?lp/i.test(title) || /2[\s-]?lp|3[\s-]?lp/i.test(catno);
        const grams  = is2LP ? '900' : '500';
        const qty    = String(row.Qty || '1');
        const handle = catno.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
        const descHtml  = buildDescriptionHtml({ artist, title, label, year, tracks, sourceNotes: desc });
        const audioHtml = tracks.length ? `<script type="application/json" id="tracks">${JSON.stringify(tracks)}</script>` : '';
        processed.push({
          _catno: catno, _title: title, _artist: artist, _coverUrl: coverUrl, _tracks: tracks, _error: itemError,
          'Handle': handle, 'Title': title || catno, 'Body (HTML)': `${descHtml}${audioHtml}`, 'Vendor': artist,
          'Product Category': 'Media > Music & Sound Recordings > Vinyl', 'Type': '',
          'Tags': ['vinyl', label ? `label:${label}` : '', genre, String(year)].filter(Boolean).join(', '),
          'Published': 'TRUE', 'Option1 Name': 'Title', 'Option1 Value': 'Default Title', 'Option1 Linked To': '',
          'Option2 Name': '', 'Option2 Value': '', 'Option2 Linked To': '',
          'Option3 Name': '', 'Option3 Value': '', 'Option3 Linked To': '',
          'Variant SKU': catno, 'Variant Grams': grams, 'Variant Inventory Tracker': '',
          'Variant Inventory Qty': qty, 'Variant Inventory Policy': 'deny',
          'Variant Fulfillment Service': 'manual', 'Variant Price': price,
          'Variant Compare At Price': '', 'Variant Requires Shipping': 'TRUE', 'Variant Taxable': 'FALSE',
          'Unit Price Total Measure': '', 'Unit Price Total Measure Unit': '',
          'Unit Price Base Measure': '', 'Unit Price Base Measure Unit': '',
          'Variant Barcode': ean, 'Image Src': coverUrl, 'Image Position': coverUrl ? '1' : '',
          'Image Alt Text': coverUrl ? `${title} - ${artist}` : '',
          'Gift Card': 'FALSE', 'SEO Title': '', 'SEO Description': '',
          'Variant Image': '', 'Variant Weight Unit': 'kg', 'Variant Tax Code': '', 'Cost per item': '', 'Status': 'active',
        });
        setProgress({ done:i+1, total, current:'' });
      }
      setResults(processed);
      setSkippedCount(zipFiles.length - matchedZips.length);
      setStatus('review');
    } catch (e) { setError(e.message); setStatus('idle'); }
  };

  const downloadCSV = () => {
    const CSV_KEYS = results.length ? Object.keys(results[0]).filter(k => !k.startsWith('_')) : [];
    const lines = [CSV_KEYS.join(','), ...results.map(row => CSV_KEYS.map(h => `"${String(row[h]||'').replace(/"/g,'""')}"`).join(','))];
    const blob = new Blob([lines.join('\n')], { type:'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'shopify_import_ws.csv'; a.click();
  };

  const pct=progress.total?Math.round((progress.done/progress.total)*100):0;
  const covered=results.filter(r=>r._coverUrl).length;
  const withAudio=results.filter(r=>r._tracks?.length>0).length;
  const errors=results.filter(r=>r._error).length;

  return (
    <div>
      <p style={{ fontSize:10, color:S.muted, margin:'0 0 14px', lineHeight:1.6 }}>Upload your Word & Sound Excel + all ZIP files together. Covers and audio are uploaded to R2 automatically, then download the Shopify CSV.</p>
      <div onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();assignFiles([...e.dataTransfer.files]);}} style={{ border:`2px dashed ${(excelFile||zipFiles.length)?S.accent:S.border}`, borderRadius:3, padding:'20px', textAlign:'center', marginBottom:14, transition:'border 0.15s' }}>
        <div style={{ fontSize:28, marginBottom:6 }}>📦</div>
        <div style={{ fontSize:11, color:(excelFile||zipFiles.length)?S.accent:S.muted, fontWeight:700, letterSpacing:1, textTransform:'uppercase', marginBottom:10 }}>Drag Excel + ZIPs here, or use buttons below</div>
        <div style={{ display:'flex', gap:8, justifyContent:'center' }}>
          <input ref={excelRef} type="file" accept=".xlsx,.xls" style={{ display:'none' }} onChange={e=>e.target.files[0]&&assignFiles([...e.target.files])} />
          <input ref={zipRef}   type="file" accept=".zip" multiple style={{ display:'none' }} onChange={e=>assignFiles([...e.target.files])} />
          <button onClick={()=>excelRef.current.click()} style={{ background:excelFile?S.accent:S.border, border:'none', color:excelFile?'#080808':S.muted, cursor:'pointer', fontSize:9, padding:'6px 14px', borderRadius:2, letterSpacing:1, textTransform:'uppercase', fontFamily:'inherit', fontWeight:700 }}>{excelFile?`✓ ${excelFile.name}`:'+ Excel'}</button>
          <button onClick={()=>zipRef.current.click()} style={{ background:zipFiles.length?S.accent:S.border, border:'none', color:zipFiles.length?'#080808':S.muted, cursor:'pointer', fontSize:9, padding:'6px 14px', borderRadius:2, letterSpacing:1, textTransform:'uppercase', fontFamily:'inherit', fontWeight:700 }}>{zipFiles.length?`✓ ${zipFiles.length} ZIPs`:'+ ZIPs'}</button>
          {zipFiles.length>0&&<button onClick={()=>setZipFiles([])} style={{ background:'none', border:`1px solid ${S.border}`, color:S.muted, cursor:'pointer', fontSize:9, padding:'6px 10px', borderRadius:2, fontFamily:'inherit' }}>Clear</button>}
        </div>
      </div>
      {zipFiles.length>0&&<div style={{ maxHeight:100, overflowY:'auto', marginBottom:12, fontSize:9, color:S.muted, fontFamily:'monospace', display:'flex', flexWrap:'wrap', gap:4 }}>{zipFiles.map((f,i)=><span key={i} style={{ background:S.border, padding:'2px 8px', borderRadius:10, color:S.text }}>{catnoFromFilename(f.name)}</span>)}</div>}
      {status==='idle'&&excelFile&&zipFiles.length>0&&(
        <div style={{marginBottom:10}}>
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10}}>
            <span style={{fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase',whiteSpace:'nowrap'}}>Margin %</span>
            <input type="number" value={margin} onChange={e=>setMargin(Math.max(0,parseFloat(e.target.value)||0))} min="0" max="500" style={{width:70,background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'5px 10px',fontSize:12,fontFamily:'inherit',outline:'none',textAlign:'center'}} />
            <span style={{fontSize:9,color:S.muted}}>→ e.g. €11 × {(1+margin/100).toFixed(2)} = €{(11*(1+margin/100)).toFixed(2)}</span>
          </div>
          <Btn ch={`🚀 Process ${zipFiles.length} Releases → Upload to R2`} onClick={process} full />
        </div>
      )}
      {status==='processing'&&(
        <div style={{ padding:14, background:S.bg, borderRadius:2, border:`1px solid ${S.border}` }}>
          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6 }}><span style={{ fontSize:10, color:S.accent, fontWeight:700, letterSpacing:1 }}>PROCESSING…</span><span style={{ fontSize:10, color:S.muted }}>{progress.done} / {progress.total} · {pct}%</span></div>
          <div style={{ height:3, background:S.border, borderRadius:2, overflow:'hidden', marginBottom:8 }}><div style={{ height:'100%', background:S.accent, width:`${pct}%`, transition:'width 0.3s' }} /></div>
          {progress.current&&<div style={{ fontSize:9, color:S.muted, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>→ {progress.current}</div>}
        </div>
      )}
      {error&&<div style={{ marginTop:8, padding:10, background:'#1a0000', border:`1px solid ${S.danger}44`, borderRadius:2, fontSize:10, color:S.danger }}>{error}</div>}
      {status==='review'&&results.length>0&&(
        <div>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12, flexWrap:'wrap', gap:8 }}>
            <div><span style={{ fontSize:11, color:S.accent, fontWeight:700 }}>✓ {results.length} releases processed</span><span style={{ fontSize:9, color:S.muted, marginLeft:10 }}>{covered} covers · {withAudio} with audio{errors>0?` · ${errors} errors`:''}{ skippedCount>0?` · ${skippedCount} skipped (no Excel match)`:''}</span></div>
            <Btn ch="⬇ Download Shopify CSV" onClick={downloadCSV} />
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))', gap:8, maxHeight:500, overflowY:'auto', padding:4 }}>
            {results.map((r,i)=>(
              <div key={i} style={{ background:S.surf, border:`1px solid ${r._error?S.danger:r._coverUrl?S.border:'#ff8800'}`, borderRadius:3, overflow:'hidden' }}>
                <div style={{ position:'relative', paddingBottom:'100%', background:'#1a1a2e' }}>
                  {r._coverUrl?<img src={r._coverUrl} alt="" style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover' }} onError={e=>e.target.style.display='none'} />:<div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', fontSize:24 }}>🎵</div>}
                  {r._error&&<div style={{ position:'absolute', top:4, right:4, background:S.danger, borderRadius:2, fontSize:7, color:'#fff', padding:'2px 5px', fontWeight:700 }}>ERR</div>}
                  {r._tracks?.length>0&&<div style={{ position:'absolute', bottom:4, left:4, background:'rgba(0,0,0,0.75)', borderRadius:2, fontSize:8, color:S.accent, padding:'2px 6px' }}>▶ {r._tracks.length} tracks</div>}
                  {!r._coverUrl&&!r._error&&<div style={{ position:'absolute', top:4, right:4, background:'#ff8800', borderRadius:2, fontSize:7, color:'#080808', padding:'2px 5px', fontWeight:700 }}>NO IMG</div>}
                </div>
                <div style={{ padding:'8px 8px 6px' }}>
                  <div style={{ fontSize:9, color:S.muted, fontFamily:'monospace', marginBottom:2 }}>{r._catno}</div>
                  <div style={{ fontSize:10, fontWeight:700, color:S.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r._title||r._catno}</div>
                  <div style={{ fontSize:9, color:S.muted, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r._artist}</div>
                  {r._error&&<div style={{ fontSize:8, color:S.danger, marginTop:4, lineHeight:1.4 }}>{r._error}</div>}
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop:14, display:'flex', justifyContent:'flex-end' }}><Btn ch="⬇ Download Shopify CSV" onClick={downloadCSV} /></div>
        </div>
      )}
    </div>
  );
}

// ── EDIT MODAL ─────────────────────────────────────────────────
const GENRE_OPTS=['Deep House','Tech House','Afro House','Chicago House','Soulful House','Acid House','Detroit House','Disco House'];
function EditModal({ record, onSave, onClose }) {
  const [f,setF]=useState({...record});
  const set=(k,v)=>setF(p=>({...p,[k]:v}));
  const inp=(label,key,type='text',opts=null)=>(
    <div style={{marginBottom:14}}>
      <div style={{fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase',marginBottom:5}}>{label}</div>
      {opts?<select value={f[key]||''} onChange={e=>set(key,e.target.value)} style={{width:'100%',background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'8px 10px',fontSize:12,fontFamily:'inherit',outline:'none'}}>{opts.map(o=><option key={o} value={o}>{o}</option>)}</select>
      :type==='textarea'?<textarea value={f[key]||''} onChange={e=>set(key,e.target.value)} rows={3} style={{width:'100%',background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'8px 10px',fontSize:12,fontFamily:'inherit',outline:'none',resize:'vertical',boxSizing:'border-box'}} />
      :<input type={type} value={f[key]||''} onChange={e=>set(key,type==='number'?parseFloat(e.target.value)||0:e.target.value)} style={{width:'100%',background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'8px 10px',fontSize:12,fontFamily:'inherit',outline:'none',boxSizing:'border-box'}} />}
    </div>
  );
  return (
    <div onClick={onClose} style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.88)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:2000,padding:20,backdropFilter:'blur(4px)'}}>
      <div onClick={e=>e.stopPropagation()} style={{background:S.surf,border:`1px solid ${S.border}`,borderRadius:4,width:'100%',maxWidth:580,maxHeight:'90vh',overflow:'auto'}}>
        <div style={{padding:'20px 24px 0',display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
          <div style={{fontSize:11,fontWeight:800,letterSpacing:2,textTransform:'uppercase'}}>Edit Release</div>
          <button onClick={onClose} style={{background:'none',border:'none',color:S.muted,cursor:'pointer',fontSize:20}}>×</button>
        </div>
        <div style={{padding:'0 24px 24px'}}>
          <div style={{display:'flex',gap:14,marginBottom:20,alignItems:'flex-start'}}>
            <div style={{width:80,height:80,borderRadius:2,flexShrink:0,background:`linear-gradient(${f.g})`,backgroundImage:coverSrc(f.coverUrl)?`url(${coverSrc(f.coverUrl)})`:'none',backgroundSize:'cover',backgroundPosition:'center'}} />
            <div style={{flex:1}}><div style={{fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase',marginBottom:5}}>Cover Image URL</div><input value={f.coverUrl||''} onChange={e=>set('coverUrl',e.target.value)} placeholder="https://…" style={{width:'100%',background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'8px 10px',fontSize:11,fontFamily:'inherit',outline:'none',boxSizing:'border-box'}} /></div>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 16px'}}>
            <div>{inp('Title','title')}</div><div>{inp('Artist','artist')}</div>
            <div>{inp('Label','label')}</div><div>{inp('Catalog #','catalog')}</div>
            <div>{inp('Genre','genre','text',GENRE_OPTS)}</div><div>{inp('Year','year','number')}</div>
            <div>{inp('Price (€)','price','number')}</div><div>{inp('Stock','stock','number')}</div>
          </div>
          {inp('Description','desc','textarea')}
          <div style={{marginBottom:20}}><div style={{fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase',marginBottom:5}}>Audio Snippet URL</div><input value={f.audio||''} onChange={e=>set('audio',e.target.value)} placeholder="https://… .mp3 or .ogg" style={{width:'100%',background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'8px 10px',fontSize:11,fontFamily:'inherit',outline:'none',boxSizing:'border-box'}} />{f.audio&&<AudioPlayer src={f.audio} />}</div>
          <div style={{marginBottom:20}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}><div style={{fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase'}}>Tracklist</div><button onClick={()=>set('tracks',[...(f.tracks||[]),{t:'',d:''}])} style={{background:S.border,border:'none',color:S.muted,cursor:'pointer',fontSize:9,letterSpacing:1,textTransform:'uppercase',padding:'3px 10px',borderRadius:2}}>+ Track</button></div>
            {(f.tracks||[]).map((t,i)=>(
              <div key={i} style={{display:'flex',gap:8,marginBottom:6}}>
                <input value={t.t} onChange={e=>set('tracks',f.tracks.map((x,j)=>j===i?{...x,t:e.target.value}:x))} placeholder="Track title" style={{flex:1,background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'6px 10px',fontSize:11,fontFamily:'inherit',outline:'none'}} />
                <input value={t.d} onChange={e=>set('tracks',f.tracks.map((x,j)=>j===i?{...x,d:e.target.value}:x))} placeholder="0:00" style={{width:60,background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'6px 8px',fontSize:11,fontFamily:'inherit',outline:'none',textAlign:'center'}} />
                <button onClick={()=>set('tracks',f.tracks.filter((_,j)=>j!==i))} style={{background:'none',border:'none',color:S.muted,cursor:'pointer',fontSize:14,padding:'0 4px'}}>×</button>
              </div>
            ))}
          </div>
          <div style={{display:'flex',gap:10,justifyContent:'flex-end'}}><Btn ch="Cancel" variant="ghost" onClick={onClose} /><Btn ch="Save Changes" onClick={()=>{onSave(f);onClose();}} /></div>
        </div>
      </div>
    </div>
  );
}

// ── KUDOS IMPORTER ─────────────────────────────────────────────
function KudosImporter() {
  const [pickingRows, setPickingRows] = useState([]);
  const [enrichment, setEnrichment]   = useState({});
  const [pickFile, setPickFile]       = useState(null);
  const [jsonFile, setJsonFile]       = useState(null);
  const [step2Ready, setStep2Ready]   = useState(false);
  const [scriptCopied, setScriptCopied] = useState(false);
  const [fx, setFx]         = useState(1.15);
  const [margin, setMargin] = useState(60);
  const [stdW, setStdW]     = useState(500);
  const [dblW, setDblW]     = useState(900);
  const pickRef = useRef(null);
  const jsonRef = useRef(null);

  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows=[]; let cur=[],field='',inQ=false,i=0; const len=text.length;
    while(i<len){const ch=text[i];if(inQ){if(ch==='"'){if(text[i+1]==='"'){field+='"';i+=2;continue;}inQ=false;i++;continue;}field+=ch;i++;continue;}if(ch==='"'){inQ=true;i++;continue;}if(ch===','){cur.push(field);field='';i++;continue;}if(ch==='\r'){i++;continue;}if(ch==='\n'){cur.push(field);rows.push(cur);cur=[];field='';i++;continue;}field+=ch;i++;}
    if(field.length>0||cur.length>0){cur.push(field);rows.push(cur);}
    return rows;
  }

  function decodeHtml(s){if(!s)return'';const t=document.createElement('textarea');t.innerHTML=s;return t.value;}

  function loadPicking(text, filename) {
    const rows = parseCSV(text);
    if (rows.length < 2) return;
    const h = rows[0].map(c=>c.trim().toUpperCase());
    const g = (names) => { for(const n of names){const i=h.indexOf(n);if(i>=0)return i;} return -1; };
    const ci = { sku:g(['SKU']), upc:g(['UPC']), format:g(['FORMAT']), title:g(['DESCRIPTION/TITLE','TITLE']), artist:g(['DESCRIPTION/ARTIST','ARTIST']), requested:g(['REQUESTED']), fulfilled:g(['FULFILLED']) };
    if (ci.sku < 0 || ci.upc < 0) { alert('Missing SKU/UPC columns'); return; }
    const parsed = [];
    for (let r=1;r<rows.length;r++) {
      const row=rows[r]; const sku=(row[ci.sku]||'').trim(); if(!sku) continue;
      parsed.push({ sku, upc:(row[ci.upc]||'').trim(), format:ci.format>=0?(row[ci.format]||'').trim():'', title:ci.title>=0?(row[ci.title]||'').trim():'', artist:ci.artist>=0?(row[ci.artist]||'').trim():'', requested:ci.requested>=0?parseInt(row[ci.requested])||0:1, fulfilled:ci.fulfilled>=0?parseInt(row[ci.fulfilled])||0:1, isBlack:/BLACK/i.test(row[ci.sku]||'') });
    }
    setPickingRows(parsed); setPickFile(filename); setStep2Ready(true);
  }

  function loadEnrichment(text, filename) {
    try { setEnrichment(JSON.parse(text)); setJsonFile(filename); }
    catch(e) { alert('Invalid JSON: '+e.message); }
  }

  function generateScript() {
    const upcs = pickingRows.filter(r=>!r.isBlack&&r.fulfilled>0).map(r=>r.upc).filter(Boolean);
    return `(async()=>{const upcs=${JSON.stringify(upcs)};const results={};let done=0;for(const upc of upcs){done++;console.log(\`[\${done}/\${upcs.length}] \${upc}\`);try{const r=await fetch('/api/kudos_lookup.json?upc='+upc);const d=await r.json();if(d.results&&d.results[0])results[upc]=d.results[0];else console.warn('No result '+upc);}catch(e){console.error(e)}if(done<upcs.length)await new Promise(r=>setTimeout(r,300));}const blob=new Blob([JSON.stringify(results,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='kudos-enrichment.json';document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(url);console.log('Done! '+Object.keys(results).length+'/'+upcs.length);})();`;
  }

  function copyScript() {
    const script = generateScript();
    navigator.clipboard.writeText(script).then(()=>setScriptCopied(true)).catch(()=>{
      const ta=document.createElement('textarea');ta.value=script;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);setScriptCopied(true);
    });
  }

  function getEnriched(r) {
    const e=enrichment[r.upc]; if(!e) return null;
    const fmt=e.formats?(e.formats[r.sku]||Object.values(e.formats)[0]):null;
    return {api:e,fmt};
  }

  function exportShopify() {
    const m=margin/100;
    const cols=['Handle','Title','Body (HTML)','Vendor','Product Category','Type','Tags','Published','Option1 Name','Option1 Value','Option1 Linked To','Option2 Name','Option2 Value','Option2 Linked To','Option3 Name','Option3 Value','Option3 Linked To','Variant SKU','Variant Grams','Variant Inventory Tracker','Variant Inventory Qty','Variant Inventory Policy','Variant Fulfillment Service','Variant Price','Variant Compare At Price','Variant Requires Shipping','Variant Taxable','Variant Barcode','Image Src','Image Position','Image Alt Text','Gift Card','SEO Title','SEO Description','Variant Image','Variant Weight Unit','Variant Tax Code','Cost per item','Status'];
    const csvRows=[cols];
    pickingRows.filter(r=>!r.isBlack&&r.fulfilled>0).forEach(r=>{
      const en=getEnriched(r); const api=en?en.api:null; const fmt=en?en.fmt:null;
      const artist=api?decodeHtml(api.main_artist):r.artist; const title=api?decodeHtml(api.title):r.title;
      const label=api?decodeHtml(api.label):''; const genre=api?api.genre:''; const subgenre=api?api.subgenre:'';
      const handle=r.sku.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-+$/,'');
      const dealerGBP=fmt?parseFloat(fmt.dealer)||0:0; const dealerEUR=dealerGBP>0?dealerGBP*fx:0;
      const rawRetail=dealerEUR>0?dealerEUR*(1+m):0; const retailP=rawRetail>0?(Math.ceil(rawRetail)-0.01).toFixed(2):'';
      const costEUR=dealerEUR>0?dealerEUR.toFixed(2):'';
      const formatDisplay=fmt?fmt.display:r.format;
      const is2LP=/2[\s-]?(?:x\s*)?lp|double\s*lp|3[\s-]?lp|2xlp/i.test(title)||/2[\s-]?(?:x\s*)?lp|2xlp/i.test(formatDisplay);
      const grams=is2LP?String(dblW):String(stdW);
      let bodyHtml='';
      let audioTracksJson = '';
      if(api){
        // Build tracklist for the helper: include duration in `d` field
        const tracksForHelper = api.tracks
          ? Object.values(api.tracks).sort((a,b)=>a.sequence-b.sequence).map(t=>({
              name: decodeHtml(t.title),
              d: t.duration || ''
            }))
          : [];
        // Build inline audio tracks JSON (separate from description, for the modal player)
        if(api.tracks){
          const audioArr = Object.values(api.tracks)
            .sort((a,b)=>a.sequence-b.sequence)
            .filter(t=>t.audio_clip)
            .map(t=>({ name: decodeHtml(t.title), url: t.audio_clip.replace(/\.ka$/,'.mp3') }));
          if(audioArr.length){
            audioTracksJson = '<script type="application/json" id="tracks">'+JSON.stringify(audioArr)+'<\/script>';
          }
        }
        // Year — try common API fields
        const releaseYear = api.release_date ? new Date(api.release_date).getFullYear()
                          : api.year ? parseInt(api.year)
                          : undefined;
        bodyHtml = buildDescriptionHtml({
          artist, title, label,
          year: releaseYear,
          tracks: tracksForHelper,
          sourceNotes: api.b2c_notes || api.b2b_notes || '',
        }) + audioTracksJson;
      } else {
        bodyHtml = buildDescriptionHtml({ artist, title, label });
      }
      const tags=['vinyl','kudos'];if(label)tags.push('label:'+label);if(subgenre)tags.push(subgenre);if(genre)tags.push(genre);
      const imgUrl=api?(api.img_url||'').replace(/\.ki$/,'.jpg'):'';
      csvRows.push([handle,title+' - '+artist,bodyHtml||'<p></p>',artist,'Media > Music & Sound Recordings > Vinyl','',tags.join(', '),'TRUE','Title','Default Title','','','','','','','',r.sku,grams,'',String(r.fulfilled),'deny','manual',retailP,'','TRUE','FALSE',r.upc,imgUrl,imgUrl?'1':'',imgUrl?title+' - '+artist:'','FALSE','','','','g','',costEUR,'active']);
    });
    const csv=csvRows.map(row=>row.map(cell=>{const s=String(cell==null?'':cell);return s.includes(',')||s.includes('"')||s.includes('\n')?'"'+s.replace(/"/g,'""')+'"':s;}).join(',')).join('\n');
    const blob=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download='shopify-kudos-'+new Date().toISOString().slice(0,10)+'.csv';
    document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(url);
  }

  const importable  = pickingRows.filter(r=>!r.isBlack&&r.fulfilled>0);
  const excluded    = pickingRows.filter(r=>r.isBlack).length;
  const unfulfilled = pickingRows.filter(r=>!r.isBlack&&r.fulfilled<=0).length;
  const enrichedCount = importable.filter(r=>getEnriched(r)).length;

  const baseStep = { borderRadius:6, padding:'18px 14px', textAlign:'center', transition:'all 0.2s', flex:1, minWidth:160 };
  const stepDone = { ...baseStep, border:`2px solid ${S.accent}`, background:'rgba(200,255,0,0.03)', cursor:'pointer' };
  const stepIdle = { ...baseStep, border:`2px dashed ${S.border}`, background:S.bg, cursor:'pointer' };
  const stepOff  = { ...baseStep, border:`2px dashed ${S.border}`, background:S.bg, cursor:'not-allowed', opacity:0.4 };

  return (
    <div>
      <p style={{fontSize:10,color:S.muted,margin:'0 0 16px',lineHeight:1.6}}>
        3-step: upload Kudos picking CSV → run enrichment script on b2b.kudosdistribution.co.uk → upload JSON → export Shopify CSV.
      </p>

      <div style={{display:'flex',gap:10,marginBottom:16,flexWrap:'wrap'}}>
        {/* Step 1 */}
        <div style={pickFile?stepDone:stepIdle} onClick={()=>pickRef.current.click()}>
          <div style={{fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase',marginBottom:6}}>Step 1</div>
          <div style={{fontSize:22,marginBottom:6}}>📋</div>
          <div style={{fontSize:11,fontWeight:700,color:pickFile?S.accent:S.text,marginBottom:4}}>Picking Summary CSV</div>
          <div style={{fontSize:9,color:S.muted}}>{pickFile||'K######_Picking_Summary.csv'}</div>
          <input ref={pickRef} type="file" accept=".csv" style={{display:'none'}} onChange={e=>{const f=e.target.files[0];if(!f)return;const rd=new FileReader();rd.onload=()=>loadPicking(rd.result,f.name);rd.readAsText(f,'UTF-8');e.target.value='';}} />
        </div>

        {/* Step 2 */}
        <div style={scriptCopied?stepDone:(step2Ready?stepIdle:stepOff)}>
          <div style={{fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase',marginBottom:6}}>Step 2</div>
          <div style={{fontSize:22,marginBottom:6}}>💻</div>
          <div style={{fontSize:11,fontWeight:700,color:S.text,marginBottom:4}}>Run Enrichment Script</div>
          <div style={{fontSize:9,color:S.muted,marginBottom:10}}>Paste in Kudos B2B console</div>
          <button disabled={!step2Ready} onClick={e=>{e.stopPropagation();copyScript();}} style={{background:scriptCopied?S.accent:S.border,border:'none',color:scriptCopied?'#080808':S.muted,cursor:step2Ready?'pointer':'not-allowed',fontSize:9,padding:'6px 14px',borderRadius:2,letterSpacing:1,textTransform:'uppercase',fontFamily:'inherit',fontWeight:700}}>
            {scriptCopied?'✓ Copied!':'Copy Script'}
          </button>
        </div>

        {/* Step 3 */}
        <div style={jsonFile?stepDone:(step2Ready?stepIdle:stepOff)} onClick={()=>step2Ready&&jsonRef.current.click()}>
          <div style={{fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase',marginBottom:6}}>Step 3</div>
          <div style={{fontSize:22,marginBottom:6}}>📤</div>
          <div style={{fontSize:11,fontWeight:700,color:jsonFile?S.accent:S.text,marginBottom:4}}>Upload Enrichment JSON</div>
          <div style={{fontSize:9,color:S.muted}}>{jsonFile||'kudos-enrichment.json'}</div>
          <input ref={jsonRef} type="file" accept=".json" style={{display:'none'}} onChange={e=>{const f=e.target.files[0];if(!f)return;const rd=new FileReader();rd.onload=()=>loadEnrichment(rd.result,f.name);rd.readAsText(f,'UTF-8');e.target.value='';}} />
        </div>
      </div>

      {/* Controls */}
      {pickFile && (
        <div style={{display:'flex',gap:14,alignItems:'center',flexWrap:'wrap',padding:'12px 16px',background:S.bg,border:`1px solid ${S.border}`,borderRadius:4,marginBottom:10}}>
          {[['GBP→EUR',fx,setFx,0.01],['Margin %',margin,setMargin,1],['Weight g',stdW,setStdW,100],['2LP g',dblW,setDblW,100]].map(([label,val,setter,step])=>(
            <div key={label} style={{display:'flex',alignItems:'center',gap:6}}>
              <span style={{fontSize:10,color:S.muted,whiteSpace:'nowrap'}}>{label}</span>
              <input type="number" value={val} step={step} onChange={e=>setter(parseFloat(e.target.value)||val)} style={{width:72,padding:'5px 8px',background:S.surf,border:`1px solid ${S.border}`,borderRadius:2,color:S.text,fontFamily:'monospace',fontSize:12,textAlign:'center',outline:'none'}} />
            </div>
          ))}
          <div style={{flex:1}} />
          <Btn ch="⬇ Export Shopify CSV" onClick={exportShopify} disabled={importable.length===0} />
        </div>
      )}

      {/* Stats */}
      {pickFile && (
        <div style={{display:'flex',gap:16,flexWrap:'wrap',padding:'8px 14px',background:S.bg,border:`1px solid ${S.border}`,borderRadius:4,marginBottom:12,fontSize:10,fontFamily:'monospace'}}>
          <span>Total: <b style={{color:S.text}}>{pickingRows.length}</b></span>
          <span>Import: <b style={{color:S.accent}}>{importable.length}</b></span>
          <span>2000Black: <b style={{color:S.danger}}>{excluded}</b></span>
          <span>Unfulfilled: <b style={{color:'#ff8800'}}>{unfulfilled}</b></span>
          <span>Enriched: <b style={{color:S.accent}}>{enrichedCount}/{importable.length}</b></span>
        </div>
      )}

      {/* Table */}
      {pickingRows.length > 0 && (
        <div style={{overflowX:'auto',border:`1px solid ${S.border}`,borderRadius:4}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
            <thead>
              <tr>{['','SKU','Artist','Title','Label','Fmt','Qty','Dealer €','Retail €','Tracks','Status'].map(h=>(
                <th key={h} style={{textAlign:'left',padding:'8px 10px',fontSize:9,textTransform:'uppercase',letterSpacing:0.5,color:S.muted,borderBottom:`1px solid ${S.border}`,whiteSpace:'nowrap',background:S.surf}}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {pickingRows.map((r,i)=>{
                const en=getEnriched(r); const api=en?en.api:null; const fmt=en?en.fmt:null;
                const artist=api?(api.main_artist||r.artist):r.artist;
                const title=api?(api.title||r.title):r.title;
                const label=api?api.label:'';
                const dealerGBP=fmt?parseFloat(fmt.dealer)||0:0;
                const dealerEUR=dealerGBP>0?(dealerGBP*fx).toFixed(2):'—';
                const rawR=dealerGBP>0?dealerGBP*fx*(1+margin/100):0;
                const retail=rawR>0?'€'+(Math.ceil(rawR)-0.01).toFixed(2):'—';
                const trackCount=api&&api.tracks?Object.keys(api.tracks).length:0;
                const imgUrl=api?(api.img_url||'').replace(/\.ki$/,'.jpg'):'';
                const opacity=r.isBlack||r.fulfilled<=0?0.35:1;
                let statusEl;
                if(r.isBlack) statusEl=<span style={{fontSize:9,padding:'2px 6px',borderRadius:2,background:'#2a1a1a',color:S.danger}}>2000Black</span>;
                else if(r.fulfilled<=0) statusEl=<span style={{fontSize:9,padding:'2px 6px',borderRadius:2,background:'#2a2218',color:'#e8c840'}}>Unfulfilled</span>;
                else if(api) statusEl=<span style={{fontSize:9,padding:'2px 6px',borderRadius:2,background:'#1a2a1e',color:'#3ecf7a'}}>Enriched</span>;
                else statusEl=<span style={{fontSize:9,padding:'2px 6px',borderRadius:2,background:S.border,color:S.muted}}>Pending</span>;
                return (
                  <tr key={i} style={{opacity,borderBottom:`1px solid ${S.border}`}}>
                    <td style={{padding:'4px 8px',width:44}}>
                      {imgUrl?<img src={imgUrl} alt="" style={{width:36,height:36,objectFit:'cover',borderRadius:3,display:'block'}} onError={e=>e.target.style.display='none'} />:<div style={{width:36,height:36,borderRadius:3,background:S.border,display:'flex',alignItems:'center',justifyContent:'center',fontSize:14}}>🎵</div>}
                    </td>
                    <td style={{padding:'4px 10px',fontFamily:'monospace',fontSize:10,color:S.muted}}>{r.sku}</td>
                    <td style={{padding:'4px 10px',maxWidth:160,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',fontWeight:600,color:S.text}}>{artist}</td>
                    <td style={{padding:'4px 10px',maxWidth:180,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',color:S.muted}}>{title}</td>
                    <td style={{padding:'4px 10px',fontSize:10,color:'#e8c840',maxWidth:100,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{label}</td>
                    <td style={{padding:'4px 10px',fontSize:10,color:S.muted}}>{fmt?fmt.display:r.format}</td>
                    <td style={{padding:'4px 10px',fontFamily:'monospace',fontSize:11,color:r.fulfilled>0?'#3ecf7a':S.danger}}>{r.fulfilled}/{r.requested}</td>
                    <td style={{padding:'4px 10px',fontFamily:'monospace',fontSize:11,color:S.muted}}>{dealerEUR!=='—'?'€'+dealerEUR:dealerEUR}</td>
                    <td style={{padding:'4px 10px',fontFamily:'monospace',fontSize:11,color:S.accent}}>{retail}</td>
                    <td style={{padding:'4px 10px',fontSize:10,color:S.muted}}>{trackCount>0?trackCount+' tracks':''}</td>
                    <td style={{padding:'4px 10px'}}>{statusEl}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── DBH IMPORTER ───────────────────────────────────────────────
function DBHImporter() {
  const [csvFile, setCsvFile]   = useState(null);
  const [zipFiles, setZipFiles] = useState([]);
  const [csvRows, setCsvRows]   = useState([]);
  const [status, setStatus]     = useState('idle');
  const [progress, setProgress] = useState({ done:0, total:0, current:'' });
  const [results, setResults]   = useState([]);
  const [error, setError]       = useState('');
  const [margin, setMargin]     = useState(60);
  const csvRef = useRef(null);
  const zipRef = useRef(null);

  function parseDBHCsv(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    // Parse CSV with semicolon delimiter, handling quoted multiline fields
    const rows = []; let cur = [], field = '', inQ = false, i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"' && text[i+1] === '"') { field += '"'; i += 2; continue; }
        if (ch === '"') { inQ = false; i++; continue; }
        field += ch; i++; continue;
      }
      if (ch === '"') { inQ = true; i++; continue; }
      if (ch === ';') { cur.push(field); field = ''; i++; continue; }
      if (ch === '\r') { i++; continue; }
      if (ch === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; i++; continue; }
      field += ch; i++;
    }
    if (field || cur.length) { cur.push(field); rows.push(cur); }
    if (rows.length < 2) return [];
    const headers = rows[0].map(h => h.trim());
    return rows.slice(1).map(vals => {
      const obj = {};
      headers.forEach((h, i) => obj[h] = (vals[i] || '').trim());
      return obj;
    }).filter(r => r['Catalog']);
  }

  function decodeHtml(s) {
    if (!s) return '';
    return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&rsquo;/g,"'").replace(/&lsquo;/g,"'").replace(/&ndash;/g,'–').replace(/&mdash;/g,'—').replace(/&hellip;/g,'…').replace(/&nbsp;/g,' ').replace(/&ldquo;/g,'"').replace(/&rdquo;/g,'"').replace(/&bdquo;/g,'„').replace(/&euro;/g,'€');
  }

  function mapGenre(genreStr) {
    const g = genreStr.toLowerCase();
    if (g.includes('deep house') || g.includes('deep')) return 'Deep House';
    if (g.includes('tech house')) return 'Tech House';
    if (g.includes('afro')) return 'Afro House';
    if (g.includes('chicago')) return 'Chicago House';
    if (g.includes('soulful')) return 'Soulful House';
    if (g.includes('acid')) return 'Acid House';
    if (g.includes('detroit')) return 'Detroit House';
    if (g.includes('disco')) return 'Disco House';
    if (g.includes('house')) return 'Deep House';
    return genreStr || 'Deep House';
  }

  function catnoFromZip(name) {
    return name.replace(/\.zip$/i,'').replace(/\s*\(\d+\)\s*$/,'').trim().toUpperCase();
  }

  const loadCsv = (file) => {
    const rd = new FileReader();
    rd.onload = () => {
      const rows = parseDBHCsv(rd.result);
      setCsvRows(rows);
      setCsvFile(file.name);
    };
    rd.readAsText(file, 'UTF-8');
  };

  const assignZips = (files) => {
    const zips = [...files].filter(f => /\.zip$/i.test(f.name));
    setZipFiles(prev => {
      const existing = new Set(prev.map(f=>f.name));
      return [...prev, ...zips.filter(f=>!existing.has(f.name))];
    });
  };

  const process = async () => {
    if (!csvRows.length) return;
    setError(''); setStatus('processing'); setResults([]);

    try {
      const JSZip = await loadJSZip();
      const total = csvRows.length;
      const processed = [];

      // Build zip map by catalog number
      const zipMap = {};
      zipFiles.forEach(f => { zipMap[catnoFromZip(f.name)] = f; });

      for (let i = 0; i < csvRows.length; i++) {
        const row = csvRows[i];
        const qtyShipped = parseInt(row['QTY Shipped'] || 0);
        if (qtyShipped === 0) { setProgress({ done:i+1, total, current:'' }); continue; } // skip presale
        const isPresale = false;
        const catno   = row['Catalog'].toUpperCase().trim();
        const title   = decodeHtml(row['Title'] || '');
        const artist  = decodeHtml(row['Artist'] || '');
        const label   = decodeHtml(row['Label'] || '');
        const genre   = mapGenre(row['Genre'] || '');
        const year    = row['Release Date'] ? new Date(row['Release Date']).getFullYear() : '';
        const ppu     = parseFloat(row['PPU'] || 0);
        const rawPrice = ppu * (1 + margin / 100);
        const price   = (Math.ceil(rawPrice) - 0.01).toFixed(2);
        const qtyOrdered = parseInt(row['QTY Ordered'] || 1);
        const format  = row['Format'] || '';
        const is2LP   = /2\s*x\s*12|double\s*lp|3\s*x\s*12/i.test(format) || /2[\s-]?lp/i.test(title);
        const grams   = is2LP ? '900' : '500';
        const tags    = row['Tags'] || '';
        const desc    = decodeHtml(row['Description'] || '');
        const handle  = catno.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-+$/,'');

        setProgress({ done:i, total, current:`${catno} — processing…` });

        let coverUrl = '';
        let tracks   = [];
        let itemError = '';

        // Try to find matching ZIP
        const zipFile = zipMap[catno] || zipFiles.find(f => {
          const zcat = catnoFromZip(f.name);
          return zcat.includes(catno) || catno.includes(zcat);
        });

        // Sanitize catno for use in URLs/R2 keys: replace any char that's not
        // alphanumeric/dash/underscore with '-'. Keeps SKU/handle untouched.
        const safeKey = catno.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+/g,'-').replace(/^-|-$/g,'');

        if (zipFile) {
          try {
            setProgress({ done:i, total, current:`${catno} — extracting ZIP…` });
            const zip   = await JSZip.loadAsync(zipFile);
            const files = Object.values(zip.files).filter(f=>!f.dir);

            // Cover image
            const imgFiles  = files.filter(f=>/\.(jpg|jpeg|png)$/i.test(f.name));
            const coverFile = imgFiles.find(f=>/front|cover|artwork/i.test(f.name.toLowerCase())) || imgFiles[0];
            if (coverFile) {
              setProgress({ done:i, total, current:`${catno} — uploading cover…` });
              const blob = await coverFile.async('blob');
              const ext  = coverFile.name.split('.').pop().toLowerCase();
              coverUrl = await uploadToR2(blob, `covers/${safeKey}.${ext}`, ext==='png'?'image/png':'image/jpeg');
            }

            // Audio
            const audioFiles = files.filter(f=>/\.(mp3|wav|flac|aac|ogg)$/i.test(f.name)).sort((a,b)=>a.name.localeCompare(b.name));
            for (const af of audioFiles) {
              const filename = af.name.split('/').pop();
              const safeFilename = filename.replace(/[^A-Za-z0-9._-]+/g, '-');
              setProgress({ done:i, total, current:`${catno} — uploading ${filename}…` });
              const blob = await af.async('blob');
              const url  = await uploadToR2(blob, `audio/${safeKey}/${safeFilename}`, 'audio/mpeg');
              tracks.push({ name: filename.replace(/\.[^.]+$/,''), url });
            }
          } catch(e) { itemError = e.message; }
        }

        // Build description HTML using shared helper
        const descHtml  = buildDescriptionHtml({ artist, title, label, year, tracks, sourceNotes: desc });
        const audioHtml = tracks.length ? `<script type="application/json" id="tracks">${JSON.stringify(tracks)}<\/script>` : '';

        const shopifyTags = ['vinyl','dbh', label?`label:${label}`:'', genre, String(year), tags?tags:''].filter(Boolean).join(', ');

        processed.push({
          _catno: catno, _title: title, _artist: artist,
          _coverUrl: coverUrl, _tracks: tracks, _error: itemError,
          _isPresale: isPresale, _zipFound: !!zipFile,
          'Handle': handle,
          'Title': title || catno,
          'Body (HTML)': `${descHtml}${audioHtml}`,
          'Vendor': artist,
          'Product Category': 'Media > Music & Sound Recordings > Vinyl',
          'Type': '',
          'Tags': shopifyTags,
          'Published': 'TRUE',
          'Option1 Name':'Title','Option1 Value':'Default Title','Option1 Linked To':'',
          'Option2 Name':'','Option2 Value':'','Option2 Linked To':'',
          'Option3 Name':'','Option3 Value':'','Option3 Linked To':'',
          'Variant SKU': catno,
          'Variant Grams': grams,
          'Variant Inventory Tracker': '',
          'Variant Inventory Qty': String(qtyOrdered),
          'Variant Inventory Policy': 'deny',
          'Variant Fulfillment Service': 'manual',
          'Variant Price': price,
          'Variant Compare At Price': '',
          'Variant Requires Shipping': 'TRUE',
          'Variant Taxable': 'FALSE',
          'Unit Price Total Measure':'','Unit Price Total Measure Unit':'',
          'Unit Price Base Measure':'','Unit Price Base Measure Unit':'',
          'Variant Barcode': '',
          'Image Src': coverUrl,
          'Image Position': coverUrl ? '1' : '',
          'Image Alt Text': coverUrl ? `${title} - ${artist}` : '',
          'Gift Card': 'FALSE','SEO Title':'','SEO Description':'',
          'Variant Image':'','Variant Weight Unit':'kg',
          'Variant Tax Code':'','Cost per item': ppu ? ppu.toFixed(2) : '','Status':'active',
        });

        setProgress({ done:i+1, total, current:'' });
      }

      setResults(processed);
      setStatus('review');
    } catch(e) {
      setError(e.message);
      setStatus('idle');
    }
  };

  const downloadCSV = () => {
    const CSV_KEYS = results.length ? Object.keys(results[0]).filter(k=>!k.startsWith('_')) : [];
    const lines = [CSV_KEYS.join(','), ...results.map(row=>CSV_KEYS.map(h=>`"${String(row[h]||'').replace(/"/g,'""')}"`).join(','))];
    const blob = new Blob([lines.join('\n')], { type:'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'dbh_shopify_import.csv';
    a.click();
  };

  const pct       = progress.total ? Math.round((progress.done/progress.total)*100) : 0;
  const covered   = results.filter(r=>r._coverUrl).length;
  const withAudio = results.filter(r=>r._tracks?.length>0).length;
  const presales  = csvRows.filter(r=>parseInt(r['QTY Shipped']||0)===0).length;
  const noZip     = results.filter(r=>!r._zipFound).length;
  const errors    = results.filter(r=>r._error).length;

  return (
    <div>
      <p style={{fontSize:10,color:S.muted,margin:'0 0 14px',lineHeight:1.6}}>
        Upload your DBH order CSV + ZIP files. Description and price come from the CSV. ZIPs provide cover art and audio snippets.
      </p>

      {/* Drop zone */}
      <div
        onDragOver={e=>e.preventDefault()}
        onDrop={e=>{e.preventDefault();const files=[...e.dataTransfer.files];const csv=files.find(f=>/\.csv$/i.test(f.name));if(csv)loadCsv(csv);assignZips(files);}}
        style={{border:`2px dashed ${(csvFile||zipFiles.length)?S.accent:S.border}`,borderRadius:3,padding:'20px',textAlign:'center',marginBottom:14,transition:'border 0.15s'}}
      >
        <div style={{fontSize:28,marginBottom:6}}>🏠</div>
        <div style={{fontSize:11,color:(csvFile||zipFiles.length)?S.accent:S.muted,fontWeight:700,letterSpacing:1,textTransform:'uppercase',marginBottom:10}}>
          Drag DBH order CSV + ZIPs here
        </div>
        <div style={{display:'flex',gap:8,justifyContent:'center'}}>
          <input ref={csvRef} type="file" accept=".csv" style={{display:'none'}} onChange={e=>{if(e.target.files[0])loadCsv(e.target.files[0]);e.target.value='';}} />
          <input ref={zipRef} type="file" accept=".zip" multiple style={{display:'none'}} onChange={e=>{assignZips(e.target.files);e.target.value='';}} />
          <button onClick={()=>csvRef.current.click()} style={{background:csvFile?S.accent:S.border,border:'none',color:csvFile?'#080808':S.muted,cursor:'pointer',fontSize:9,padding:'6px 14px',borderRadius:2,letterSpacing:1,textTransform:'uppercase',fontFamily:'inherit',fontWeight:700}}>
            {csvFile?`✓ ${csvFile}`:'+ Order CSV'}
          </button>
          <button onClick={()=>zipRef.current.click()} style={{background:zipFiles.length?S.accent:S.border,border:'none',color:zipFiles.length?'#080808':S.muted,cursor:'pointer',fontSize:9,padding:'6px 14px',borderRadius:2,letterSpacing:1,textTransform:'uppercase',fontFamily:'inherit',fontWeight:700}}>
            {zipFiles.length?`✓ ${zipFiles.length} ZIPs`:'+ ZIPs'}
          </button>
          {zipFiles.length>0&&<button onClick={()=>setZipFiles([])} style={{background:'none',border:`1px solid ${S.border}`,color:S.muted,cursor:'pointer',fontSize:9,padding:'6px 10px',borderRadius:2,fontFamily:'inherit'}}>Clear</button>}
        </div>
      </div>

      {/* CSV preview */}
      {csvRows.length>0&&status==='idle'&&(
        <div style={{marginBottom:12,fontSize:10,color:S.muted,display:'flex',gap:16,flexWrap:'wrap',padding:'8px 14px',background:S.bg,border:`1px solid ${S.border}`,borderRadius:4}}>
          <span>Releases: <b style={{color:S.text}}>{csvRows.length}</b></span>
          <span>ZIPs matched: <b style={{color:S.accent}}>{csvRows.filter(r=>zipFiles.some(f=>catnoFromZip(f.name).includes(r['Catalog'].toUpperCase())||r['Catalog'].toUpperCase().includes(catnoFromZip(f.name)))).length}/{csvRows.length}</b></span>
          <span>Presale (QTY=0): <b style={{color:'#ff8800'}}>{csvRows.filter(r=>parseInt(r['QTY Shipped']||0)===0).length}</b></span>
        </div>
      )}

      {/* Margin + process */}
      {csvRows.length>0&&status==='idle'&&(
        <div style={{display:'flex',gap:12,alignItems:'center',marginBottom:12,flexWrap:'wrap'}}>
          <div style={{display:'flex',alignItems:'center',gap:6}}>
            <span style={{fontSize:10,color:S.muted}}>Margin %</span>
            <input type="number" value={margin} onChange={e=>setMargin(parseFloat(e.target.value)||60)} style={{width:70,padding:'5px 8px',background:S.surf,border:`1px solid ${S.border}`,borderRadius:2,color:S.text,fontFamily:'monospace',fontSize:12,textAlign:'center',outline:'none'}} />
          </div>
          <span style={{fontSize:9,color:S.muted}}>e.g. €8.80 × {(1+margin/100).toFixed(2)} = €{(8.80*(1+margin/100)).toFixed(2)} → €{(Math.ceil(8.80*(1+margin/100))-0.01).toFixed(2)}</span>
          <div style={{flex:1}}/>
          <Btn ch={`🚀 Process ${csvRows.length} releases`} onClick={process} full />
        </div>
      )}

      {/* Progress */}
      {status==='processing'&&(
        <div style={{padding:14,background:S.bg,borderRadius:2,border:`1px solid ${S.border}`,marginBottom:12}}>
          <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
            <span style={{fontSize:10,color:S.accent,fontWeight:700,letterSpacing:1}}>PROCESSING…</span>
            <span style={{fontSize:10,color:S.muted}}>{progress.done} / {progress.total} · {pct}%</span>
          </div>
          <div style={{height:3,background:S.border,borderRadius:2,overflow:'hidden',marginBottom:8}}>
            <div style={{height:'100%',background:S.accent,width:`${pct}%`,transition:'width 0.3s'}} />
          </div>
          {progress.current&&<div style={{fontSize:9,color:S.muted,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>→ {progress.current}</div>}
        </div>
      )}

      {error&&<div style={{marginBottom:12,padding:10,background:'#1a0000',border:`1px solid ${S.danger}44`,borderRadius:2,fontSize:10,color:S.danger}}>{error}</div>}

      {/* Results */}
      {status==='review'&&results.length>0&&(
        <div>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12,flexWrap:'wrap',gap:8}}>
            <div>
              <span style={{fontSize:11,color:S.accent,fontWeight:700}}>✓ {results.length} releases</span>
              <span style={{fontSize:9,color:S.muted,marginLeft:10}}>
                {covered} covers · {withAudio} audio
                {presales>0?` · ${presales} presale`:''}
                {noZip>0?` · ${noZip} no ZIP`:''}
                {errors>0?` · ${errors} errors`:''}
              </span>
            </div>
            <Btn ch="⬇ Download Shopify CSV" onClick={downloadCSV} />
          </div>

          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))',gap:8,maxHeight:500,overflowY:'auto',padding:4}}>
            {results.map((r,i)=>(
              <div key={i} style={{background:S.surf,border:`1px solid ${r._error?S.danger:r._coverUrl?S.border:'#ff8800'}`,borderRadius:3,overflow:'hidden'}}>
                <div style={{position:'relative',paddingBottom:'100%',background:'#1a1a2e'}}>
                  {r._coverUrl
                    ?<img src={r._coverUrl} alt="" style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover'}} onError={e=>e.target.style.display='none'} />
                    :<div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:24}}>🎵</div>
                  }
                  {r._tracks?.length>0&&<div style={{position:'absolute',bottom:4,left:4,background:'rgba(0,0,0,0.75)',borderRadius:2,fontSize:8,color:S.accent,padding:'2px 6px'}}>▶ {r._tracks.length}</div>}
                  {r._isPresale&&<div style={{position:'absolute',top:4,left:4,background:'#ff8800',borderRadius:2,fontSize:7,color:'#080808',padding:'2px 5px',fontWeight:700}}>PRESALE</div>}
                  {r._error&&<div style={{position:'absolute',top:4,right:4,background:S.danger,borderRadius:2,fontSize:7,color:'#fff',padding:'2px 5px',fontWeight:700}}>ERR</div>}
                  {!r._coverUrl&&!r._error&&<div style={{position:'absolute',top:4,right:4,background:'#ff8800',borderRadius:2,fontSize:7,color:'#080808',padding:'2px 5px',fontWeight:700}}>{r._zipFound?'NO IMG':'NO ZIP'}</div>}
                </div>
                <div style={{padding:'8px 8px 6px'}}>
                  <div style={{fontSize:9,color:S.muted,fontFamily:'monospace',marginBottom:2}}>{r._catno}</div>
                  <div style={{fontSize:10,fontWeight:700,color:S.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r._title||r._catno}</div>
                  <div style={{fontSize:9,color:S.muted,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r._artist}</div>
                  <div style={{fontSize:10,color:S.accent,marginTop:3,fontWeight:700}}>€{r['Variant Price']}</div>
                  {r._error&&<div style={{fontSize:8,color:S.danger,marginTop:4,lineHeight:1.4}}>{r._error}</div>}
                </div>
              </div>
            ))}
          </div>

          <div style={{marginTop:14,display:'flex',justifyContent:'flex-end'}}>
            <Btn ch="⬇ Download Shopify CSV" onClick={downloadCSV} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── ADMIN PANEL ────────────────────────────────────────────────
function AdminPanel({ records, onUpdate, onAdd, onDelete, onLogout, onLoadMore, hasMore, loadingMore }) {
  const [tab,setTab]=useState('zip');
  const [editing,setEditing]=useState(null);
  const [invPage,setInvPage]=useState(1);
  const [invSearch,setInvSearch]=useState('');
  const PAGE_SIZE = 20;
  const adj=(id,d)=>{const r=records.find(r=>r.id===id);onUpdate(id,{stock:Math.max(0,(r?.stock||0)+d)});};
  const tabBtn=(key,label)=><button onClick={()=>setTab(key)} style={{background:tab===key?S.accent:S.border,color:tab===key?'#080808':S.muted,border:'none',borderRadius:2,cursor:'pointer',fontSize:9,fontWeight:tab===key?700:400,letterSpacing:1.5,textTransform:'uppercase',padding:'7px 16px'}}>{label}</button>;
  const filtered = records.filter(r => !invSearch || `${r.title} ${r.artist} ${r.label} ${r.catalog}`.toLowerCase().includes(invSearch.toLowerCase()));
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pageRecords = filtered.slice((invPage-1)*PAGE_SIZE, invPage*PAGE_SIZE);
  return (
    <div style={{maxWidth:860,margin:'0 auto',padding:'36px 20px'}}>
      {editing&&<EditModal record={editing} onSave={updated=>onUpdate(updated.id,updated)} onClose={()=>setEditing(null)} />}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:28}}>
        <div><h1 style={{margin:0,fontSize:18,fontWeight:800}}>Admin Panel</h1><div style={{fontSize:10,color:S.muted,marginTop:4}}>{records.length} records · {records.reduce((s,r)=>s+r.stock,0)} units in stock{hasMore?' · more in Shopify':''}</div></div>
        <Btn ch="Logout" variant="ghost" onClick={onLogout} />
      </div>
      <div style={{background:S.surf,border:`1px solid ${S.border}`,borderRadius:3,padding:22,marginBottom:28}}>
        <div style={{fontSize:9,color:S.muted,letterSpacing:2,textTransform:'uppercase',marginBottom:14}}>Add New Record</div>
        <div style={{display:'flex',gap:6,marginBottom:18,flexWrap:'wrap'}}>
          {tabBtn('zip','📦 W&S Import')}
          {tabBtn('kudos','🎵 Kudos Import')}
          {tabBtn('dbh','🏠 DBH Import')}
        </div>
        {tab==='zip'   && <ZipImporter />}
        {tab==='kudos' && <KudosImporter />}
        {tab==='dbh'   && <DBHImporter />}
      </div>
      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10,flexWrap:'wrap'}}>
        <div style={{fontSize:9,color:S.muted,letterSpacing:2,textTransform:'uppercase'}}>Inventory</div>
        <input value={invSearch} onChange={e=>{setInvSearch(e.target.value);setInvPage(1);}} placeholder="Search inventory…" style={{background:S.surf,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'4px 10px',fontSize:11,fontFamily:'inherit',outline:'none',flex:1,minWidth:120,maxWidth:220}} />
        <span style={{fontSize:9,color:S.muted}}>{filtered.length} records</span>
        {hasMore&&<button onClick={onLoadMore} disabled={loadingMore} style={{background:'none',border:`1px solid ${S.border}`,color:S.muted,cursor:'pointer',fontSize:9,letterSpacing:1,textTransform:'uppercase',padding:'4px 10px',borderRadius:2}}>{loadingMore?'Loading…':'Load All from Shopify'}</button>}
      </div>
      <div style={{display:'flex',flexDirection:'column',gap:1}}>
        {pageRecords.map(r=>(
          <div key={r.id} style={{display:'flex',alignItems:'center',gap:12,background:S.surf,padding:'10px 14px',borderRadius:2,flexWrap:'wrap'}}>
            <div style={{width:40,height:40,borderRadius:2,background:`linear-gradient(${r.g})`,backgroundImage:coverSrc(r.coverUrl)?`url(${coverSrc(r.coverUrl)})`:'none',backgroundSize:'cover',flexShrink:0}} />
            <div style={{flex:1,minWidth:120}}><div style={{fontSize:12,fontWeight:700,color:S.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.title}</div><div style={{fontSize:9,color:S.muted}}>{r.artist} · {r.label}</div></div>
            <div style={{fontSize:12,color:S.accent,fontWeight:800}}>€{r.price.toFixed(2)}</div>
            <div style={{display:'flex',alignItems:'center',gap:6}}>
              <button onClick={()=>adj(r.id,-1)} style={{width:22,height:22,borderRadius:2,background:S.border,border:'none',cursor:'pointer',color:S.text,fontSize:14}}>-</button>
              <span style={{fontSize:13,fontWeight:700,color:r.stock===0?S.danger:r.stock<=3?'#ff8800':S.text,width:24,textAlign:'center'}}>{r.stock}</span>
              <button onClick={()=>adj(r.id,1)} style={{width:22,height:22,borderRadius:2,background:S.border,border:'none',cursor:'pointer',color:S.text,fontSize:14}}>+</button>
            </div>
            <button onClick={()=>setEditing(r)} style={{background:'none',border:`1px solid ${S.border}`,color:S.muted,cursor:'pointer',fontSize:9,letterSpacing:1,textTransform:'uppercase',padding:'4px 10px',borderRadius:2}}>Edit</button>
            <button onClick={()=>onDelete(r.id)} style={{background:'none',border:'none',color:S.muted,cursor:'pointer',fontSize:13,padding:4}}>🗑</button>
          </div>
        ))}
      </div>
      {totalPages > 1 && (
        <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:8,marginTop:16}}>
          <button onClick={()=>setInvPage(p=>Math.max(1,p-1))} disabled={invPage===1} style={{background:S.border,border:'none',color:invPage===1?S.muted:S.text,cursor:invPage===1?'not-allowed':'pointer',borderRadius:2,padding:'5px 12px',fontSize:10}}>← Prev</button>
          <span style={{fontSize:10,color:S.muted}}>{invPage} / {totalPages} · {filtered.length} records</span>
          <button onClick={()=>setInvPage(p=>Math.min(totalPages,p+1))} disabled={invPage===totalPages} style={{background:S.border,border:'none',color:invPage===totalPages?S.muted:S.text,cursor:invPage===totalPages?'not-allowed':'pointer',borderRadius:2,padding:'5px 12px',fontSize:10}}>Next →</button>
        </div>
      )}
    </div>
  );
}

// ── LOGIN ──────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [pw,setPw]=useState(''); const [err,setErr]=useState(false);
  const attempt=()=>{if(pw==='waxlab2024') onLogin(); else {setErr(true);setTimeout(()=>setErr(false),1500);}};
  return (
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center'}}>
      <div style={{width:280,background:S.surf,border:`1px solid ${S.border}`,borderRadius:3,padding:32}}>
        <div style={{fontSize:9,letterSpacing:3,color:S.muted,textTransform:'uppercase',marginBottom:24}}>Admin Access</div>
        <input type="password" value={pw} onChange={e=>setPw(e.target.value)} onKeyDown={e=>e.key==='Enter'&&attempt()} placeholder="Password" style={{width:'100%',background:S.bg,border:`1px solid ${err?S.danger:S.border}`,color:S.text,borderRadius:2,padding:'9px 12px',fontSize:12,fontFamily:'inherit',outline:'none',boxSizing:'border-box',marginBottom:12}} />
        <Btn ch="Enter" onClick={attempt} full />
        {err&&<div style={{fontSize:10,color:S.danger,marginTop:8,textAlign:'center'}}>Incorrect password</div>}
      </div>
    </div>
  );
}

// ── POLICY DRAWER ──────────────────────────────────────────────
const POLICY_SLUGS = {
  'privacy-policy':      'privacyPolicy',
  'terms-of-service':    'termsOfService',
  'refund-policy':       'refundPolicy',
  'shipping-policy':     'shippingPolicy',
  'legal-notice':        'hardcoded',
  'contact-information': 'hardcoded',
};

const HARDCODED_POLICIES = {
  'legal-notice': {
    title: 'Legal Notice',
    body: `
      <p><strong>HOUSEONLY</strong> is operated by:</p>
      <p><strong>Telsnap S.L.</strong><br/>
      NIF: B75303990<br/>
      Registered in Spain</p>
      <p><strong>Contact:</strong> <a href="mailto:info@houseonly.store">info@houseonly.store</a></p>
      <p>The European Commission provides a platform for online dispute resolution (ODR) accessible at <a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noreferrer">ec.europa.eu/consumers/odr</a>.</p>
      <p>All content on this website is the property of Telsnap S.L. or its content suppliers and is protected by applicable intellectual property laws.</p>
    `,
  },
  'contact-information': {
    title: 'Contact',
    body: `
      <p>For any questions about your order, shipping, or general enquiries:</p>
      <p><strong>General:</strong> <a href="mailto:info@houseonly.store">info@houseonly.store</a><br/>
      <strong>Orders:</strong> <a href="mailto:orders@houseonly.store">orders@houseonly.store</a></p>
      <p>We aim to respond within 24–48 hours on business days.</p>
    `,
  },
};

async function fetchPolicy(field) {
  if (!field) return null;
  const data = await shopifyQuery(`{ shop { ${field} { title body } } }`);
  return data?.shop?.[field] || null;
}

function PolicyDrawer({ slug, onClose }) {
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!slug) return;
    setContent(null);
    setLoading(true);
    const field = POLICY_SLUGS[slug];
    if (field === 'hardcoded') {
      setContent(HARDCODED_POLICIES[slug] || { title: 'Not found', body: '<p>Content not available.</p>' });
      setLoading(false);
      return;
    }
    fetchPolicy(field)
      .then(p => { setContent(p); setLoading(false); })
      .catch(() => { setContent({ title: 'Error', body: '<p>Could not load policy.</p>' }); setLoading(false); });
  }, [slug]);

  const open = !!slug;

  return (
    <>
      {open && <div onClick={onClose} style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.5)',zIndex:900}} />}
      <div style={{position:'fixed',top:0,right:0,bottom:0,width:Math.min(560,window.innerWidth),background:S.surf,borderLeft:`1px solid ${S.border}`,zIndex:1000,transform:open?'translateX(0)':'translateX(100%)',transition:'transform 0.25s ease',display:'flex',flexDirection:'column'}}>
        <div style={{padding:'18px 22px',borderBottom:`1px solid ${S.border}`,display:'flex',justifyContent:'space-between',alignItems:'center',flexShrink:0}}>
          <span style={{fontWeight:800,fontSize:11,letterSpacing:2,textTransform:'uppercase',color:S.text}}>{content?.title || '…'}</span>
          <button onClick={onClose} style={{background:'none',border:'none',color:S.muted,cursor:'pointer',fontSize:20}}>×</button>
        </div>
        <div style={{flex:1,overflowY:'auto',padding:'24px 28px'}}>
          {loading && <div style={{color:S.muted,fontSize:12,textAlign:'center',paddingTop:40}}>Loading…</div>}
          {content && !loading && (
            <>
              <style>{`
                .policy-body { color: ${S.muted}; font-size: 13px; line-height: 1.8; }
                .policy-body h1, .policy-body h2, .policy-body h3 { color: ${S.text}; font-size: 13px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; margin: 24px 0 10px; }
                .policy-body h1:first-child { margin-top: 0; }
                .policy-body p { margin: 0 0 14px; }
                .policy-body a { color: ${S.accent}; text-decoration: none; }
                .policy-body a:hover { text-decoration: underline; }
                .policy-body ul, .policy-body ol { padding-left: 20px; margin: 0 0 14px; }
                .policy-body li { margin-bottom: 6px; }
                .policy-body strong { color: ${S.text}; font-weight: 600; }
              `}</style>
              <div className="policy-body" dangerouslySetInnerHTML={{__html: content.body}} />
            </>
          )}
        </div>
      </div>
    </>
  );
}
function Nav({ onLogo, children }) {
  return (
    <nav style={{position:'sticky',top:0,zIndex:200,background:'rgba(8,8,8,0.96)',backdropFilter:'blur(8px)',borderBottom:`1px solid ${S.border}`,padding:'0 16px',height:52,display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}}>
      <Logo scale={0.65} onClick={onLogo} />
      {children}
    </nav>
  );
}

// ── APP ────────────────────────────────────────────────────────
export default function App() {
  const [records,setRecords]             = useState([]);
  const [shopifyLoaded,setShopifyLoaded] = useState(false);
  const [shopifyErr,setShopifyErr]       = useState('');
  const [hasMore,setHasMore]             = useState(false);
  const [cursor,setCursor]               = useState(null);
  const [loadingMore,setLoadingMore]     = useState(false);
  const [cart,setCart]                   = useState([]);
  const [cartOpen,setCartOpen]           = useState(false);
  const [policySlug,setPolicySlug]       = useState(null);
  const [selected,setSelected]           = useState(null);
  const [filters,setFilters]             = useState({genre:null,label:null,year:null});
  const [search,setSearch]               = useState('');
  const [page,setPage]                   = useState('shop');
  const [path,setPath]                   = useState(typeof window!=='undefined'?window.location.pathname:'/');

  // Keep `path` in sync with browser back/forward
  useEffect(()=>{
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  },[]);

  // Open modal automatically when URL is /products/<slug> and that record is loaded
  useEffect(()=>{
    const m = path.match(/^\/products\/([^/]+)\/?$/);
    if (!m) { if (selected) setSelected(null); return; }
    const slug = m[1];
    if (selected && selected.slug === slug) return;
    const found = records.find(r => r.slug === slug);
    if (found) setSelected(found);
  },[path, records]);

  // Navigation helpers — push URL + update state in one call
  const navigate = (newPath) => {
    if (window.location.pathname === newPath) return;
    window.history.pushState({}, '', newPath);
    setPath(newPath);
  };
  const openProduct = (r) => {
    setSelected(r);
    navigate(`/products/${r.slug}`);
  };
  const closeProduct = () => {
    setSelected(null);
    if (path.startsWith('/products/')) navigate('/');
  };

  useEffect(()=>{
    if (window.location.hash==='#admin') setPage('login');
    const handler = (e) => { if (e.shiftKey && e.ctrlKey && e.key==='A') setPage(p=>p==='shop'?'login':'shop'); };
    window.addEventListener('keydown', handler);
    return ()=>window.removeEventListener('keydown', handler);
  },[]);

  useEffect(()=>{
    fetchShopifyProducts()
      .then(({ products, hasNextPage, endCursor })=>{
        if(products.length){ setRecords(products); setShopifyLoaded(true); setHasMore(hasNextPage); setCursor(endCursor); }
      })
      .catch(e=>setShopifyErr(e.message));
  },[]);

  const loadMore=async()=>{
    if(!hasMore||loadingMore) return; setLoadingMore(true);
    try { const {products,hasNextPage,endCursor}=await fetchShopifyProducts(cursor); setRecords(r=>[...r,...products]); setHasMore(hasNextPage); setCursor(endCursor); } catch(e){setShopifyErr(e.message);}
    setLoadingMore(false);
  };

  const addToCart=r=>setCart(c=>{const ex=c.find(i=>i.id===r.id);return ex?c.map(i=>i.id===r.id?{...i,qty:i.qty+1}:i):[...c,{...r,qty:1}];});
  const setFilter=(k,v)=>setFilters(f=>({...f,[k]:v}));
  const filtered=records.filter(r=>{
    if(filters.genre&&r.genre!==filters.genre) return false;
    if(filters.label&&r.label!==filters.label) return false;
    if(filters.year&&r.year!==filters.year) return false;
    if(search){
      const haystack=`${r.title} ${r.artist} ${r.label} ${r.catalog} ${r.desc} ${r.genre}`.toLowerCase();
      const words=search.toLowerCase().trim().split(/\s+/);
      if(!words.every(w=>haystack.includes(w))) return false;
    }
    return true;
  });
  const cartCount=cart.reduce((s,i)=>s+i.qty,0);

  if(page==='login') return (
    <div style={{background:S.bg,minHeight:'100vh',color:S.text,fontFamily:"'Inter',system-ui,sans-serif"}}>
      <Nav onLogo={()=>setPage('shop')}><button onClick={()=>setPage('shop')} style={{background:'none',border:`1px solid ${S.border}`,color:S.muted,cursor:'pointer',fontSize:9,letterSpacing:1.5,textTransform:'uppercase',padding:'5px 12px',borderRadius:2,whiteSpace:'nowrap'}}>← Shop</button></Nav>
      <LoginScreen onLogin={()=>setPage('admin')} />
    </div>
  );

  if(page==='admin') return (
    <div style={{background:S.bg,minHeight:'100vh',color:S.text,fontFamily:"'Inter',system-ui,sans-serif"}}>
      <Nav onLogo={()=>setPage('shop')}><button onClick={()=>setPage('shop')} style={{background:'none',border:`1px solid ${S.border}`,color:S.muted,cursor:'pointer',fontSize:9,letterSpacing:1.5,textTransform:'uppercase',padding:'5px 12px',borderRadius:2,whiteSpace:'nowrap'}}>← Shop</button></Nav>
      <AdminPanel records={records} onUpdate={(id,p)=>setRecords(rs=>rs.map(r=>r.id===id?{...r,...p}:r))} onAdd={rec=>setRecords(rs=>[...rs,rec])} onDelete={id=>setRecords(rs=>rs.filter(r=>r.id!==id))} onLogout={()=>setPage('shop')} onLoadMore={loadMore} hasMore={hasMore} loadingMore={loadingMore} />
    </div>
  );

  return (
    <div style={{background:S.bg,minHeight:'100vh',color:S.text,fontFamily:"'Inter',system-ui,sans-serif"}}>
      <Nav onLogo={()=>setPage('shop')}>
        <div style={{display:'flex',gap:6,alignItems:'center',flex:1,justifyContent:'flex-end'}}>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search…" style={{background:S.surf,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'5px 10px',fontSize:11,fontFamily:'inherit',outline:'none',width:'100%',maxWidth:180,minWidth:80}} />
          <a href="https://account.houseonly.store" title="My Account" style={{background:S.surf,border:`1px solid ${S.border}`,borderRadius:2,padding:'5px 10px',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,textDecoration:'none'}}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={S.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          </a>
          <button onClick={()=>{setCartOpen(true);}} style={{background:cartCount>0?S.accent:S.surf,color:cartCount>0?'#080808':S.muted,border:`1px solid ${S.border}`,borderRadius:2,padding:'5px 12px',cursor:'pointer',fontSize:10,fontWeight:700,letterSpacing:1.5,textTransform:'uppercase',whiteSpace:'nowrap'}}>
            {cartCount>0?`Cart (${cartCount})`:'Cart'}
          </button>
        </div>
      </Nav>

      <div style={{padding:'56px 20px 44px',borderBottom:`1px solid ${S.border}`,maxWidth:1100,margin:'0 auto'}}>
        <Logo scale={window.innerWidth<480?1.4:2.2} />
        <p style={{color:S.muted,fontSize:11,margin:'16px 0 0',letterSpacing:3,textTransform:'uppercase'}}>Vinyl Delivered Worldwide</p>
      </div>

      <div style={{maxWidth:1100,margin:'0 auto',padding:'28px 16px'}}>
        <Filters filters={filters} onChange={setFilter} records={records} />
        <div style={{fontSize:9,color:S.muted,letterSpacing:2,marginBottom:16,textTransform:'uppercase',display:'flex',alignItems:'center',gap:10}}>
          {filtered.length} record{filtered.length!==1?'s':''}
          {shopifyLoaded&&<span style={{color:S.accent}}>● Live from Shopify</span>}
          {shopifyErr&&<span style={{color:S.danger}}>● {shopifyErr}</span>}
        </div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))',gap:12}}>
          {filtered.map(r=><RecordCard key={r.id} r={r} onOpen={openProduct} onAdd={addToCart} />)}
        </div>
        {!filtered.length&&<div style={{textAlign:'center',color:S.muted,fontSize:12,padding:'60px 0'}}>No records found.</div>}
        {hasMore&&(
          <div style={{textAlign:'center',marginTop:32}}>
            <button onClick={loadMore} disabled={loadingMore} style={{background:'none',border:`1px solid ${S.border}`,color:loadingMore?S.muted:S.text,cursor:loadingMore?'not-allowed':'pointer',fontSize:10,fontWeight:700,letterSpacing:2,textTransform:'uppercase',padding:'12px 32px',borderRadius:2}}>
              {loadingMore?'Loading…':'Load More'}
            </button>
          </div>
        )}
      </div>

      <div style={{borderTop:`1px solid ${S.border}`,padding:'24px 20px',textAlign:'center',marginTop:40}}>
        <span style={{fontSize:9,color:S.muted,letterSpacing:3}}>HOUSEONLY · VINYL RECORD STORE · WORLDWIDE SHIPPING</span>
        <div style={{marginTop:14,display:'flex',gap:16,justifyContent:'center',flexWrap:'wrap'}}>
          {[['Privacy Policy','privacy-policy'],['Terms of Service','terms-of-service'],['Returns & Refunds','refund-policy'],['Shipping Policy','shipping-policy'],['Legal Notice','legal-notice'],['Contact','contact-information']].map(([label,slug])=>(
            <button key={slug} onClick={()=>{setPolicySlug(slug);setCartOpen(false);}} style={{background:'none',border:'none',cursor:'pointer',fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase',padding:0,fontFamily:'inherit',transition:'color 0.15s'}} onMouseEnter={e=>e.target.style.color=S.accent} onMouseLeave={e=>e.target.style.color=S.muted}>{label}</button>
          ))}
        </div>
      </div>

      <PolicyDrawer slug={policySlug} onClose={()=>setPolicySlug(null)} />

      <Modal r={selected} onClose={closeProduct} onAdd={r=>{addToCart(r);setCartOpen(true);}} />
      <CartDrawer cart={cart} open={cartOpen} onClose={()=>setCartOpen(false)} onRemove={id=>setCart(c=>c.filter(i=>i.id!==id))} onCheckout={()=>shopifyCheckout(cart)} />
    </div>
  );
}

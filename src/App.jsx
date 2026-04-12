import { useState, useRef, useEffect } from "react";

const S = {
  bg:'#080808', surf:'#111', border:'#1e1e1e',
  text:'#efefef', muted:'#585858', accent:'#c8ff00', danger:'#ff4040',
};

// Shopify is the source of truth — no hardcoded fallback records

// ── SHOPIFY ────────────────────────────────────────────────────
const SHOPIFY = {
  domain: 'house-only-2.myshopify.com',
  token:  '3edf470af24f9bd4b81bca274121eec4',
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

// Genre tag list — order matters, more specific first
const GENRE_TAGS = ['Detroit House','Chicago House','Afro House','Soulful House','Acid House','Disco House','Tech House','Deep House','Electronic'];
const SKIP_TAGS  = [...GENRE_TAGS,'vinyl','house'];

function parseProduct({ node }) {
  const v    = node.variants.edges[0]?.node;
  const img  = node.images.edges[0]?.node;
  const tags = node.tags || [];
  const genre = GENRE_TAGS.find(g => tags.some(t => t.toLowerCase() === g.toLowerCase())) || 'Deep House';
  const year  = parseInt(tags.find(t => /^\d{4}$/.test(t)) || '0');
  const label = tags.find(t => !SKIP_TAGS.some(s => s.toLowerCase()===t.toLowerCase()) && !/^\d{4}$/.test(t)) || '';
  const desc  = node.descriptionHtml?.replace(/<[^>]+>/g,'') || '';
  const artist= node.vendor || (desc.includes(' — ') ? desc.split(' — ')[0].trim() : '');
  return {
    id: node.id, shopifyVariantId: v?.id,
    title: node.title||'', artist, label,
    catalog: v?.sku||'', genre, year,
    month: new Date().getMonth()+1,
    price: parseFloat(v?.price?.amount||18.99),
    stock: v?.quantityAvailable??10,
    coverUrl: img?.url||null, audio: null,
    tracks: [], desc, g:'135deg,#1a1a2e,#16213e',
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

// ── CHECKOUT — uses Cart API (modern Shopify Storefront API) ──
async function shopifyCheckout(cartItems) {
  const lines = cartItems
    .filter(i => i.shopifyVariantId)
    .map(i => ({ merchandiseId: i.shopifyVariantId, quantity: i.qty }));

  if (!lines.length) {
    throw new Error('No items in cart.');
  }

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
function Modal({ r, onClose, onAdd }) {
  if (!r) return null;
  return (
    <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.88)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000, padding:20, backdropFilter:'blur(4px)' }}>
      <div onClick={e=>e.stopPropagation()} style={{ background:S.surf, border:`1px solid ${S.border}`, borderRadius:4, maxWidth:680, width:'100%', maxHeight:'90vh', overflow:'auto' }}>
        <div style={{ display:'flex', flexWrap:'wrap' }}>
          <div style={{ width:240, minHeight:240, flexShrink:0, background:`linear-gradient(${r.g})`, backgroundImage:coverSrc(r.coverUrl)?`url(${coverSrc(r.coverUrl)})`:'none', backgroundSize:'cover', backgroundPosition:'center' }} />
          <div style={{ flex:1, minWidth:220, padding:'28px 26px 24px' }}>
            <button onClick={onClose} style={{ float:'right', background:'none', border:'none', color:S.muted, cursor:'pointer', fontSize:20 }}>×</button>
            <div style={{ fontSize:9, color:S.muted, letterSpacing:2, textTransform:'uppercase', marginBottom:4 }}>{r.label} · {r.catalog}</div>
            <h2 style={{ margin:'0 0 4px', fontSize:18, fontWeight:800, color:S.text }}>{r.title}</h2>
            <div style={{ fontSize:12, color:S.muted, marginBottom:12 }}>{r.artist}</div>
            <div style={{ display:'flex', gap:6, marginBottom:14, flexWrap:'wrap' }}>
              {[r.genre,r.year].map(v=><span key={v} style={{ fontSize:9, fontWeight:700, letterSpacing:1, padding:'2px 8px', borderRadius:2, background:S.border, color:S.muted, textTransform:'uppercase' }}>{v}</span>)}
            </div>
            <p style={{ fontSize:11, color:S.muted, lineHeight:1.75, marginBottom:16 }}>{r.desc}</p>
            <div style={{ marginBottom:14 }}>
              {r.tracks.map((t,i)=>(
                <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'5px 0', borderBottom:`1px solid ${S.border}`, fontSize:11, color:S.muted }}>
                  <span>{String.fromCharCode(65+i)}. {t.t}</span>
                  <span style={{ fontFamily:'monospace' }}>{t.d}</span>
                </div>
              ))}
            </div>
            <AudioPlayer src={r.audio} />
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
    setErr('');
    setLoading(true);
    try {
      await onCheckout();
    } catch(e) {
      setErr(e.message || 'Checkout failed. Please try again.');
    }
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

// ── FILTERS — mobile-friendly ──────────────────────────────────
function Filters({ filters, onChange, records }) {
  const labels = [...new Set(records.map(r=>r.label))].sort();
  const genres = [...new Set(records.map(r=>r.genre))].sort();
  const years  = [...new Set(records.map(r=>r.year).filter(Boolean))].sort((a,b)=>b-a);
  const months = [...new Set(records.map(r=>r.month))].sort((a,b)=>a-b);
  const MN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const pill = (key,val,label) => {
    const active = filters[key]===val;
    return (
      <button key={String(val)} onClick={()=>onChange(key,active?null:val)} style={{ background:active?S.accent:S.border, color:active?'#080808':S.muted, border:'none', borderRadius:20, cursor:'pointer', fontSize:9, fontWeight:active?700:400, letterSpacing:1.5, padding:'6px 14px', textTransform:'uppercase', transition:'all 0.15s', whiteSpace:'nowrap', flexShrink:0 }}>{label||val}</button>
    );
  };

  const sel = (key, opts, placeholder) => (
    <div style={{ position:'relative', flexShrink:0 }}>
      <select
        value={filters[key]||''}
        onChange={e=>onChange(key,e.target.value||null)}
        style={{
          appearance:'none', WebkitAppearance:'none',
          background:filters[key]?S.accent:S.surf,
          color:filters[key]?'#080808':S.muted,
          border:`1px solid ${filters[key]?S.accent:S.border}`,
          borderRadius:20, cursor:'pointer',
          fontSize:9, fontWeight:filters[key]?700:400,
          letterSpacing:1.5, padding:'6px 28px 6px 14px',
          textTransform:'uppercase', fontFamily:'inherit',
          outline:'none', minWidth:100,
        }}
      >
        <option value="">{placeholder}</option>
        {opts.map(o=><option key={o} value={o}>{o}</option>)}
      </select>
      <span style={{ position:'absolute', right:10, top:'50%', transform:'translateY(-50%)', pointerEvents:'none', fontSize:8, color:filters[key]?'#080808':S.muted }}>▼</span>
    </div>
  );

  return (
    <div style={{ marginBottom:24 }}>
      <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:10 }}>
        {sel('genre', genres, 'All Genres')}
        {sel('label', labels, 'All Labels')}
      </div>
      <div style={{ display:'flex', gap:6, overflowX:'auto', paddingBottom:4, scrollbarWidth:'none', msOverflowStyle:'none' }}>
        {pill('year',null,'All')}{years.map(y=>pill('year',y,y))}
      </div>
      <div style={{ display:'flex', gap:6, overflowX:'auto', paddingBottom:4, marginTop:8, scrollbarWidth:'none', msOverflowStyle:'none' }}>
        {pill('month',null,'All')}{months.map(m=>pill('month',m,MN[m-1]))}
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


// ── BULK IMPORTER ──────────────────────────────────────────────
function BulkImporter({ onImportMany }) {
  const [q,setQ]=useState(''); const [st,setSt]=useState('idle'); const [res,setRes]=useState([]); const [sel,setSel]=useState({}); const [err,setErr]=useState(''); const [done,setDone]=useState(0);
  const SUGG=['Quintessentials','Defected','Nervous Records','Trax Records','KDJ','Running Back','Kompakt','Larry Heard'];
  const search=async()=>{
    if(!q.trim()) return; setSt('loading'); setRes([]); setSel({}); setErr(''); setDone(0);
    try {
      const list=await claudeJSON(`You are a vinyl record data extractor. Do MAX 2 web searches.\nSearch: "${q}" discogs vinyl releases\nExtract up to 8 real releases. Do NOT invent data.\nReturn ONLY one JSON array: [${SCHEMA}]\ncoverUrl: publicly accessible image URL (not discogs CDN).\ngenre: one of ${GLIST}. price: 18.99 default.`,`Find real vinyl releases for: "${q}". Return ONE JSON array only.`,true);
      const arr=Array.isArray(list)?list:[list]; if(!arr.length) throw new Error('No releases found.');
      setRes(arr); const s={};arr.forEach((_,i)=>s[i]=true); setSel(s); setSt('done');
    } catch(e){setErr(e.message||'Error'); setSt('error');}
  };
  const toggleAll=()=>{const on=res.every((_,i)=>sel[i]);const n={};if(!on) res.forEach((_,i)=>n[i]=true);setSel(n);};
  const add=()=>{const t=res.filter((_,i)=>sel[i]).map(r=>({id:Date.now()+Math.random(),...r,audio:r.audioUrl||null,month:new Date().getMonth()+1,stock:10,g:'135deg,#1a1a2e,#16213e'}));onImportMany(t);setDone(t.length);setRes([]);setSel({});setQ('');setSt('idle');};
  const sc=Object.values(sel).filter(Boolean).length;
  return (
    <div>
      <p style={{fontSize:10,color:S.muted,margin:'0 0 12px'}}>Search by label or artist. AI finds real releases from Discogs.</p>
      <div style={{display:'flex',gap:8,marginBottom:10}}>
        <input value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>e.key==='Enter'&&search()} placeholder='e.g. "Quintessentials", "Defected"…' style={{flex:1,background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'8px 12px',fontSize:11,fontFamily:'inherit',outline:'none'}} />
        <Btn ch={st==='loading'?'…':'Search'} onClick={search} disabled={st==='loading'||!q.trim()} />
      </div>
      {st==='idle'&&!done&&<div style={{display:'flex',flexWrap:'wrap',gap:5}}>{SUGG.map(s=><button key={s} onClick={()=>setQ(s)} style={{background:S.border,color:S.muted,border:'none',borderRadius:20,cursor:'pointer',fontSize:9,letterSpacing:1,padding:'3px 10px',textTransform:'uppercase'}}>{s}</button>)}</div>}
      {st==='loading'&&<div style={{marginTop:12,padding:14,background:S.bg,borderRadius:2,border:`1px solid ${S.border}`}}><div style={{fontSize:10,color:S.muted,marginBottom:8}}>Searching…</div><div style={{height:2,background:S.border,borderRadius:1,overflow:'hidden'}}><div style={{height:'100%',background:S.accent,animation:'kf 1.2s ease-in-out infinite'}} /></div><style>{`@keyframes kf{0%,100%{opacity:.4;width:20%}50%{opacity:1;width:85%}}`}</style></div>}
      {st==='error'&&<div style={{marginTop:10,padding:12,background:'#1a0000',border:`1px solid ${S.danger}33`,borderRadius:2}}><div style={{fontSize:10,color:S.danger,fontWeight:700,marginBottom:4}}>Search failed</div><div style={{fontSize:10,color:'#ff8080'}}>{err}</div></div>}
      {done>0&&st==='idle'&&<div style={{marginTop:10,fontSize:11,color:S.accent}}>✓ {done} record{done!==1?'s':''} added.</div>}
      {st==='done'&&res.length>0&&(
        <div style={{marginTop:14}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10,flexWrap:'wrap',gap:8}}>
            <span style={{fontSize:10,color:S.muted}}>Found <b style={{color:S.text}}>{res.length}</b> · <b style={{color:S.accent}}>{sc}</b> selected</span>
            <div style={{display:'flex',gap:6}}><button onClick={toggleAll} style={{background:'none',border:`1px solid ${S.border}`,color:S.muted,cursor:'pointer',fontSize:9,letterSpacing:1.5,textTransform:'uppercase',padding:'4px 10px',borderRadius:2}}>{res.every((_,i)=>sel[i])?'Deselect All':'Select All'}</button><Btn ch={`Add ${sc}`} onClick={add} disabled={!sc} /></div>
          </div>
          <div style={{display:'flex',flexDirection:'column',gap:1,maxHeight:380,overflowY:'auto',borderRadius:2,border:`1px solid ${S.border}`}}>
            {res.map((r,i)=>(
              <label key={i} style={{display:'flex',alignItems:'center',gap:12,padding:'10px 14px',background:sel[i]?'#141400':S.surf,cursor:'pointer'}}>
                <input type="checkbox" checked={!!sel[i]} onChange={()=>setSel(s=>({...s,[i]:!s[i]}))} style={{accentColor:S.accent,width:14,height:14,flexShrink:0}} />
                {r.coverUrl?<img src={coverSrc(r.coverUrl)} alt="" style={{width:40,height:40,objectFit:'cover',borderRadius:2,flexShrink:0}} onError={e=>e.target.style.display='none'} />:<div style={{width:40,height:40,borderRadius:2,flexShrink:0,background:'linear-gradient(135deg,#1a1a2e,#16213e)'}} />}
                <div style={{flex:1,minWidth:0}}><div style={{fontSize:12,fontWeight:700,color:sel[i]?S.text:S.muted,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.title}{r.artist?` — ${r.artist}`:''}</div><div style={{fontSize:9,color:S.muted,marginTop:1}}>{r.label} · {r.catalog} · {r.year||'—'}</div></div>
                <span style={{fontSize:11,fontWeight:700,color:sel[i]?S.accent:S.muted,flexShrink:0}}>€{Number(r.price||18.99).toFixed(2)}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── URL IMPORTER ───────────────────────────────────────────────
function UrlImporter({ onImport }) {
  const [url,setUrl]=useState(''); const [loading,setLoading]=useState(false); const [result,setResult]=useState(null); const [err,setErr]=useState('');
  const run=async()=>{if(!url.trim()) return;setLoading(true);setErr('');setResult(null);try{const r=await claudeJSON(`Extract vinyl record data from a URL. Return ONLY JSON: ${SCHEMA}. genre: ${GLIST}.`,`Extract from: ${url}`,true);setResult(r);}catch(e){setErr(e.message);}setLoading(false);};
  const confirm=()=>{onImport({id:Date.now(),...result,audio:result.audioUrl||null,month:new Date().getMonth()+1,stock:10,g:'135deg,#1a1a2e,#16213e'});setResult(null);setUrl('');};
  return (
    <div>
      <div style={{display:'flex',gap:8}}><input value={url} onChange={e=>setUrl(e.target.value)} onKeyDown={e=>e.key==='Enter'&&run()} placeholder="Paste product URL…" style={{flex:1,background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'8px 12px',fontSize:11,fontFamily:'inherit',outline:'none'}} /><Btn ch={loading?'…':'Import'} onClick={run} disabled={loading||!url.trim()} /></div>
      {err&&<div style={{fontSize:10,color:S.danger,marginTop:8}}>{err}</div>}
      {result&&<div style={{marginTop:12,padding:14,background:S.bg,borderRadius:2}}><div style={{fontSize:13,fontWeight:700,color:S.text}}>{result.title} — {result.artist}</div><div style={{fontSize:10,color:S.muted,marginTop:3}}>{result.label} · {result.year}</div><div style={{marginTop:10,display:'flex',gap:8}}><Btn ch="Add to Store" onClick={confirm} /><Btn ch="Discard" variant="ghost" onClick={()=>setResult(null)} /></div></div>}
    </div>
  );
}

// ── BARCODE IMPORTER ───────────────────────────────────────────
function BarcodeImporter({ onImport }) {
  const [bc,setBc]=useState(''); const [cam,setCam]=useState(false); const [loading,setLoading]=useState(false); const [result,setResult]=useState(null); const [err,setErr]=useState(''); const [camErr,setCamErr]=useState('');
  const vRef=useRef(null); const sRef=useRef(null); const aRef=useRef(false);
  const lookup=async(code)=>{setLoading(true);setErr('');setResult(null);try{const r=await claudeJSON(`Find vinyl by barcode. Return ONLY JSON: ${SCHEMA}. genre: ${GLIST}.`,`Find vinyl with barcode: ${code}`,true);setResult({...r,barcode:code});}catch(e){setErr(e.message);}setLoading(false);};
  const startCam=async()=>{setCamErr('');if(!('BarcodeDetector'in window)){setCamErr('Needs Chrome/Edge/Safari 17+.');return;}try{const s=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});sRef.current=s;setCam(true);aRef.current=true;setTimeout(async()=>{if(!vRef.current) return;vRef.current.srcObject=s;await vRef.current.play().catch(()=>{});const d=new window.BarcodeDetector({formats:['ean_13','ean_8','upc_a','upc_e','code_128']});const scan=async()=>{if(!aRef.current) return;try{const c=await d.detect(vRef.current);if(c.length){stopCam();setBc(c[0].rawValue);lookup(c[0].rawValue);return;}}catch{}requestAnimationFrame(scan);};requestAnimationFrame(scan);},300);}catch{setCamErr('Could not access camera.');}};
  const stopCam=()=>{aRef.current=false;setCam(false);if(sRef.current){sRef.current.getTracks().forEach(t=>t.stop());sRef.current=null;}};
  useEffect(()=>()=>stopCam(),[]);
  const confirm=()=>{onImport({id:Date.now(),...result,audio:result.audioUrl||null,month:new Date().getMonth()+1,stock:10,g:'135deg,#1a1a2e,#16213e'});setResult(null);setBc('');};
  return (
    <div>
      <div style={{display:'flex',gap:8}}>
        <div style={{position:'relative',flex:1}}><span style={{position:'absolute',left:10,top:'50%',transform:'translateY(-50%)',color:S.muted,pointerEvents:'none'}}>▥</span><input value={bc} onChange={e=>setBc(e.target.value)} onKeyDown={e=>e.key==='Enter'&&bc.trim()&&lookup(bc.trim())} placeholder="Scan or type EAN/UPC…" style={{width:'100%',background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'8px 12px 8px 28px',fontSize:11,fontFamily:'inherit',outline:'none',boxSizing:'border-box'}} /></div>
        <Btn ch={loading?'…':'Lookup'} onClick={()=>bc.trim()&&lookup(bc.trim())} disabled={loading||!bc.trim()} />
        <Btn ch="📷" variant="ghost" onClick={cam?stopCam:startCam} />
      </div>
      {cam&&<div style={{marginTop:10,position:'relative',borderRadius:3,overflow:'hidden',border:`1px solid ${S.border}`}}><video ref={vRef} style={{width:'100%',maxHeight:220,objectFit:'cover',display:'block'}} muted playsInline /><div style={{position:'absolute',inset:0,pointerEvents:'none'}}><div style={{position:'absolute',left:'10%',right:'10%',top:'50%',height:2,background:`${S.accent}88`,animation:'scan 1.6s ease-in-out infinite'}} /></div><div style={{position:'absolute',bottom:0,left:0,right:0,padding:'8px 12px',background:'rgba(0,0,0,0.7)',display:'flex',justifyContent:'space-between'}}><span style={{fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase'}}>Scanning…</span><button onClick={stopCam} style={{background:'none',border:`1px solid ${S.border}`,color:S.muted,cursor:'pointer',fontSize:9,padding:'3px 8px',borderRadius:2}}>Cancel</button></div><style>{`@keyframes scan{0%,100%{top:25%}50%{top:70%}}`}</style></div>}
      {camErr&&<div style={{fontSize:10,color:S.danger,marginTop:6}}>{camErr}</div>}
      <div style={{marginTop:6,fontSize:9,color:S.muted}}>💡 USB scanner? Click input and scan.</div>
      {err&&<div style={{fontSize:10,color:S.danger,marginTop:8}}>{err}</div>}
      {loading&&<div style={{fontSize:10,color:S.muted,marginTop:8}}>Looking up…</div>}
      {result&&<div style={{marginTop:12,padding:14,background:S.bg,borderRadius:2}}><div style={{fontSize:13,fontWeight:700,color:S.text}}>{result.title} — {result.artist}</div><div style={{fontSize:10,color:S.muted,marginTop:3}}>{result.label} · {result.year}</div><div style={{marginTop:10,display:'flex',gap:8}}><Btn ch="Add to Store" onClick={confirm} /><Btn ch="Discard" variant="ghost" onClick={()=>setResult(null)} /></div></div>}
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

// ── AUDIO BATCH UPLOADER ───────────────────────────────────────

// ── CSV ENRICHER ───────────────────────────────────────────────
// Cover art via Cloudflare Worker — Deezer UPC → Spotify (title+artist+label+year+catno) → Deezer search
const WORKER_URL = 'https://houseonly-worker.emontagut.workers.dev';

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

function CsvEnricher() {
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState('idle');
  const [progress, setProgress] = useState({ done:0, total:0, current:'' });
  const [enriched, setEnriched] = useState([]);
  const [overrides, setOverrides] = useState({}); // manual image URL overrides
  const [secondPass, setSecondPass] = useState(false);
  const [secondProgress, setSecondProgress] = useState({ done:0, total:0, current:'' });
  const inputRef = useRef(null);

  const handleFile = async (f) => {
    setStatus('parsing'); setRows([]); setEnriched([]); setOverrides({});
    const buf = await f.arrayBuffer();
    if (!window.XLSX) {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
    }
    const wb = window.XLSX.read(buf);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw = window.XLSX.utils.sheet_to_json(ws, { defval:'' });
    const cleaned = raw.filter(r => r.ArtNo || r.Title);
    setRows(cleaned);
    setStatus('idle');
  };

  const runEnrich = async () => {
    if (!rows.length) return;
    setStatus('enriching');
    setProgress({ done:0, total:rows.length, current:'' });
    const result = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const title  = String(row.Title || '');
      const artist = String(row.Artist || '');
      const catno  = String(row.ArtNo || '');
      const ean    = row.EAN ? String(Math.round(Number(row.EAN))) : '';
      const label  = String(row.Label || row.label || '');
      const year   = row.Releasedate ? new Date(row.Releasedate).getFullYear() : '';
      setProgress({ done:i, total:rows.length, current:`${catno} — ${title}` });
      const imageUrl = await fetchCoverArt(title, artist, ean, label, year, catno);
      const handle = catno.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
      const eanFinal = row.EAN ? String(Math.round(Number(row.EAN))) : '';
      result.push({
        _title: title, _artist: artist, _catno: catno, _imageUrl: imageUrl,
        'Handle': handle,
        'Title': title,
        'Body (HTML)': '<p></p>',
        'Vendor': artist,
        'Product Category': 'Media > Music & Sound Recordings > Vinyl',
        'Type': '',
        'Tags': 'vinyl',
        'Published': 'TRUE',
        'Option1 Name': 'Title',
        'Option1 Value': 'Default Title',
        'Option1 Linked To': '',
        'Option2 Name': '',
        'Option2 Value': '',
        'Option2 Linked To': '',
        'Option3 Name': '',
        'Option3 Value': '',
        'Option3 Linked To': '',
        'Variant SKU': catno,
        'Variant Grams': '180',
        'Variant Inventory Tracker': '',
        'Variant Inventory Qty': String(row.Qty || '1'),
        'Variant Inventory Policy': 'deny',
        'Variant Fulfillment Service': 'manual',
        'Variant Price': String(row.UnitPrice || '18.99'),
        'Variant Compare At Price': '',
        'Variant Requires Shipping': 'TRUE',
        'Variant Taxable': 'FALSE',
        'Unit Price Total Measure': '',
        'Unit Price Total Measure Unit': '',
        'Unit Price Base Measure': '',
        'Unit Price Base Measure Unit': '',
        'Variant Barcode': eanFinal,
        'Image Src': imageUrl,
        'Image Position': imageUrl ? '1' : '',
        'Image Alt Text': imageUrl ? `${title} - ${artist}` : '',
        'Gift Card': 'FALSE',
        'SEO Title': '',
        'SEO Description': '',
        'Variant Image': '',
        'Variant Weight Unit': 'kg',
        'Variant Tax Code': '',
        'Cost per item': '',
        'Status': 'active',
      });
      await new Promise(r => setTimeout(r, 500));
    }
    setProgress({ done:rows.length, total:rows.length, current:'' });
    setEnriched(result);
    setStatus('review');
  };

  const downloadCSV = () => {
    const csvRows = enriched.map((row, i) => {
      const finalImg = overrides[i] !== undefined ? overrides[i] : row['Image Src'];
      const out = {...row};
      out['Image Src'] = finalImg;
      out['Image Position'] = finalImg ? '1' : '';
      out['Image Alt Text'] = finalImg ? `${row._title} - ${row._artist}` : '';
      // Remove internal fields
      delete out._title; delete out._artist; delete out._catno; delete out._imageUrl;
      return out;
    });
    const headers = Object.keys(csvRows[0]);
    const lines = [
      headers.join(','),
      ...csvRows.map(row => headers.map(h => `"${String(row[h]||'').replace(/"/g,'""')}"`).join(','))
    ];
    const blob = new Blob([lines.join('\n')], { type:'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'shopify_import.csv';
    a.click();
  };

  const runSecondPass = async () => {
    const missing = enriched.map((r,i) => ({i, r})).filter(({i,r}) =>
      !overrides[i] && !r['Image Src']
    );
    if (!missing.length) return;
    setSecondPass(true);
    setSecondProgress({ done:0, total:missing.length, current:'' });
    for (let idx = 0; idx < missing.length; idx++) {
      const { i, r } = missing[idx];
      setSecondProgress({ done:idx, total:missing.length, current:r._title });
      const img = await fetchCoverArt(r._title, r._artist, r['Variant Barcode'], r._catno || '', '', '');
      if (img) {
        setOverrides(o => ({...o, [i]: img}));
        // also update enriched record
        setEnriched(prev => prev.map((rec, ii) => ii===i ? {...rec, 'Image Src': img} : rec));
      }
      await new Promise(res => setTimeout(res, 500));
    }
    setSecondProgress({ done:missing.length, total:missing.length, current:'' });
    setSecondPass(false);
  };

  const covered = enriched.filter((r,i) => (overrides[i] !== undefined ? overrides[i] : r['Image Src'])).length;
  const missing = enriched.filter((r,i) => !overrides[i] && !r['Image Src']).length;
  const pct = progress.total ? Math.round((progress.done/progress.total)*100) : 0;

  return (
    <div>
      <p style={{fontSize:10,color:S.muted,margin:'0 0 14px',lineHeight:1.6}}>
        Upload your distributor Excel. Covers are fetched using title + artist + label + year + catalog number for precision. Review all images before downloading.
      </p>

      <div onClick={()=>inputRef.current.click()} style={{border:`2px dashed ${rows.length?S.accent:S.border}`,borderRadius:3,padding:'20px',textAlign:'center',cursor:'pointer',marginBottom:14,transition:'border 0.15s'}}>
        <div style={{fontSize:24,marginBottom:6}}>📥</div>
        <div style={{fontSize:11,color:rows.length?S.accent:S.muted,fontWeight:700,letterSpacing:1,textTransform:'uppercase'}}>
          {rows.length ? `${rows.length} records loaded` : 'Click to upload distributor Excel'}
        </div>
        <div style={{fontSize:9,color:S.muted,marginTop:3}}>Supports .xlsx files from Word and Sound / your distributor</div>
        <input ref={inputRef} type="file" accept=".xlsx,.xls" style={{display:'none'}} onChange={e=>e.target.files[0]&&handleFile(e.target.files[0])} />
      </div>

      {status==='parsing' && <div style={{fontSize:10,color:S.muted}}>Reading file…</div>}

      {status==='idle' && rows.length>0 && (
        <Btn ch={`Fetch Covers for ${rows.length} Records`} onClick={runEnrich} full />
      )}

      {status==='enriching' && (
        <div style={{padding:14,background:S.bg,borderRadius:2,border:`1px solid ${S.border}`}}>
          <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
            <span style={{fontSize:10,color:S.accent,fontWeight:700,letterSpacing:1}}>FETCHING COVERS…</span>
            <span style={{fontSize:10,color:S.muted}}>{progress.done} / {progress.total} · {pct}%</span>
          </div>
          <div style={{height:3,background:S.border,borderRadius:2,overflow:'hidden',marginBottom:8}}>
            <div style={{height:'100%',background:S.accent,width:`${pct}%`,transition:'width 0.3s'}} />
          </div>
          {progress.current&&<div style={{fontSize:9,color:S.muted,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>→ {progress.current}</div>}
        </div>
      )}

      {status==='review' && enriched.length>0 && (
        <div>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12,flexWrap:'wrap',gap:8}}>
            <div>
              <span style={{fontSize:11,color:S.accent,fontWeight:700}}>✓ {covered} of {enriched.length} covers found</span>
              {missing>0 && <span style={{fontSize:9,color:'#ff8800',marginLeft:8}}>{missing} missing</span>}
              <span style={{fontSize:9,color:S.muted,marginLeft:8}}>Review below — paste a URL to fix any wrong image</span>
            </div>
            <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
              {missing>0 && !secondPass && <Btn ch={`🔄 Second Pass (${missing} missing)`} onClick={runSecondPass} variant="ghost" />}
              <Btn ch="⬇ Download Shopify CSV" onClick={downloadCSV} />
            </div>
          </div>
          {secondPass && (
            <div style={{padding:10,background:S.bg,borderRadius:2,border:`1px solid ${S.border}`,marginBottom:10}}>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
                <span style={{fontSize:9,color:'#ff8800',fontWeight:700,letterSpacing:1}}>SECOND PASS — ITUNES + DEEZER…</span>
                <span style={{fontSize:9,color:S.muted}}>{secondProgress.done} / {secondProgress.total}</span>
              </div>
              <div style={{height:2,background:S.border,borderRadius:1,overflow:'hidden',marginBottom:4}}>
                <div style={{height:'100%',background:'#ff8800',width:`${secondProgress.total?Math.round((secondProgress.done/secondProgress.total)*100):0}%`,transition:'width 0.3s'}} />
              </div>
              {secondProgress.current&&<div style={{fontSize:9,color:S.muted}}>→ {secondProgress.current}</div>}
            </div>
          )}
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(180px,1fr))',gap:8,maxHeight:520,overflowY:'auto',padding:4}}>
            {enriched.map((r, i) => {
              const imgUrl = overrides[i] !== undefined ? overrides[i] : r['Image Src'];
              const hasOverride = overrides[i] !== undefined;
              return (
                <div key={i} style={{background:S.surf,border:`1px solid ${hasOverride?S.accent:imgUrl?S.border:'#ff4040'}`,borderRadius:3,overflow:'hidden'}}>
                  <div style={{position:'relative',paddingBottom:'100%',background:'#1a1a2e'}}>
                    {imgUrl
                      ? <img src={imgUrl} alt="" style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover'}} onError={e=>{e.target.style.display='none';}} />
                      : <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:20}}>🎵</div>
                    }
                    {!imgUrl && <div style={{position:'absolute',top:4,right:4,background:S.danger,borderRadius:2,fontSize:8,color:'#fff',padding:'2px 5px',fontWeight:700}}>NO IMG</div>}
                    {hasOverride && <div style={{position:'absolute',top:4,right:4,background:S.accent,borderRadius:2,fontSize:8,color:'#080808',padding:'2px 5px',fontWeight:700}}>EDITED</div>}
                  </div>
                  <div style={{padding:'8px 8px 4px'}}>
                    <div style={{fontSize:9,color:S.muted,fontFamily:'monospace',marginBottom:2}}>{r._catno}</div>
                    <div style={{fontSize:10,fontWeight:700,color:S.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r._title}</div>
                    <div style={{fontSize:9,color:S.muted,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',marginBottom:6}}>{r._artist}</div>
                    <input
                      placeholder="Paste image URL to override…"
                      defaultValue={overrides[i] || ''}
                      onChange={e => setOverrides(o => ({...o, [i]: e.target.value}))}
                      style={{width:'100%',background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'4px 6px',fontSize:9,fontFamily:'inherit',outline:'none',boxSizing:'border-box'}}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{marginTop:12,display:'flex',justifyContent:'flex-end'}}>
            <Btn ch="⬇ Download Shopify CSV" onClick={downloadCSV} />
          </div>
        </div>
      )}
    </div>
  );
}


function AudioBatchUploader({ records, onMatch }) {
  const [matches,setMatches]=useState([]); const [unmatched,setUnmatched]=useState([]); const inputRef=useRef(null); const [drag,setDrag]=useState(false);
  const handleFiles=(files)=>{const matched=[],unmat=[],updates={};Array.from(files).forEach(file=>{if(!/\.(mp3|ogg|wav|flac|aac)$/i.test(file.name)) return;const base=file.name.replace(/\.[^.]+$/,'').trim().toLowerCase();const record=records.find(r=>r.catalog?.toLowerCase().replace(/\s/g,'')=== base.replace(/\s/g,''));const url=URL.createObjectURL(file);if(record){updates[record.id]=url;matched.push({file:file.name,title:record.title,catalog:record.catalog});}else unmat.push(file.name);});setMatches(matched);setUnmatched(unmat);onMatch(updates);};
  return (
    <div style={{marginBottom:28}}>
      <div style={{fontSize:9,color:S.muted,letterSpacing:2,textTransform:'uppercase',marginBottom:10}}>Batch Audio Upload</div>
      <div onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)} onDrop={e=>{e.preventDefault();setDrag(false);handleFiles(e.dataTransfer.files);}} onClick={()=>inputRef.current.click()} style={{border:`2px dashed ${drag?S.accent:S.border}`,borderRadius:3,padding:'24px 20px',textAlign:'center',cursor:'pointer',background:drag?'#141400':'transparent'}}>
        <div style={{fontSize:20,marginBottom:6}}>🎵</div>
        <div style={{fontSize:11,color:drag?S.accent:S.muted,fontWeight:700,letterSpacing:1,textTransform:'uppercase'}}>{drag?'Drop to upload':'Drag audio files or click to browse'}</div>
        <div style={{fontSize:9,color:S.muted,marginTop:4}}>Name files after catalog numbers — e.g. <span style={{color:S.text,fontFamily:'monospace'}}>QTN001.mp3</span></div>
        <input ref={inputRef} type="file" multiple accept=".mp3,.ogg,.wav,.flac,.aac" style={{display:'none'}} onChange={e=>handleFiles(e.target.files)} />
      </div>
      {matches.length>0&&<div style={{marginTop:10}}><div style={{fontSize:9,color:S.accent,letterSpacing:1,textTransform:'uppercase',marginBottom:6}}>✓ {matches.length} matched</div>{matches.map((m,i)=><div key={i} style={{display:'flex',gap:8,fontSize:10,color:S.muted,marginBottom:3}}><span style={{color:S.accent}}>▶</span><span style={{fontFamily:'monospace',color:S.text}}>{m.catalog}</span><span>→</span><span>{m.title}</span></div>)}</div>}
      {unmatched.length>0&&<div style={{marginTop:8}}><div style={{fontSize:9,color:'#ff8800',letterSpacing:1,textTransform:'uppercase',marginBottom:4}}>⚠ {unmatched.length} unmatched</div>{unmatched.map((f,i)=><div key={i} style={{fontSize:10,color:S.muted,fontFamily:'monospace',marginBottom:2}}>{f}</div>)}</div>}
    </div>
  );
}

// ── ADMIN PANEL ────────────────────────────────────────────────
function AdminPanel({ records, onUpdate, onAdd, onDelete, onLogout, onLoadMore, hasMore, loadingMore }) {
  const [tab,setTab]=useState('bulk');
  const [editing,setEditing]=useState(null);
  const [invPage,setInvPage]=useState(1);
  const [invSearch,setInvSearch]=useState('');
  const PAGE_SIZE = 20;

  const adj=(id,d)=>{const r=records.find(r=>r.id===id);onUpdate(id,{stock:Math.max(0,(r?.stock||0)+d)});};
  const tabBtn=(key,label)=><button onClick={()=>setTab(key)} style={{background:tab===key?S.accent:S.border,color:tab===key?'#080808':S.muted,border:'none',borderRadius:2,cursor:'pointer',fontSize:9,fontWeight:tab===key?700:400,letterSpacing:1.5,textTransform:'uppercase',padding:'7px 16px'}}>{label}</button>;

  const filtered = records.filter(r =>
    !invSearch || `${r.title} ${r.artist} ${r.label} ${r.catalog}`.toLowerCase().includes(invSearch.toLowerCase())
  );
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pageRecords = filtered.slice((invPage-1)*PAGE_SIZE, invPage*PAGE_SIZE);

  return (
    <div style={{maxWidth:860,margin:'0 auto',padding:'36px 20px'}}>
      {editing&&<EditModal record={editing} onSave={updated=>onUpdate(updated.id,updated)} onClose={()=>setEditing(null)} />}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:28}}>
        <div><h1 style={{margin:0,fontSize:18,fontWeight:800}}>Admin Panel</h1><div style={{fontSize:10,color:S.muted,marginTop:4}}>{records.length} records loaded · {records.reduce((s,r)=>s+r.stock,0)} units in stock{hasMore?' · more in Shopify':''}</div></div>
        <Btn ch="Logout" variant="ghost" onClick={onLogout} />
      </div>
      <div style={{background:S.surf,border:`1px solid ${S.border}`,borderRadius:3,padding:22,marginBottom:28}}>
        <div style={{fontSize:9,color:S.muted,letterSpacing:2,textTransform:'uppercase',marginBottom:14}}>Add New Record</div>
        <div style={{display:'flex',gap:6,marginBottom:18,flexWrap:'wrap'}}>{tabBtn('bulk','⬇ Bulk Search')}{tabBtn('barcode','▥ Barcode')}{tabBtn('url','🔗 Single URL')}{tabBtn('csv','📄 CSV + Covers')}</div>
        {tab==='bulk'&&<BulkImporter onImportMany={recs=>recs.forEach(r=>onAdd(r))} />}
        {tab==='barcode'&&<BarcodeImporter onImport={onAdd} />}
        {tab==='url'&&<UrlImporter onImport={onAdd} />}
        {tab==='csv'&&<CsvEnricher />}
      </div>
      <AudioBatchUploader records={records} onMatch={updates=>Object.entries(updates).forEach(([id,url])=>onUpdate(Number(id),{audio:url}))} />

      {/* Inventory header + search + load all */}
      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10,flexWrap:'wrap'}}>
        <div style={{fontSize:9,color:S.muted,letterSpacing:2,textTransform:'uppercase'}}>Inventory</div>
        <input
          value={invSearch} onChange={e=>{setInvSearch(e.target.value);setInvPage(1);}}
          placeholder="Search inventory…"
          style={{background:S.surf,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'4px 10px',fontSize:11,fontFamily:'inherit',outline:'none',flex:1,minWidth:120,maxWidth:220}}
        />
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

      {/* Pagination */}
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

// ── APP ────────────────────────────────────────────────────────
export default function App() {
  const [records,setRecords]   = useState([]);
  const [shopifyLoaded,setShopifyLoaded] = useState(false);
  const [shopifyErr,setShopifyErr]       = useState('');
  const [hasMore,setHasMore]   = useState(false);
  const [cursor,setCursor]     = useState(null);
  const [loadingMore,setLoadingMore] = useState(false);
  const [cart,setCart]         = useState([]);
  const [cartOpen,setCartOpen] = useState(false);
  const [selected,setSelected] = useState(null);
  const [filters,setFilters]   = useState({genre:null,label:null,year:null,month:null});
  const [search,setSearch]     = useState('');
  const [page,setPage]         = useState('shop');

  useEffect(()=>{
    if (window.location.hash==='#admin') setPage('login');
    const handler = (e) => {
      if (e.shiftKey && e.ctrlKey && e.key==='A') setPage(p=>p==='shop'?'login':'shop');
    };
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
    if(filters.month&&r.month!==filters.month) return false;
    if(search&&!`${r.title} ${r.artist} ${r.label}`.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });
  const cartCount=cart.reduce((s,i)=>s+i.qty,0);

  const Nav=({children})=>(
    <nav style={{position:'sticky',top:0,zIndex:200,background:'rgba(8,8,8,0.96)',backdropFilter:'blur(8px)',borderBottom:`1px solid ${S.border}`,padding:'0 16px',height:52,display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}}>
      <Logo scale={0.65} onClick={()=>setPage('shop')} />
      {children}
    </nav>
  );

  if(page==='login') return (
    <div style={{background:S.bg,minHeight:'100vh',color:S.text,fontFamily:"'Inter',system-ui,sans-serif"}}>
      <Nav><button onClick={()=>setPage('shop')} style={{background:'none',border:`1px solid ${S.border}`,color:S.muted,cursor:'pointer',fontSize:9,letterSpacing:1.5,textTransform:'uppercase',padding:'5px 12px',borderRadius:2,whiteSpace:'nowrap'}}>← Shop</button></Nav>
      <LoginScreen onLogin={()=>{setPage('admin');}} />
    </div>
  );

  if(page==='admin') return (
    <div style={{background:S.bg,minHeight:'100vh',color:S.text,fontFamily:"'Inter',system-ui,sans-serif"}}>
      <Nav><button onClick={()=>setPage('shop')} style={{background:'none',border:`1px solid ${S.border}`,color:S.muted,cursor:'pointer',fontSize:9,letterSpacing:1.5,textTransform:'uppercase',padding:'5px 12px',borderRadius:2,whiteSpace:'nowrap'}}>← Shop</button></Nav>
      <AdminPanel records={records} onUpdate={(id,p)=>setRecords(rs=>rs.map(r=>r.id===id?{...r,...p}:r))} onAdd={rec=>setRecords(rs=>[...rs,rec])} onDelete={id=>setRecords(rs=>rs.filter(r=>r.id!==id))} onLogout={()=>{setPage('shop');}} onLoadMore={loadMore} hasMore={hasMore} loadingMore={loadingMore} />
    </div>
  );

  return (
    <div style={{background:S.bg,minHeight:'100vh',color:S.text,fontFamily:"'Inter',system-ui,sans-serif"}}>
      <Nav>
        <div style={{display:'flex',gap:6,alignItems:'center',flex:1,justifyContent:'flex-end'}}>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search…"
            style={{background:S.surf,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'5px 10px',fontSize:11,fontFamily:'inherit',outline:'none',width:'100%',maxWidth:180,minWidth:80}} />
          <button onClick={()=>setCartOpen(true)} style={{background:cartCount>0?S.accent:S.surf,color:cartCount>0?'#080808':S.muted,border:`1px solid ${S.border}`,borderRadius:2,padding:'5px 12px',cursor:'pointer',fontSize:10,fontWeight:700,letterSpacing:1.5,textTransform:'uppercase',whiteSpace:'nowrap'}}>
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
          {filtered.map(r=><RecordCard key={r.id} r={r} onOpen={setSelected} onAdd={addToCart} />)}
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

      <div style={{borderTop:`1px solid ${S.border}`,padding:24,textAlign:'center',marginTop:40}}>
        <span style={{fontSize:9,color:S.muted,letterSpacing:3}}>HOUSEONLY · VINYL RECORD STORE · WORLDWIDE SHIPPING</span>
      </div>

      <Modal r={selected} onClose={()=>setSelected(null)} onAdd={r=>{addToCart(r);setCartOpen(true);}} />
      <CartDrawer
        cart={cart}
        open={cartOpen}
        onClose={()=>setCartOpen(false)}
        onRemove={id=>setCart(c=>c.filter(i=>i.id!==id))}
        onCheckout={()=>shopifyCheckout(cart)}
      />
    </div>
  );
}
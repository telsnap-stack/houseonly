import { useState, useRef, useEffect } from "react";

const S = {
  bg:'#080808', surf:'#111', border:'#1e1e1e',
  text:'#efefef', muted:'#585858', accent:'#c8ff00', danger:'#ff4040',
};

const RECORDS = [
  { id:1, title:"Late Night Ritual", artist:"Larry Heard", label:"Trax", genre:"Deep House", year:2024, month:3, price:19.99, catalog:"TX-312", stock:8, g:"135deg,#0d0d1a,#1a0d2e", tracks:[{t:"Can You Feel It",d:"8:10"},{t:"Mystery of Love",d:"6:30"}], desc:"A timeless spiritual journey through the deepest Chicago sound.", coverUrl:null, audio:null },
  { id:2, title:"Warehouse Sessions Vol.3", artist:"DJ Sneak", label:"Defected", genre:"Chicago House", year:2024, month:2, price:21.99, catalog:"DFX-091", stock:3, g:"135deg,#1a0a00,#3d1500", tracks:[{t:"Snake Charmer",d:"7:22"},{t:"Ibiza Hustle",d:"6:15"}], desc:"Timeless warehouse energy from the master himself.", coverUrl:null, audio:null },
  { id:3, title:"Acid Rain EP", artist:"Phuture", label:"Trax", genre:"Acid House", year:2024, month:1, price:17.99, catalog:"TX-308", stock:12, g:"135deg,#001800,#003d00", tracks:[{t:"Acid Trax",d:"10:00"},{t:"Your Only Friend",d:"8:44"}], desc:"The original acid house sound, remastered and re-pressed.", coverUrl:null, audio:null },
  { id:4, title:"Solar System", artist:"Moodymann", label:"KDJ", genre:"Soulful House", year:2024, month:3, price:22.99, catalog:"KDJ-043", stock:5, g:"135deg,#1a1500,#4d3800", tracks:[{t:"Solar",d:"9:12"},{t:"Shades",d:"7:05"},{t:"Detroit",d:"5:55"}], desc:"Moodymann at his most introspective and soulful.", coverUrl:null, audio:null },
  { id:5, title:"Bar A Thym", artist:"Kerri Chandler", label:"Nervous", genre:"Deep House", year:2023, month:11, price:20.99, catalog:"NVS-112", stock:7, g:"135deg,#0a001a,#1f0040", tracks:[{t:"Bar A Thym",d:"7:45"},{t:"Atmosphere",d:"6:20"}], desc:"Deep, spiritual house music that transcends time.", coverUrl:null, audio:null },
  { id:6, title:"Answering Machine", artist:"Green Velvet", label:"Relief", genre:"Tech House", year:2024, month:2, price:18.99, catalog:"RLF-088", stock:2, g:"135deg,#001818,#003838", tracks:[{t:"Answering Machine",d:"6:08"},{t:"Flash",d:"7:30"}], desc:"Chicago's finest techno-house crossover.", coverUrl:null, audio:null },
  { id:7, title:"To Be In Love", artist:"Masters At Work", label:"MAW", genre:"Afro House", year:2023, month:12, price:24.99, catalog:"MAW-055", stock:4, g:"135deg,#1a0d00,#5c2d00", tracks:[{t:"To Be In Love",d:"8:22"},{t:"Backfired",d:"7:15"}], desc:"Louie Vega and Kenny Dope at their peak.", coverUrl:null, audio:null },
  { id:8, title:"Kompakt 100", artist:"Various", label:"Kompakt", genre:"Tech House", year:2024, month:3, price:29.99, catalog:"KOM-100", stock:6, g:"135deg,#0a0a1a,#1a1a3d", tracks:[{t:"Speicher 100",d:"9:00"},{t:"Pop Ambient",d:"7:00"}], desc:"100 releases of Cologne minimal perfection.", coverUrl:null, audio:null },
  { id:9, title:"No Way Back", artist:"Adonis", label:"Trax", genre:"Acid House", year:2023, month:10, price:17.99, catalog:"TX-299", stock:9, g:"135deg,#001a0a,#003d1a", tracks:[{t:"No Way Back",d:"7:55"},{t:"We're Rockin' Down the House",d:"6:30"}], desc:"One of the founding texts of acid house.", coverUrl:null, audio:null },
  { id:10, title:"Backseat Driver", artist:"Soulphiction", label:"Philpot", genre:"Deep House", year:2024, month:2, price:21.99, catalog:"PHP-044", stock:3, g:"135deg,#150015,#3a003a", tracks:[{t:"Backseat Driver",d:"8:10"},{t:"Time Well Spent",d:"7:00"}], desc:"South African deep house at its most refined.", coverUrl:null, audio:null },
  { id:11, title:"Sexual Healing (Levan Edit)", artist:"Marvin Gaye", label:"Motown", genre:"Soulful House", year:2024, month:1, price:23.99, catalog:"MOT-777", stock:1, g:"135deg,#1a1400,#504200", tracks:[{t:"Sexual Healing (Levan Edit)",d:"10:30"}], desc:"The Paradise Garage legend edits a soul icon.", coverUrl:null, audio:null },
  { id:12, title:"Future Vision", artist:"Model 500", label:"Metroplex", genre:"Tech House", year:2024, month:1, price:19.99, catalog:"MTX-044", stock:0, g:"135deg,#001020,#003050", tracks:[{t:"Future Vision",d:"6:44"},{t:"Oscillation",d:"5:22"}], desc:"A stunning return to form from the Detroit legend.", coverUrl:null, audio:null },
];

// ── SHOPIFY CONFIG ─────────────────────────────────────────────
const SHOPIFY = {
  domain: 'house-only-2.myshopify.com',
  token:  '3edf470af24f9bd4b81bca274121eec4',
  api:    '2024-01',
};

async function shopifyQuery(query, variables={}) {
  const resp = await fetch(
    `https://${SHOPIFY.domain}/api/${SHOPIFY.api}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': SHOPIFY.token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  const data = await resp.json();
  if (data.errors) throw new Error(data.errors[0].message);
  return data.data;
}

// Fetch products from Shopify and map to our record format
async function fetchShopifyProducts() {
  const data = await shopifyQuery(`{
    products(first: 50) {
      edges {
        node {
          id
          title
          handle
          descriptionHtml
          tags
          variants(first: 1) {
            edges {
              node {
                id
                price { amount currencyCode }
                quantityAvailable
              }
            }
          }
          images(first: 1) {
            edges { node { url altText } }
          }
          metafields(identifiers: [
            {namespace: "custom", key: "artist"},
            {namespace: "custom", key: "label"},
            {namespace: "custom", key: "catalog"},
            {namespace: "custom", key: "genre"},
            {namespace: "custom", key: "audio_url"}
          ]) {
            key namespace value
          }
        }
      }
    }
  }`);
  return data.products.edges.map(({ node }) => {
    const variant   = node.variants.edges[0]?.node;
    const image     = node.images.edges[0]?.node;
    const getMeta   = (key) => node.metafields?.find(m => m?.key === key)?.value || '';
    const yearMatch = node.tags?.find(t => /^\d{4}$/.test(t));
    const monthMatch= node.tags?.find(t => /^month:\d+$/.test(t));
    return {
      id:       node.id,
      shopifyVariantId: variant?.id,
      title:    node.title,
      artist:   getMeta('artist'),
      label:    getMeta('label'),
      catalog:  getMeta('catalog'),
      genre:    getMeta('genre') || 'Deep House',
      year:     yearMatch ? parseInt(yearMatch) : 0,
      month:    monthMatch ? parseInt(monthMatch.split(':')[1]) : new Date().getMonth()+1,
      price:    parseFloat(variant?.price?.amount || 18.99),
      stock:    variant?.quantityAvailable ?? 10,
      coverUrl: image?.url || null,
      audio:    getMeta('audio_url') || null,
      tracks:   [],
      desc:     node.descriptionHtml?.replace(/<[^>]+>/g,'') || '',
      g:        '135deg,#1a1a2e,#16213e',
    };
  });
}

// Create Shopify cart and redirect to checkout
async function shopifyCheckout(cartItems) {
  const lines = cartItems.map(item => ({
    merchandiseId: item.shopifyVariantId,
    quantity: item.qty,
  })).filter(l => l.merchandiseId);

  if (!lines.length) {
    alert('These demo records are not yet in Shopify. Add real products in your Shopify admin first.');
    return;
  }

  const data = await shopifyQuery(`
    mutation cartCreate($input: CartInput!) {
      cartCreate(input: $input) {
        cart { checkoutUrl }
        userErrors { field message }
      }
    }
  `, { input: { lines } });

  const url = data.cartCreate?.cart?.checkoutUrl;
  if (url) window.location.href = url;
  else throw new Error(data.cartCreate?.userErrors?.[0]?.message || 'Checkout failed');
}
function Logo({ scale=1, onClick }) {
  return (
    <svg width={160*scale} height={52*scale} viewBox="0 0 160 52" style={{ display:'block', cursor:onClick?'pointer':'default', flexShrink:0 }} onClick={onClick}>
      <text x="0" y="34" fontSize="36" fontWeight="900" fill="#efefef" fontFamily="'Inter',system-ui,sans-serif" letterSpacing="-1">HOUSE</text>
      <rect x="0" y="38" width={scale < 0.8 ? 100 : 148} height="3" fill="#c8ff00"/>
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
    <button onClick={disabled?null:onClick} style={{
      ...v[variant], cursor:disabled?'not-allowed':'pointer',
      fontFamily:'inherit', fontWeight:700, letterSpacing:1.5,
      textTransform:'uppercase', fontSize:10, borderRadius:2,
      padding:'10px 18px', opacity:disabled?0.35:1,
      width:full?'100%':undefined, transition:'opacity 0.15s', whiteSpace:'nowrap',
    }}>{ch}</button>
  );
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
    <div style={{ display:'flex',alignItems:'center',gap:10 }}>
      {src&&<audio ref={ref} src={src} />}
      <button onClick={toggle} disabled={!src} style={{ width:32,height:32,borderRadius:'50%',background:src?S.accent:S.border,border:'none',cursor:src?'pointer':'not-allowed',fontSize:12,color:src?'#080808':S.muted,flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center' }}>{playing?'⏸':'▶'}</button>
      <div style={{ flex:1,height:2,background:S.border,borderRadius:1,overflow:'hidden' }}>
        <div style={{ width:`${prog}%`,height:'100%',background:S.accent,transition:'width 0.1s' }} />
      </div>
      <span style={{ fontSize:9,color:S.muted,letterSpacing:1,whiteSpace:'nowrap' }}>{src?'SNIPPET':'NO PREVIEW'}</span>
    </div>
  );
}

// ── SHOP COMPONENTS ────────────────────────────────────────────
function RecordCard({ r, onOpen, onAdd }) {
  const [hov, setHov] = useState(false);
  return (
    <div onMouseEnter={()=>setHov(true)} onMouseLeave={()=>setHov(false)} style={{ background:S.surf,border:`1px solid ${hov?'#2e2e2e':S.border}`,borderRadius:3,overflow:'hidden',transition:'border 0.15s, transform 0.15s',transform:hov?'translateY(-2px)':'none' }}>
      <div style={{ position:'relative',paddingBottom:'100%',cursor:'pointer' }} onClick={()=>onOpen(r)}>
        <div style={{ position:'absolute',inset:0,background:`linear-gradient(${r.g})`,backgroundImage:coverSrc(r.coverUrl)?`url(${coverSrc(r.coverUrl)})`:'none',backgroundSize:'cover',backgroundPosition:'center' }}>
          <div style={{ position:'absolute',bottom:0,left:0,right:0,padding:'4px 8px',background:'rgba(0,0,0,0.5)',fontFamily:'monospace',fontSize:7,color:'rgba(255,255,255,0.35)',letterSpacing:2 }}>{r.catalog}</div>
          {hov&&<div style={{ position:'absolute',inset:0,background:'rgba(0,0,0,0.55)',display:'flex',alignItems:'center',justifyContent:'center',backdropFilter:'blur(2px)' }}><span style={{ color:S.text,fontSize:10,letterSpacing:2,fontWeight:700,textTransform:'uppercase' }}>View Details</span></div>}
        </div>
      </div>
      <div style={{ padding:'12px 12px 14px' }}>
        <div style={{ fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase',marginBottom:3 }}>{r.label}</div>
        <div style={{ fontSize:13,fontWeight:700,color:S.text,lineHeight:1.3,marginBottom:2 }}>{r.title}</div>
        <div style={{ fontSize:11,color:S.muted,marginBottom:10 }}>{r.artist||r.vendor||''}</div>
        <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between' }}>
          <span style={{ fontSize:15,fontWeight:800,color:S.accent }}>€{r.price.toFixed(2)}</span>
          <button onClick={e=>{e.stopPropagation();onAdd(r);}} disabled={r.stock===0} style={{ background:hov&&r.stock>0?S.accent:S.border,color:hov&&r.stock>0?'#080808':S.muted,border:'none',borderRadius:2,cursor:r.stock===0?'not-allowed':'pointer',fontSize:9,fontWeight:700,letterSpacing:1.5,padding:'5px 10px',textTransform:'uppercase',transition:'all 0.15s',opacity:r.stock===0?0.4:1 }}>{r.stock===0?'Sold Out':'+ Cart'}</button>
        </div>
        {r.stock>0&&r.stock<=3&&<div style={{ fontSize:8,color:'#ff8800',marginTop:5,letterSpacing:1,textTransform:'uppercase' }}>Only {r.stock} left</div>}
        {r.stock===0&&<div style={{ fontSize:8,color:S.danger,marginTop:5,letterSpacing:1,textTransform:'uppercase' }}>Out of stock</div>}
      </div>
    </div>
  );
}

function Modal({ r, onClose, onAdd }) {
  if (!r) return null;
  return (
    <div onClick={onClose} style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.88)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000,padding:20,backdropFilter:'blur(4px)' }}>
      <div onClick={e=>e.stopPropagation()} style={{ background:S.surf,border:`1px solid ${S.border}`,borderRadius:4,maxWidth:680,width:'100%',maxHeight:'90vh',overflow:'auto' }}>
        <div style={{ display:'flex',flexWrap:'wrap' }}>
      <div style={{ width:240,minHeight:240,flexShrink:0,background:`linear-gradient(${r.g})`,backgroundImage:coverSrc(r.coverUrl)?`url(${coverSrc(r.coverUrl)})`:'none',backgroundSize:'cover',backgroundPosition:'center' }} />
          <div style={{ flex:1,minWidth:220,padding:'28px 26px 24px' }}>
            <button onClick={onClose} style={{ float:'right',background:'none',border:'none',color:S.muted,cursor:'pointer',fontSize:20,lineHeight:1,marginTop:-4 }}>×</button>
            <div style={{ fontSize:9,color:S.muted,letterSpacing:2,textTransform:'uppercase',marginBottom:4 }}>{r.label} · {r.catalog}</div>
            <h2 style={{ margin:'0 0 4px',fontSize:18,fontWeight:800,color:S.text,lineHeight:1.2 }}>{r.title}</h2>
            <div style={{ fontSize:12,color:S.muted,marginBottom:12 }}>{r.artist}</div>
            <div style={{ display:'flex',gap:6,marginBottom:14,flexWrap:'wrap' }}>
              {[r.genre,r.year].map(v=><span key={v} style={{ fontSize:9,fontWeight:700,letterSpacing:1,padding:'2px 8px',borderRadius:2,background:S.border,color:S.muted,textTransform:'uppercase' }}>{v}</span>)}
            </div>
            <p style={{ fontSize:11,color:S.muted,lineHeight:1.75,marginBottom:16 }}>{r.desc}</p>
            <div style={{ marginBottom:14 }}>
              {r.tracks.map((t,i)=>(
                <div key={i} style={{ display:'flex',justifyContent:'space-between',padding:'5px 0',borderBottom:`1px solid ${S.border}`,fontSize:11,color:S.muted }}>
                  <span>{String.fromCharCode(65+i)}. {t.t}</span>
                  <span style={{ fontFamily:'monospace' }}>{t.d}</span>
                </div>
              ))}
            </div>
            <AudioPlayer src={r.audio} />
            <div style={{ marginTop:20,display:'flex',alignItems:'center',gap:14 }}>
              <span style={{ fontSize:22,fontWeight:800,color:S.accent }}>€{r.price.toFixed(2)}</span>
              <Btn ch={r.stock===0?'Out of Stock':'Add to Cart'} disabled={r.stock===0} onClick={()=>{onAdd(r);onClose();}} full />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CartDrawer({ cart, open, onClose, onRemove }) {
  const total = cart.reduce((s,i)=>s+i.price*i.qty,0);
  const count = cart.reduce((s,i)=>s+i.qty,0);
  return (
    <>
      {open&&<div onClick={onClose} style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.5)',zIndex:900 }} />}
      <div style={{ position:'fixed',top:0,right:0,bottom:0,width:340,background:S.surf,borderLeft:`1px solid ${S.border}`,zIndex:1000,transform:open?'translateX(0)':'translateX(100%)',transition:'transform 0.25s ease',display:'flex',flexDirection:'column' }}>
        <div style={{ padding:'18px 22px',borderBottom:`1px solid ${S.border}`,display:'flex',justifyContent:'space-between',alignItems:'center' }}>
          <span style={{ fontWeight:800,fontSize:11,letterSpacing:2,textTransform:'uppercase' }}>Cart ({count})</span>
          <button onClick={onClose} style={{ background:'none',border:'none',color:S.muted,cursor:'pointer',fontSize:20 }}>×</button>
        </div>
        <div style={{ flex:1,overflowY:'auto',padding:'16px 22px' }}>
          {cart.length===0?<div style={{ textAlign:'center',color:S.muted,fontSize:12,marginTop:60 }}>Your cart is empty</div>:
            cart.map(item=>(
              <div key={item.id} style={{ display:'flex',gap:10,marginBottom:14,paddingBottom:14,borderBottom:`1px solid ${S.border}` }}>
                <div style={{ width:48,height:48,borderRadius:2,background:`linear-gradient(${item.g})`,backgroundImage:coverSrc(item.coverUrl)?`url(${coverSrc(item.coverUrl)})`:'none',backgroundSize:'cover',flexShrink:0 }} />
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:12,fontWeight:700,color:S.text }}>{item.title}</div>
                  <div style={{ fontSize:10,color:S.muted }}>{item.artist}</div>
                  <div style={{ fontSize:11,color:S.accent,marginTop:2 }}>€{item.price.toFixed(2)} × {item.qty}</div>
                </div>
                <button onClick={()=>onRemove(item.id)} style={{ background:'none',border:'none',color:S.muted,cursor:'pointer',fontSize:16,alignSelf:'flex-start' }}>×</button>
              </div>
            ))
          }
        </div>
        {cart.length>0&&(
          <div style={{ padding:'16px 22px',borderTop:`1px solid ${S.border}` }}>
            <div style={{ display:'flex',justifyContent:'space-between',marginBottom:14 }}>
              <span style={{ fontSize:10,color:S.muted,textTransform:'uppercase',letterSpacing:1 }}>Total</span>
              <span style={{ fontSize:20,fontWeight:800,color:S.accent }}>€{total.toFixed(2)}</span>
            </div>
            <Btn ch="Checkout via Shopify" onClick={async()=>{
              try { await shopifyCheckout(cart); }
              catch(e) { alert(e.message); }
            }} full />
            <div style={{ fontSize:8,color:S.muted,textAlign:'center',marginTop:8,letterSpacing:1.5 }}>CARD · PAYPAL · CRYPTO</div>
          </div>
        )}
      </div>
    </>
  );
}

function Filters({ filters, onChange, records }) {
  const labels = [...new Set(records.map(r=>r.label))].sort();
  const genres = [...new Set(records.map(r=>r.genre))].sort();
  const years  = [...new Set(records.map(r=>r.year))].sort((a,b)=>b-a);
  const months = [...new Set(records.map(r=>r.month))].sort((a,b)=>a-b);
  const MN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const pill = (key,val,label) => {
    const active = filters[key]===val;
    return <button key={String(val)} onClick={()=>onChange(key,active?null:val)} style={{ background:active?S.accent:S.border,color:active?'#080808':S.muted,border:'none',borderRadius:20,cursor:'pointer',fontSize:9,fontWeight:active?700:400,letterSpacing:1.5,padding:'4px 12px',textTransform:'uppercase',transition:'all 0.15s',whiteSpace:'nowrap' }}>{label||val}</button>;
  };

  const dropdown = (key, opts, placeholder) => (
    <select value={filters[key]||''} onChange={e=>onChange(key,e.target.value||null)} style={{ background:filters[key]?S.accent:S.surf,color:filters[key]?'#080808':S.muted,border:`1px solid ${filters[key]?S.accent:S.border}`,borderRadius:2,cursor:'pointer',fontSize:9,fontWeight:filters[key]?700:400,letterSpacing:1.5,padding:'4px 12px',textTransform:'uppercase',fontFamily:'inherit',outline:'none',appearance:'none',paddingRight:24,backgroundImage:`url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='${filters[key]?'%23080808':'%23585858'}'/%3E%3C/svg%3E")`,backgroundRepeat:'no-repeat',backgroundPosition:'right 8px center',transition:'all 0.15s' }}>
      <option value="">{placeholder}</option>
      {opts.map(o=><option key={o.val} value={o.val}>{o.label}</option>)}
    </select>
  );

  return (
    <div style={{ marginBottom:28,display:'flex',flexWrap:'wrap',gap:12,alignItems:'center' }}>
      {dropdown('genre', genres.map(g=>({val:g,label:g})), 'All Genres')}
      {dropdown('label', labels.map(l=>({val:l,label:l})), 'All Labels')}
      <div style={{ display:'flex',gap:5,alignItems:'center',flexWrap:'wrap' }}>
        {pill('year',null,'All')}{years.map(y=>pill('year',y,y))}
      </div>
      <div style={{ display:'flex',gap:5,alignItems:'center',flexWrap:'wrap' }}>
        {pill('month',null,'All')}{months.map(m=>pill('month',m,MN[m-1]))}
      </div>
    </div>
  );
}

// Proxy cover images that may have CORS restrictions
function coverSrc(url) {
  if (!url) return null;
  if (url.includes('discogs.com')) return `https://images.weserv.nl/?url=${encodeURIComponent(url)}&w=300&output=jpg`;
  return url;
}
function extractJSON(txt) {
  const si = txt.indexOf('[') === -1 ? txt.indexOf('{') :
             txt.indexOf('{') === -1 ? txt.indexOf('[') :
             Math.min(txt.indexOf('['), txt.indexOf('{'));
  if (si === -1) throw new Error('No JSON found in response');
  const open = txt[si], close = open === '[' ? ']' : '}';
  let depth = 0, inStr = false, esc = false;
  for (let i = si; i < txt.length; i++) {
    const c = txt[i];
    if (esc)              { esc = false; continue; }
    if (c==='\\' && inStr){ esc = true;  continue; }
    if (c==='"')          { inStr = !inStr; continue; }
    if (inStr)            continue;
    if (c===open)  depth++;
    if (c===close) { depth--; if (depth===0) return JSON.parse(txt.slice(si,i+1)); }
  }
  throw new Error('Malformed JSON in response');
}

// ── CLAUDE API HELPER ──────────────────────────────────────────
async function claudeJSON(systemPrompt, userMsg, useSearch=false) {
  const body = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 3000,
    system: systemPrompt,
    messages: [{ role:"user", content:userMsg }],
  };
  if (useSearch) body.tools = [{ type:"web_search_20250305", name:"web_search" }];
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message);
  const txt = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
  return extractJSON(txt);
}

const RECORD_SCHEMA = `{"title":"","artist":"","label":"","genre":"","year":0,"price":18.99,"catalog":"","tracks":[{"t":"","d":""}],"desc":"","coverUrl":"","audioUrl":""}`;
const GENRES = 'Deep House, Tech House, Afro House, Chicago House, Soulful House, Acid House';

// ── BULK IMPORTER ──────────────────────────────────────────────
function BulkImporter({ onImportMany }) {
  const [query, setQuery]       = useState('');
  const [status, setStatus]     = useState('idle');
  const [enriching, setEnriching] = useState(false);
  const [results, setResults]   = useState([]);
  const [selected, setSelected] = useState({});
  const [errMsg, setErrMsg]   = useState('');
  const [addedCount, setAddedCount] = useState(0);

  const SUGGESTIONS = ['Quintessentials','Defected','Nervous Records','Trax Records','KDJ','Running Back','Kompakt','Larry Heard'];

  const search = async () => {
    if (!query.trim()) return;
    setStatus('loading'); setResults([]); setSelected({}); setErrMsg(''); setAddedCount(0);
    setEnriching(false);
    try {
      const list = await claudeJSON(
        `You are a vinyl record data extractor. Do MAX 2 web searches, return results fast.
Search: "${query}" discogs vinyl releases
Extract up to 8 real releases from the results. Do NOT invent data.
Return ONLY one single JSON array, nothing else before or after it:
[${RECORD_SCHEMA}]

For coverUrl: Search for the record on Google Images or find a publicly accessible image.
Try these sources in order:
1. https://www.beatport.com - they show cover art freely
2. https://www.juno.co.uk - cover images load publicly  
3. Google image search for "[artist] [title] vinyl cover"
Return a direct .jpg or .png URL that is publicly accessible (NOT from i.discogs.com as those are blocked).

For audioUrl: look for .mp3 preview on beatport.com or soundcloud.com for the track.
genre: one of ${GENRES}. price: 18.99 default.`,
        `Find real vinyl releases for: "${query}". For each find a publicly loadable cover image URL (not discogs CDN). Return ONE JSON array only.`,
        true
      );
      const arr = Array.isArray(list) ? list : [list];
      if (!arr.length) throw new Error('No releases found.');
      setResults(arr);
      const sel = {};
      arr.forEach((_,i) => sel[i] = true);
      setSelected(sel);
      setStatus('done');
    } catch(e) {
      setErrMsg(e.message || 'Unknown error');
      setStatus('error');
    }
  };

  const toggleAll = () => {
    const allOn = results.every((_,i)=>selected[i]);
    const next = {};
    if (!allOn) results.forEach((_,i)=>next[i]=true);
    setSelected(next);
  };

  const add = () => {
    const toAdd = results
      .filter((_,i)=>selected[i])
      .map(r=>({ id:Date.now()+Math.random(), ...r, audio:r.audioUrl||null, month:new Date().getMonth()+1, stock:10, g:'135deg,#1a1a2e,#16213e' }));
    onImportMany(toAdd);
    setAddedCount(toAdd.length);
    setResults([]); setSelected({}); setQuery(''); setStatus('idle');
  };

  const selCount = Object.values(selected).filter(Boolean).length;

  return (
    <div>
      <p style={{ fontSize:10,color:S.muted,margin:'0 0 12px' }}>Search by label or artist. The AI lists all known vinyl releases — pick which to add.</p>
      <div style={{ display:'flex',gap:8,marginBottom:10 }}>
        <input
          value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>e.key==='Enter'&&search()}
          placeholder='e.g. "Quintessentials", "Defected", "Larry Heard"…'
          style={{ flex:1,background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'8px 12px',fontSize:11,fontFamily:'inherit',outline:'none' }}
        />
        <Btn ch={status==='loading'?'Searching…':'Search'} onClick={search} disabled={status==='loading'||!query.trim()} />
      </div>

      {status==='idle'&&!addedCount&&(
        <div style={{ display:'flex',flexWrap:'wrap',gap:5 }}>
          {SUGGESTIONS.map(s=><button key={s} onClick={()=>setQuery(s)} style={{ background:S.border,color:S.muted,border:'none',borderRadius:20,cursor:'pointer',fontSize:9,letterSpacing:1,padding:'3px 10px',textTransform:'uppercase' }}>{s}</button>)}
        </div>
      )}

      {status==='loading'&&(
        <div style={{ marginTop:12,padding:14,background:S.bg,borderRadius:2,border:`1px solid ${S.border}` }}>
          <div style={{ fontSize:10,color:S.muted,marginBottom:8 }}>Searching for "{query}"…</div>
          <div style={{ height:2,background:S.border,borderRadius:1,overflow:'hidden' }}>
            <div style={{ height:'100%',background:S.accent,animation:'kf 1.2s ease-in-out infinite' }} />
          </div>
          <style>{`@keyframes kf{0%,100%{opacity:.4;width:20%}50%{opacity:1;width:85%}}`}</style>
        </div>
      )}

      {status==='error'&&(
        <div style={{ marginTop:10,padding:12,background:'#1a0000',border:`1px solid ${S.danger}33`,borderRadius:2 }}>
          <div style={{ fontSize:10,color:S.danger,fontWeight:700,marginBottom:4 }}>Search failed</div>
          <div style={{ fontSize:10,color:'#ff8080' }}>{errMsg}</div>
        </div>
      )}

      {addedCount>0&&status==='idle'&&(
        <div style={{ marginTop:10,fontSize:11,color:S.accent }}>✓ {addedCount} record{addedCount!==1?'s':''} added to your store.</div>
      )}

      {status==='done'&&results.length>0&&(
        <div style={{ marginTop:14 }}>
          <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10,flexWrap:'wrap',gap:8 }}>
            <div>
              <span style={{ fontSize:10,color:S.muted }}>
                Found <b style={{ color:S.text }}>{results.length}</b> releases · <b style={{ color:S.accent }}>{selCount}</b> selected
              </span>
              {enriching && <span style={{ fontSize:9,color:S.muted,marginLeft:10,letterSpacing:1 }}>⟳ Fetching cover art &amp; audio…</span>}
            </div>
            <div style={{ display:'flex',gap:6 }}>
              <button onClick={toggleAll} style={{ background:'none',border:`1px solid ${S.border}`,color:S.muted,cursor:'pointer',fontSize:9,letterSpacing:1.5,textTransform:'uppercase',padding:'4px 10px',borderRadius:2 }}>
                {results.every((_,i)=>selected[i])?'Deselect All':'Select All'}
              </button>
              <Btn ch={`Add ${selCount} to Store`} onClick={add} disabled={!selCount} />
            </div>
          </div>
          <div style={{ display:'flex',flexDirection:'column',gap:1,maxHeight:380,overflowY:'auto',borderRadius:2,border:`1px solid ${S.border}` }}>
            {results.map((r,i)=>(
              <label key={i} style={{ display:'flex',alignItems:'center',gap:12,padding:'10px 14px',background:selected[i]?'#141400':S.surf,cursor:'pointer' }}>
                <input type="checkbox" checked={!!selected[i]} onChange={()=>setSelected(s=>({...s,[i]:!s[i]}))} style={{ accentColor:S.accent,width:14,height:14,flexShrink:0,cursor:'pointer' }} />
                <div style={{ width:40,height:40,borderRadius:2,flexShrink:0,position:'relative',overflow:'hidden' }}>
                  {coverSrc(r.coverUrl)
                    ? <img src={coverSrc(r.coverUrl)} alt="" style={{ width:'100%',height:'100%',objectFit:'cover' }} onError={e=>e.target.style.display='none'} />
                    : <div style={{ width:'100%',height:'100%',background:'linear-gradient(135deg,#1a1a2e,#16213e)',display:'flex',alignItems:'center',justifyContent:'center' }}>
                        {enriching && <span style={{ fontSize:8,color:S.muted }}>⟳</span>}
                      </div>
                  }
                  {r.audioUrl && <div style={{ position:'absolute',bottom:1,right:1,fontSize:7,background:S.accent,color:'#080808',padding:'1px 3px',borderRadius:1,fontWeight:700,letterSpacing:0.5 }}>▶</div>}
                </div>
                <div style={{ flex:1,minWidth:0 }}>
                  <div style={{ fontSize:12,fontWeight:700,color:selected[i]?S.text:S.muted,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{r.title}{r.artist?` — ${r.artist}`:''}</div>
                  <div style={{ fontSize:9,color:S.muted,marginTop:1 }}>{r.label} · {r.catalog} · {r.year||'—'}</div>
                </div>
                <span style={{ fontSize:11,fontWeight:700,color:selected[i]?S.accent:S.muted,flexShrink:0 }}>€{Number(r.price||18.99).toFixed(2)}</span>
              </label>
            ))}
          </div>
          <p style={{ fontSize:9,color:S.muted,marginTop:8 }}>💡 Prices default to €18.99 — edit in inventory after importing.</p>
        </div>
      )}
    </div>
  );
}

// ── URL IMPORTER ───────────────────────────────────────────────
function UrlImporter({ onImport }) {
  const [url, setUrl]       = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr]       = useState('');

  const run = async () => {
    if (!url.trim()) return;
    setLoading(true); setErr(''); setResult(null);
    try {
      const r = await claudeJSON(
        `Extract vinyl record data from a URL. Return ONLY a JSON object: ${RECORD_SCHEMA}. genre: ${GENRES}. audioUrl: look for .mp3/.ogg preview URLs.`,
        `Extract record data from: ${url}`,
        true
      );
      setResult(r);
    } catch(e) { setErr(e.message); }
    setLoading(false);
  };

  const confirm = () => {
    onImport({ id:Date.now(),...result, audio:result.audioUrl||null, month:new Date().getMonth()+1, stock:10, g:'135deg,#1a1a2e,#16213e' });
    setResult(null); setUrl('');
  };

  return (
    <div>
      <div style={{ display:'flex',gap:8 }}>
        <input value={url} onChange={e=>setUrl(e.target.value)} onKeyDown={e=>e.key==='Enter'&&run()}
          placeholder="Paste product URL from wordandsound.net…"
          style={{ flex:1,background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'8px 12px',fontSize:11,fontFamily:'inherit',outline:'none' }}
        />
        <Btn ch={loading?'…':'Import'} onClick={run} disabled={loading||!url.trim()} />
      </div>
      {err&&<div style={{ fontSize:10,color:S.danger,marginTop:8 }}>{err}</div>}
      {result&&(
        <div style={{ marginTop:12,padding:14,background:S.bg,borderRadius:2 }}>
          <div style={{ fontSize:13,fontWeight:700,color:S.text }}>{result.title} — {result.artist}</div>
          <div style={{ fontSize:10,color:S.muted,marginTop:3 }}>{result.label} · {result.catalog} · {result.year}</div>
          {result.coverUrl&&<img src={result.coverUrl} alt="" style={{ width:60,height:60,objectFit:'cover',borderRadius:2,marginTop:8 }} />}
          <div style={{ marginTop:10,display:'flex',gap:8 }}>
            <Btn ch="Add to Store" onClick={confirm} />
            <Btn ch="Discard" variant="ghost" onClick={()=>setResult(null)} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── BARCODE IMPORTER ───────────────────────────────────────────
function BarcodeImporter({ onImport }) {
  const [barcode, setBarcode] = useState('');
  const [cameraOn, setCameraOn] = useState(false);
  const [loading, setLoading]   = useState(false);
  const [result, setResult]     = useState(null);
  const [err, setErr]           = useState('');
  const [camErr, setCamErr]     = useState('');
  const videoRef  = useRef(null);
  const streamRef = useRef(null);
  const activeRef = useRef(false);

  const lookup = async (code) => {
    setLoading(true); setErr(''); setResult(null);
    try {
      const r = await claudeJSON(
        `Find vinyl record by barcode/EAN/UPC on Discogs or MusicBrainz. Return ONLY JSON: ${RECORD_SCHEMA}. genre: ${GENRES}. audioUrl: any preview URL found.`,
        `Find vinyl record with barcode: ${code}`,
        true
      );
      setResult({...r, barcode:code});
    } catch(e) { setErr(e.message); }
    setLoading(false);
  };

  const startCamera = async () => {
    setCamErr('');
    if (!('BarcodeDetector' in window)) { setCamErr('Camera scanning needs Chrome/Edge/Safari 17+. Use USB scanner or type barcode manually.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment' } });
      streamRef.current = stream; setCameraOn(true); activeRef.current = true;
      setTimeout(async () => {
        if (!videoRef.current) return;
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(()=>{});
        const det = new window.BarcodeDetector({ formats:['ean_13','ean_8','upc_a','upc_e','code_128'] });
        const scan = async () => {
          if (!activeRef.current) return;
          try {
            const codes = await det.detect(videoRef.current);
            if (codes.length) { stopCamera(); setBarcode(codes[0].rawValue); lookup(codes[0].rawValue); return; }
          } catch {}
          requestAnimationFrame(scan);
        };
        requestAnimationFrame(scan);
      }, 300);
    } catch { setCamErr('Could not access camera. Check permissions.'); }
  };

  const stopCamera = () => {
    activeRef.current = false; setCameraOn(false);
    if (streamRef.current) { streamRef.current.getTracks().forEach(t=>t.stop()); streamRef.current = null; }
  };

  useEffect(()=>()=>stopCamera(),[]);

  const confirm = () => {
    onImport({ id:Date.now(),...result, audio:result.audioUrl||null, month:new Date().getMonth()+1, stock:10, g:'135deg,#1a1a2e,#16213e' });
    setResult(null); setBarcode('');
  };

  return (
    <div>
      <div style={{ display:'flex',gap:8,marginBottom:camErr?8:0 }}>
        <div style={{ position:'relative',flex:1 }}>
          <span style={{ position:'absolute',left:10,top:'50%',transform:'translateY(-50%)',color:S.muted,pointerEvents:'none' }}>▥</span>
          <input value={barcode} onChange={e=>setBarcode(e.target.value)} onKeyDown={e=>e.key==='Enter'&&barcode.trim()&&lookup(barcode.trim())}
            placeholder="Scan with USB scanner or type EAN/UPC…"
            style={{ width:'100%',background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'8px 12px 8px 28px',fontSize:11,fontFamily:'inherit',outline:'none',boxSizing:'border-box' }}
          />
        </div>
        <Btn ch={loading?'…':'Lookup'} onClick={()=>barcode.trim()&&lookup(barcode.trim())} disabled={loading||!barcode.trim()} />
        <Btn ch="📷" variant="ghost" onClick={cameraOn?stopCamera:startCamera} />
      </div>
      {cameraOn&&(
        <div style={{ marginTop:10,position:'relative',borderRadius:3,overflow:'hidden',border:`1px solid ${S.border}` }}>
          <video ref={videoRef} style={{ width:'100%',maxHeight:220,objectFit:'cover',display:'block' }} muted playsInline />
          <div style={{ position:'absolute',inset:0,pointerEvents:'none' }}>
            <div style={{ position:'absolute',left:'10%',right:'10%',top:'50%',height:2,background:`${S.accent}88`,boxShadow:`0 0 8px ${S.accent}`,animation:'scan 1.6s ease-in-out infinite' }} />
          </div>
          <div style={{ position:'absolute',bottom:0,left:0,right:0,padding:'8px 12px',background:'rgba(0,0,0,0.7)',display:'flex',justifyContent:'space-between',alignItems:'center' }}>
            <span style={{ fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase' }}>Scanning…</span>
            <button onClick={stopCamera} style={{ background:'none',border:`1px solid ${S.border}`,color:S.muted,cursor:'pointer',fontSize:9,letterSpacing:1.5,textTransform:'uppercase',padding:'3px 8px',borderRadius:2 }}>Cancel</button>
          </div>
          <style>{`@keyframes scan{0%,100%{top:25%}50%{top:70%}}`}</style>
        </div>
      )}
      {camErr&&<div style={{ fontSize:10,color:S.danger,marginTop:6 }}>{camErr}</div>}
      <div style={{ marginTop:6,fontSize:9,color:S.muted }}>💡 USB scanner? Click the input and scan — it types automatically.</div>
      {err&&<div style={{ fontSize:10,color:S.danger,marginTop:8 }}>{err}</div>}
      {loading&&<div style={{ fontSize:10,color:S.muted,marginTop:8 }}>Looking up barcode on Discogs…</div>}
      {result&&(
        <div style={{ marginTop:12,padding:14,background:S.bg,borderRadius:2 }}>
          <div style={{ fontSize:13,fontWeight:700,color:S.text }}>{result.title} — {result.artist}</div>
          <div style={{ fontSize:10,color:S.muted,marginTop:3 }}>{result.label} · {result.catalog} · {result.year}</div>
          {result.coverUrl&&<img src={result.coverUrl} alt="" style={{ width:60,height:60,objectFit:'cover',borderRadius:2,marginTop:8 }} onError={e=>e.target.style.display='none'} />}
          <div style={{ marginTop:10,display:'flex',gap:8 }}>
            <Btn ch="Add to Store" onClick={confirm} />
            <Btn ch="Discard" variant="ghost" onClick={()=>setResult(null)} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── AUDIO FILE STORE (catalog# → objectURL) ───────────────────
const audioStore = {};

function AudioBatchUploader({ records, onMatch }) {
  const [matches, setMatches] = useState([]);
  const [unmatched, setUnmatched] = useState([]);
  const inputRef = useRef(null);

  const handleFiles = (files) => {
    const matched = [], unmat = [];
    const updates = {};

    Array.from(files).forEach(file => {
      if (!/\.(mp3|ogg|wav|flac|aac)$/i.test(file.name)) return;
      const base = file.name.replace(/\.[^.]+$/, '').trim().toLowerCase();
      const record = records.find(r =>
        r.catalog?.toLowerCase().replace(/\s/g,'') === base.replace(/\s/g,'') ||
        r.catalog?.toLowerCase() === base
      );
      const url = URL.createObjectURL(file);
      if (record) {
        audioStore[record.id] = url;
        updates[record.id] = url;
        matched.push({ file: file.name, title: record.title, catalog: record.catalog });
      } else {
        unmat.push(file.name);
      }
    });

    setMatches(matched);
    setUnmatched(unmat);
    onMatch(updates);
  };

  const [drag, setDrag] = useState(false);

  return (
    <div style={{ marginBottom:28 }}>
      <div style={{ fontSize:9,color:S.muted,letterSpacing:2,textTransform:'uppercase',marginBottom:10 }}>
        Batch Audio Upload
      </div>

      {/* Drop zone */}
      <div
        onDragOver={e=>{e.preventDefault();setDrag(true);}}
        onDragLeave={()=>setDrag(false)}
        onDrop={e=>{e.preventDefault();setDrag(false);handleFiles(e.dataTransfer.files);}}
        onClick={()=>inputRef.current.click()}
        style={{
          border:`2px dashed ${drag?S.accent:S.border}`,
          borderRadius:3, padding:'28px 20px', textAlign:'center',
          cursor:'pointer', transition:'border 0.15s, background 0.15s',
          background:drag?'#141400':'transparent',
        }}
      >
        <div style={{ fontSize:24, marginBottom:8 }}>🎵</div>
        <div style={{ fontSize:11, color:drag?S.accent:S.muted, fontWeight:700, letterSpacing:1, textTransform:'uppercase' }}>
          {drag ? 'Drop to upload' : 'Drag audio files here or click to browse'}
        </div>
        <div style={{ fontSize:9, color:S.muted, marginTop:6 }}>
          Name files after catalog numbers — e.g. <span style={{ color:S.text, fontFamily:'monospace' }}>QTN001.mp3</span>, <span style={{ color:S.text, fontFamily:'monospace' }}>IIWII005.mp3</span>
        </div>
        <div style={{ fontSize:9, color:S.muted, marginTop:2 }}>
          Supports mp3 · ogg · wav · flac · aac
        </div>
        <input ref={inputRef} type="file" multiple accept=".mp3,.ogg,.wav,.flac,.aac" style={{ display:'none' }}
          onChange={e=>handleFiles(e.target.files)} />
      </div>

      {/* Results */}
      {matches.length > 0 && (
        <div style={{ marginTop:12 }}>
          <div style={{ fontSize:9,color:S.accent,letterSpacing:1,textTransform:'uppercase',marginBottom:6 }}>
            ✓ {matches.length} matched
          </div>
          {matches.map((m,i)=>(
            <div key={i} style={{ display:'flex',gap:8,fontSize:10,color:S.muted,marginBottom:3,alignItems:'center' }}>
              <span style={{ color:S.accent }}>▶</span>
              <span style={{ fontFamily:'monospace',color:S.text }}>{m.catalog}</span>
              <span>→</span>
              <span>{m.title}</span>
            </div>
          ))}
        </div>
      )}

      {unmatched.length > 0 && (
        <div style={{ marginTop:10 }}>
          <div style={{ fontSize:9,color:'#ff8800',letterSpacing:1,textTransform:'uppercase',marginBottom:6 }}>
            ⚠ {unmatched.length} unmatched — no record with this catalog number found
          </div>
          {unmatched.map((f,i)=>(
            <div key={i} style={{ fontSize:10,color:S.muted,fontFamily:'monospace',marginBottom:2 }}>{f}</div>
          ))}
        </div>
      )}
    </div>
  );
}
const GENRE_OPTS = ['Deep House','Tech House','Afro House','Chicago House','Soulful House','Acid House'];

function EditModal({ record, onSave, onClose }) {
  const [f, setF] = useState({ ...record });
  const set = (k,v) => setF(p=>({...p,[k]:v}));

  const inp = (label, key, type='text', opts=null) => (
    <div style={{ marginBottom:14 }}>
      <div style={{ fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase',marginBottom:5 }}>{label}</div>
      {opts ? (
        <select value={f[key]||''} onChange={e=>set(key,e.target.value)} style={{ width:'100%',background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'8px 10px',fontSize:12,fontFamily:'inherit',outline:'none' }}>
          {opts.map(o=><option key={o} value={o}>{o}</option>)}
        </select>
      ) : type==='textarea' ? (
        <textarea value={f[key]||''} onChange={e=>set(key,e.target.value)} rows={3} style={{ width:'100%',background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'8px 10px',fontSize:12,fontFamily:'inherit',outline:'none',resize:'vertical',boxSizing:'border-box' }} />
      ) : (
        <input type={type} value={f[key]||''} onChange={e=>set(key, type==='number'?parseFloat(e.target.value)||0 : e.target.value)}
          style={{ width:'100%',background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'8px 10px',fontSize:12,fontFamily:'inherit',outline:'none',boxSizing:'border-box' }} />
      )}
    </div>
  );

  return (
    <div onClick={onClose} style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.88)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:2000,padding:20,backdropFilter:'blur(4px)' }}>
      <div onClick={e=>e.stopPropagation()} style={{ background:S.surf,border:`1px solid ${S.border}`,borderRadius:4,width:'100%',maxWidth:580,maxHeight:'90vh',overflow:'auto' }}>
        {/* Header */}
        <div style={{ padding:'20px 24px 0',display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20 }}>
          <div style={{ fontSize:11,fontWeight:800,letterSpacing:2,textTransform:'uppercase' }}>Edit Release</div>
          <button onClick={onClose} style={{ background:'none',border:'none',color:S.muted,cursor:'pointer',fontSize:20 }}>×</button>
        </div>

        <div style={{ padding:'0 24px 24px' }}>
          {/* Cover preview + URL */}
          <div style={{ display:'flex',gap:14,marginBottom:20,alignItems:'flex-start' }}>
            <div style={{ width:80,height:80,borderRadius:2,flexShrink:0,background:`linear-gradient(${f.g})`,backgroundImage:coverSrc(f.coverUrl)?`url(${coverSrc(f.coverUrl)})`:'none',backgroundSize:'cover',backgroundPosition:'center' }} />
            <div style={{ flex:1 }}>
              <div style={{ fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase',marginBottom:5 }}>Cover Image URL</div>
              <input value={f.coverUrl||''} onChange={e=>set('coverUrl',e.target.value)} placeholder="https://… paste any public image URL"
                style={{ width:'100%',background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'8px 10px',fontSize:11,fontFamily:'inherit',outline:'none',boxSizing:'border-box' }} />
              <div style={{ fontSize:9,color:S.muted,marginTop:5 }}>Paste a .jpg/.png URL — the preview updates live</div>
            </div>
          </div>

          {/* Two columns */}
          <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 16px' }}>
            <div>{inp('Title','title')}</div>
            <div>{inp('Artist','artist')}</div>
            <div>{inp('Label','label')}</div>
            <div>{inp('Catalog #','catalog')}</div>
            <div>{inp('Genre','genre','text',GENRE_OPTS)}</div>
            <div>{inp('Year','year','number')}</div>
            <div>{inp('Price (€)','price','number')}</div>
            <div>{inp('Stock','stock','number')}</div>
          </div>

          {inp('Description','desc','textarea')}

          {/* Audio */}
          <div style={{ marginBottom:20 }}>
            <div style={{ fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase',marginBottom:5 }}>Audio Snippet URL (.mp3 / .ogg)</div>
            <input value={f.audio||''} onChange={e=>set('audio',e.target.value)} placeholder="https://… direct link to audio preview"
              style={{ width:'100%',background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'8px 10px',fontSize:11,fontFamily:'inherit',outline:'none',boxSizing:'border-box' }} />
            {f.audio && <AudioPlayer src={f.audio} />}
          </div>

          {/* Tracks */}
          <div style={{ marginBottom:20 }}>
            <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8 }}>
              <div style={{ fontSize:9,color:S.muted,letterSpacing:1.5,textTransform:'uppercase' }}>Tracklist</div>
              <button onClick={()=>set('tracks',[...(f.tracks||[]),{t:'',d:''}])} style={{ background:S.border,border:'none',color:S.muted,cursor:'pointer',fontSize:9,letterSpacing:1,textTransform:'uppercase',padding:'3px 10px',borderRadius:2 }}>+ Track</button>
            </div>
            {(f.tracks||[]).map((t,i)=>(
              <div key={i} style={{ display:'flex',gap:8,marginBottom:6 }}>
                <input value={t.t} onChange={e=>set('tracks',f.tracks.map((x,j)=>j===i?{...x,t:e.target.value}:x))} placeholder="Track title"
                  style={{ flex:1,background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'6px 10px',fontSize:11,fontFamily:'inherit',outline:'none' }} />
                <input value={t.d} onChange={e=>set('tracks',f.tracks.map((x,j)=>j===i?{...x,d:e.target.value}:x))} placeholder="0:00" style={{ width:60,background:S.bg,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'6px 8px',fontSize:11,fontFamily:'inherit',outline:'none',textAlign:'center' }} />
                <button onClick={()=>set('tracks',f.tracks.filter((_,j)=>j!==i))} style={{ background:'none',border:'none',color:S.muted,cursor:'pointer',fontSize:14,padding:'0 4px' }}>×</button>
              </div>
            ))}
          </div>

          <div style={{ display:'flex',gap:10,justifyContent:'flex-end' }}>
            <Btn ch="Cancel" variant="ghost" onClick={onClose} />
            <Btn ch="Save Changes" onClick={()=>{ onSave(f); onClose(); }} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── ADMIN PANEL ────────────────────────────────────────────────
function AdminPanel({ records, onUpdate, onAdd, onDelete, onLogout }) {
  const [tab, setTab]       = useState('bulk');
  const [editing, setEditing] = useState(null);

  const adj = (id,d) => { const r=records.find(r=>r.id===id); onUpdate(id,{stock:Math.max(0,(r?.stock||0)+d)}); };
  const tabBtn = (key,label) => (
    <button onClick={()=>setTab(key)} style={{ background:tab===key?S.accent:S.border,color:tab===key?'#080808':S.muted,border:'none',borderRadius:2,cursor:'pointer',fontSize:9,fontWeight:tab===key?700:400,letterSpacing:1.5,textTransform:'uppercase',padding:'7px 16px' }}>{label}</button>
  );

  return (
    <div style={{ maxWidth:860,margin:'0 auto',padding:'36px 20px' }}>
      {editing && (
        <EditModal
          record={editing}
          onSave={updated=>onUpdate(updated.id, updated)}
          onClose={()=>setEditing(null)}
        />
      )}

      {editing && (
        <EditModal
          record={editing}
          onSave={updated=>onUpdate(updated.id, updated)}
          onClose={()=>setEditing(null)}
        />
      )}

      <div style={{ display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:28 }}>
        <div>
          <h1 style={{ margin:0,fontSize:18,fontWeight:800 }}>Admin Panel</h1>
          <div style={{ fontSize:10,color:S.muted,marginTop:4 }}>{records.length} records · {records.reduce((s,r)=>s+r.stock,0)} units in stock</div>
        </div>
        <Btn ch="Logout" variant="ghost" onClick={onLogout} />
      </div>

      <div style={{ background:S.surf,border:`1px solid ${S.border}`,borderRadius:3,padding:22,marginBottom:28 }}>
        <div style={{ fontSize:9,color:S.muted,letterSpacing:2,textTransform:'uppercase',marginBottom:14 }}>Add New Record</div>
        <div style={{ display:'flex',gap:6,marginBottom:18 }}>
          {tabBtn('bulk','⬇ Bulk Search')}
          {tabBtn('barcode','▥ Barcode')}
          {tabBtn('url','🔗 Single URL')}
        </div>
        {tab==='bulk'   && <BulkImporter onImportMany={recs=>recs.forEach(r=>onAdd(r))} />}
        {tab==='barcode'&& <BarcodeImporter onImport={onAdd} />}
        {tab==='url'    && <UrlImporter onImport={onAdd} />}
      </div>

      <AudioBatchUploader
        records={records}
        onMatch={updates=>Object.entries(updates).forEach(([id,url])=>
          onUpdate(Number(id),{ audio: url })
        )}
      />

      <div style={{ fontSize:9,color:S.muted,letterSpacing:2,textTransform:'uppercase',marginBottom:10 }}>Inventory</div>
      <div style={{ display:'flex',flexDirection:'column',gap:1 }}>
        {records.map(r=>(
          <div key={r.id} style={{ display:'flex',alignItems:'center',gap:12,background:S.surf,padding:'10px 14px',borderRadius:2 }}>
            <div style={{ width:40,height:40,borderRadius:2,background:`linear-gradient(${r.g})`,backgroundImage:coverSrc(r.coverUrl)?`url(${coverSrc(r.coverUrl)})`:'none',backgroundSize:'cover',flexShrink:0 }} />
            <div style={{ flex:1,minWidth:0 }}>
              <div style={{ fontSize:12,fontWeight:700,color:S.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{r.title}</div>
              <div style={{ fontSize:9,color:S.muted }}>{r.artist} · {r.label} · {r.catalog}</div>
            </div>
            <div style={{ fontSize:12,color:S.accent,fontWeight:800,width:56,textAlign:'right' }}>€{r.price.toFixed(2)}</div>
            <div style={{ display:'flex',alignItems:'center',gap:6 }}>
              <button onClick={()=>adj(r.id,-1)} style={{ width:22,height:22,borderRadius:2,background:S.border,border:'none',cursor:'pointer',color:S.text,fontSize:14 }}>-</button>
              <span style={{ fontSize:13,fontWeight:700,color:r.stock===0?S.danger:r.stock<=3?'#ff8800':S.text,width:24,textAlign:'center' }}>{r.stock}</span>
              <button onClick={()=>adj(r.id,1)} style={{ width:22,height:22,borderRadius:2,background:S.border,border:'none',cursor:'pointer',color:S.text,fontSize:14 }}>+</button>
            </div>
            <button onClick={()=>setEditing(r)} style={{ background:'none',border:`1px solid ${S.border}`,color:S.muted,cursor:'pointer',fontSize:9,letterSpacing:1,textTransform:'uppercase',padding:'4px 10px',borderRadius:2 }}>Edit</button>
            <button onClick={()=>onDelete(r.id)} style={{ background:'none',border:'none',color:S.muted,cursor:'pointer',fontSize:13,padding:4 }}>🗑</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function LoginScreen({ onLogin }) {
  const [pw, setPw]   = useState('');
  const [err, setErr] = useState(false);
  const attempt = () => { if (pw==='waxlab2024') onLogin(); else { setErr(true); setTimeout(()=>setErr(false),1500); } };
  return (
    <div style={{ minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center' }}>
      <div style={{ width:280,background:S.surf,border:`1px solid ${S.border}`,borderRadius:3,padding:32 }}>
        <div style={{ fontSize:9,letterSpacing:3,color:S.muted,textTransform:'uppercase',marginBottom:24 }}>Admin Access</div>
        <input type="password" value={pw} onChange={e=>setPw(e.target.value)} onKeyDown={e=>e.key==='Enter'&&attempt()} placeholder="Password"
          style={{ width:'100%',background:S.bg,border:`1px solid ${err?S.danger:S.border}`,color:S.text,borderRadius:2,padding:'9px 12px',fontSize:12,fontFamily:'inherit',outline:'none',boxSizing:'border-box',marginBottom:12 }}
        />
        <Btn ch="Enter" onClick={attempt} full />
        {err&&<div style={{ fontSize:10,color:S.danger,marginTop:8,textAlign:'center' }}>Incorrect password</div>}
        <div style={{ fontSize:9,color:S.muted,marginTop:12,textAlign:'center' }}>Default: waxlab2024</div>
      </div>
    </div>
  );
}

// ── APP ────────────────────────────────────────────────────────
export default function App() {
  const [records, setRecords]   = useState(RECORDS);
  const [shopifyLoaded, setShopifyLoaded] = useState(false);
  const [shopifyErr, setShopifyErr] = useState('');
  const [cart, setCart]         = useState([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [selected, setSelected] = useState(null);
  const [filters, setFilters]   = useState({ genre:null,label:null,year:null,month:null });
  const [search, setSearch]     = useState('');
  const [page, setPage]         = useState('shop');
  const [authed, setAuthed]     = useState(false);

  // Load Shopify products on mount
  useEffect(() => {
    fetchShopifyProducts()
      .then(products => {
        if (products.length) { setRecords(products); setShopifyLoaded(true); }
      })
      .catch(e => setShopifyErr(e.message));
  }, []);

  const addToCart = r => setCart(c => { const ex=c.find(i=>i.id===r.id); return ex?c.map(i=>i.id===r.id?{...i,qty:i.qty+1}:i):[...c,{...r,qty:1}]; });
  const setFilter = (k,v) => setFilters(f=>({...f,[k]:v}));

  const filtered = records.filter(r => {
    if (filters.genre  && r.genre !==filters.genre)  return false;
    if (filters.label  && r.label !==filters.label)  return false;
    if (filters.year   && r.year  !==filters.year)   return false;
    if (filters.month  && r.month !==filters.month)  return false;
    if (search && !`${r.title} ${r.artist} ${r.label}`.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const cartCount = cart.reduce((s,i)=>s+i.qty,0);

  const Nav = ({children}) => (
    <nav style={{ position:'sticky',top:0,zIndex:200,background:'rgba(8,8,8,0.96)',backdropFilter:'blur(8px)',borderBottom:`1px solid ${S.border}`,padding:'0 24px',height:52,display:'flex',alignItems:'center',justifyContent:'space-between' }}>
      <Logo scale={0.72} onClick={()=>setPage('shop')} />
      {children}
    </nav>
  );

  if (page==='login') return (
    <div style={{ background:S.bg,minHeight:'100vh',color:S.text,fontFamily:"'Inter',system-ui,sans-serif" }}>
      <Nav><button onClick={()=>setPage('shop')} style={{ background:'none',border:`1px solid ${S.border}`,color:S.muted,cursor:'pointer',fontSize:9,letterSpacing:1.5,textTransform:'uppercase',padding:'5px 12px',borderRadius:2 }}>← Shop</button></Nav>
      <LoginScreen onLogin={()=>{ setAuthed(true); setPage('admin'); }} />
    </div>
  );

  if (page==='admin') return (
    <div style={{ background:S.bg,minHeight:'100vh',color:S.text,fontFamily:"'Inter',system-ui,sans-serif" }}>
      <Nav><button onClick={()=>setPage('shop')} style={{ background:'none',border:`1px solid ${S.border}`,color:S.muted,cursor:'pointer',fontSize:9,letterSpacing:1.5,textTransform:'uppercase',padding:'5px 12px',borderRadius:2 }}>← Shop</button></Nav>
      <AdminPanel
        records={records}
        onUpdate={(id,p)=>setRecords(rs=>rs.map(r=>r.id===id?{...r,...p}:r))}
        onAdd={rec=>setRecords(rs=>[...rs,rec])}
        onDelete={id=>setRecords(rs=>rs.filter(r=>r.id!==id))}
        onLogout={()=>{ setAuthed(false); setPage('shop'); }}
      />
    </div>
  );

  return (
    <div style={{ background:S.bg,minHeight:'100vh',color:S.text,fontFamily:"'Inter',system-ui,sans-serif" }}>
      <Nav>
        <div style={{ display:'flex',gap:8,alignItems:'center' }}>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search…"
            style={{ background:S.surf,border:`1px solid ${S.border}`,color:S.text,borderRadius:2,padding:'5px 11px',fontSize:11,fontFamily:'inherit',outline:'none',width:160 }}
          />
          <button onClick={()=>authed?setPage('admin'):setPage('login')} style={{ background:'none',border:`1px solid ${S.border}`,color:S.muted,cursor:'pointer',fontSize:9,letterSpacing:1.5,textTransform:'uppercase',padding:'5px 11px',borderRadius:2 }}>Admin</button>
          <button onClick={()=>setCartOpen(true)} style={{ background:cartCount>0?S.accent:S.surf,color:cartCount>0?'#080808':S.muted,border:`1px solid ${S.border}`,borderRadius:2,padding:'5px 14px',cursor:'pointer',fontSize:10,fontWeight:700,letterSpacing:1.5,textTransform:'uppercase' }}>
            Cart{cartCount>0?` (${cartCount})`:''}
          </button>
        </div>
      </Nav>

      {/* HERO */}
      <div style={{ padding:'72px 24px 56px', textAlign:'left', borderBottom:`1px solid ${S.border}`, maxWidth:1100, margin:'0 auto' }}>
        <Logo scale={2.2} />
        <p style={{ color:S.muted, fontSize:11, margin:'20px 0 0', letterSpacing:3, textTransform:'uppercase' }}>
          Deep · Acid · Tech · Soul &nbsp;·&nbsp; Vinyl Delivered Worldwide
        </p>
      </div>

      <div style={{ maxWidth:1100,margin:'0 auto',padding:'32px 20px' }}>
        <Filters filters={filters} onChange={setFilter} records={records} />
        <div style={{ fontSize:9,color:S.muted,letterSpacing:2,marginBottom:16,textTransform:'uppercase',display:'flex',alignItems:'center',gap:10 }}>
          {filtered.length} record{filtered.length!==1?'s':''}
          {shopifyLoaded && <span style={{ color:S.accent }}>● Live from Shopify</span>}
          {shopifyErr && <span style={{ color:S.danger }}>● Shopify: {shopifyErr}</span>}
        </div>
        <div style={{ display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(190px,1fr))',gap:14 }}>
          {filtered.map(r=><RecordCard key={r.id} r={r} onOpen={setSelected} onAdd={addToCart} />)}
        </div>
        {!filtered.length&&<div style={{ textAlign:'center',color:S.muted,fontSize:12,padding:'60px 0' }}>No records found. Try adjusting the filters.</div>}
      </div>

      <div style={{ borderTop:`1px solid ${S.border}`,padding:24,textAlign:'center',marginTop:40 }}>
        <span style={{ fontSize:9,color:S.muted,letterSpacing:3 }}>HOUSEONLY · VINYL RECORD STORE · WORLDWIDE SHIPPING</span>
      </div>

      <Modal r={selected} onClose={()=>setSelected(null)} onAdd={r=>{addToCart(r);setCartOpen(true);}} />
      <CartDrawer cart={cart} open={cartOpen} onClose={()=>setCartOpen(false)} onRemove={id=>setCart(c=>c.filter(i=>i.id!==id))} />
    </div>
  );
}
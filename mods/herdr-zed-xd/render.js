/* Experimental AGC renderer: geometry and interaction GUIDs come from XD. */
const {agc, interactions, globals, images} = window.xdInput;
const children = n => n.children || n.group?.children || n.artboard?.children || [];
const ux = n => n.meta?.ux || {};
const events = new Map(Object.values(interactions.interactions || {}).flat().map(e => [e.id,e]));
const stats = {nodes:0,components:0,hover:0,tap:0,unresolved:[],unsupported:[]};
const controls = [];
const svgNS = 'http://www.w3.org/2000/svg';
function color(c) { const v=c?.value; return v ? `rgba(${v.r},${v.g},${v.b},${c.alpha??1})` : 'none'; }
function svg(tag, attrs={}) { const el=document.createElementNS(svgNS,tag); for(const [k,v]of Object.entries(attrs))if(v!=null)el.setAttribute(k,v); return el; }
function shape(n) {
  const s=n.shape,f=n.style?.fill,stroke=n.style?.stroke;
  const inset=stroke?.type!=='none'&&stroke?.align==='inside'?(stroke.width||1)/2:0;
  if(f?.type==='pattern') {
    const im=document.createElement('img'); im.src=images[f.pattern.meta?.ux?.uid]||'';
    Object.assign(im.style,{position:'absolute',left:(s.x||0)+'px',top:(s.y||0)+'px',width:s.width+'px',height:s.height+'px',objectFit:'cover'});return im;
  }
  const root=svg('svg',{width:1,height:1});root.style.overflow='visible';root.style.position='absolute';
  let el;
  if(s.type==='rect') el=svg('rect',{x:(s.x||0)+inset,y:(s.y||0)+inset,width:Math.max(0,s.width-2*inset),height:Math.max(0,s.height-2*inset),rx:Math.max(0,(s.r?.[0]??s.rx??0)-inset)});
  else if(s.type==='circle')el=svg('circle',{cx:s.cx,cy:s.cy,r:Math.max(0,s.r-inset)});
  else if(s.type==='line')el=svg('line',{x1:s.x1,y1:s.y1,x2:s.x2,y2:s.y2});
  else if(s.type==='path')el=svg('path',{d:s.path});
  else if(s.type==='polygon')el=svg('polygon',{points:s.points.map(p=>`${p.x},${p.y}`).join(' ')});
  else {stats.unsupported.push(s.type);return root;}
  el.setAttribute('fill',f?.type==='solid'?color(f.color):'none');
  if(stroke&&stroke.type!=='none'){el.setAttribute('stroke',color(stroke.color));el.setAttribute('stroke-width',stroke.width??1);}
  root.append(el);return root;
}
const baselineCache=new Map();
function baseline(font){
 const key=JSON.stringify(font);if(baselineCache.has(key))return baselineCache.get(key);
 const line=document.createElement('div');Object.assign(line.style,{position:'absolute',visibility:'hidden',whiteSpace:'nowrap',fontFamily:font.family||'Arial',fontSize:(font.size||12)+'px',fontWeight:/bold/i.test(font.style||'')?'700':'400',lineHeight:(font.size||12)+'px'});
 line.append(document.createTextNode('Hg'));const marker=document.createElement('span');Object.assign(marker.style,{display:'inline-block',width:'0',height:'0',verticalAlign:'baseline'});line.append(marker);document.body.append(line);
 const value=marker.getBoundingClientRect().top-line.getBoundingClientRect().top;line.remove();baselineCache.set(key,value);return value;
}
function packedColor(value){return `rgba(${(value>>>16)&255},${(value>>>8)&255},${value&255},${(value>>>24)/255})`;}
function text(n) {
  const box=document.createElement('div'),font=n.style?.font||{},raw=n.text.rawText;
  Object.assign(box.style,{position:'absolute',color:color(n.style?.fill?.color),fontFamily:font.family||'Arial',fontSize:(font.size||12)+'px',fontWeight:/bold/i.test(font.style||'')?'700':'400',whiteSpace:'pre',lineHeight:'1'});
  const paragraphs=ux(n).outlinesLayout?.static?.paragraphs;
  if(paragraphs)for(const p of paragraphs)for(const line of p.lines){
    const span=document.createElement('span');const runs=line.runs||[];
    const start=runs[0]?.stringRange.startIndex||0;
    const end=Math.max(start,...runs.map(r=>r.stringRange.startIndex+r.stringRange.length));
    const width=(line.layoutBounds?.right||0)-(line.layoutBounds?.left||0),align=n.style?.textAttributes?.paragraphAlign;
    const anchor=align==='center'?-width/2:align==='right'?-width:0;
    // XD's text transform is an alignment anchor at the baseline, not a top-left corner.
    Object.assign(span.style,{position:'absolute',left:((line.layoutBounds?.left||0)+anchor)+'px',top:((line.position||0)-baseline(font))+'px'});
    let cursor=0;const ranged=ux(n).rangedStyles||[];
    for(const [rangeIndex,range] of ranged.entries()){const rangeEnd=rangeIndex===ranged.length-1?raw.length:range.length?cursor+range.length:raw.length;const a=Math.max(start,cursor),b=Math.min(end,rangeEnd);if(b>a){const fragment=document.createElement('span');fragment.textContent=raw.slice(a,b).replace(/\n/g,'');if(range.fill?.value!=null)fragment.style.color=packedColor(range.fill.value);if(range.underline)fragment.style.textDecoration='underline';if(range.strikethrough)fragment.style.textDecoration='line-through';if(range.fontStyle)fragment.style.fontWeight=/bold/i.test(range.fontStyle)?'700':'400';span.append(fragment);}cursor=rangeEnd;}
    if(!ranged.length)span.textContent=raw.slice(start,end).replace(/\n/g,'');box.append(span);
  }else {box.textContent=raw;box.style.top=-(font.size||12)+'px';}
  return box;
}
function render(n, ignoreTransform=false, allowState=true) {
  stats.nodes++;
  const el=document.createElement('div'),u=ux(n),t={a:1,b:0,c:0,d:1,tx:0,ty:0,...n.transform};
  el.className='xd-node';el.dataset.xdId=n.id||'';el.dataset.xdName=n.name||n.type;
  Object.assign(el.style,{position:'absolute',left:'0',top:'0',transformOrigin:'0 0',transform:ignoreTransform?'none':`matrix(${t.a},${t.b},${t.c},${t.d},${t.tx},${t.ty})`});
  if(n.visible===false)el.style.display='none';
  if(n.style?.opacity!=null)el.style.opacity=n.style.opacity;
  if(u.width!=null)el.style.width=u.width+'px';if(u.height!=null)el.style.height=u.height+'px';
  const clip=u.clipPathResources?.children;
  if(u.isMaskGroup&&clip?.length){
    const id='clip-'+(++render.clipSequence),defs=svg('svg',{width:0,height:0});
    const cp=svg('clipPath',{id,clipPathUnits:'userSpaceOnUse'});
    function clipGeometry(node,parent=new DOMMatrix()){
      const t={a:1,b:0,c:0,d:1,tx:0,ty:0,...node.transform};
      const matrix=parent.multiply(new DOMMatrix([t.a,t.b,t.c,t.d,t.tx,t.ty]));
      const geometry=[];
      if(node.shape){
        const drawing=shape({...node,style:{fill:{type:'solid',color:{value:{r:255,g:255,b:255}}}}});
        if(drawing.namespaceURI===svgNS)for(const leaf of [...drawing.children]){
          leaf.setAttribute('transform',matrix.toString());geometry.push(leaf);
        }
      }
      for(const child of children(node))geometry.push(...clipGeometry(child,matrix));
      return geometry;
    }
    cp.append(...clip.flatMap(node=>clipGeometry(node)));defs.append(cp);el.append(defs);el.style.clipPath=`url(#${id})`;
  }
  if(n.type==='shape')el.append(shape(n));else if(n.type==='text')el.append(text(n));else {
    const states=u.states;
    if(allowState&&states?.length){
      stats.components++;
      const alternatives=[n,...states],byState=new Map(alternatives.map(s=>[ux(s).stateId||ux(s).symbolId,s]));
      let persistent=u.stateId||u.symbolId,current=persistent,hovering=false;
      const mount=document.createElement('div');mount.className='state-content';el.append(mount);
      function entries(state){return (ux(byState.get(state)||n).interactions||[]).filter(e=>e.enabled!==false&&e.valid!==false).map(e=>events.get(e.guid)||e.data?.interaction).filter(Boolean);}
      function draw(state){current=state;el.dataset.xdState=state;mount.replaceChildren(...children(byState.get(state)||n).map(c=>render(c)));}
      function transition(e){if(!e||!byState.has(e.properties.destination))return false;draw(e.properties.destination);return true;}
      const supported=[...byState.keys()].flatMap(state=>entries(state).filter(e=>e.action==='state-transition').map(e=>({state,trigger:e.triggerEvent,target:e.properties.destination,resolved:byState.has(e.properties.destination)})));
      for(const e of supported)if(!e.resolved)stats.unresolved.push({id:n.id,...e});
      const hasHover=supported.some(e=>e.trigger==='hover'&&e.resolved),hasTap=supported.some(e=>e.trigger==='tap'&&e.resolved);
      if(hasHover)stats.hover++;if(hasTap)stats.tap++;
      if(hasHover||hasTap){el.style.pointerEvents='auto';el.style.cursor='pointer';}
      el.addEventListener('pointerenter',()=>{hovering=true;transition(entries(persistent).find(e=>e.triggerEvent==='hover'));});
      el.addEventListener('pointerleave',()=>{hovering=false;draw(persistent);});
      el.addEventListener('click',e=>{e.stopPropagation();const action=entries(current).find(e=>e.triggerEvent==='tap')||entries(persistent).find(e=>e.triggerEvent==='tap');if(transition(action))persistent=current;});
      draw(persistent);controls.push({el,node:n,byState,entries,get persistent(){return persistent},get current(){return current},supported,draw,reset(state){persistent=state;draw(state);}});
    }else children(n).forEach(c=>el.append(render(c)));
  }
  return el;
}
render.clipSequence=0;
const art=agc.children[0],bounds=agc.artboards[art.id],host=document.querySelector('#artboard');
host.style.width=bounds.width+'px';host.style.height=bounds.height+'px';host.style.background=color(art.style?.fill?.color);
const origin=document.createElement('div');Object.assign(origin.style,{position:'absolute',transform:`translate(${-bounds.x}px,${-bounds.y}px)`});host.append(origin);
children(art).forEach(c=>origin.append(render(c)));
document.querySelector('#status').textContent=`${bounds.name} · ${bounds.width} × ${bounds.height} · ${stats.components} stateful components · ${stats.hover} hover bindings · ${stats.tap} click bindings`;
if(images.reference)document.querySelector('#original').src=images.reference;else document.querySelector('#original').remove();
document.querySelector('#reference-toggle').addEventListener('change',e=>{if(document.querySelector('#original'))document.querySelector('#original').hidden=!e.target.checked;});
const colors=document.querySelector('#colors');for(const c of Object.values(globals.colors || {})){const item=document.createElement('span');item.textContent=c.name||color(c.color);item.style.borderLeft=`16px solid ${color(c.color)}`;colors.append(item);}
window.xdPreview={stats:JSON.parse(JSON.stringify(stats)),controls};
// Exercise the exact same DOM handlers without focusing or opening any visible window.
async function verify(){
 await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));
 const initialStats=JSON.parse(JSON.stringify(stats));
 const results=[];
 for(const c of controls){
  const before=c.current,markup=c.el.querySelector('.state-content').innerHTML;
  const hover=c.supported.find(e=>e.state===before&&e.trigger==='hover'&&e.resolved);
  if(hover){c.el.dispatchEvent(new Event('pointerenter'));const after=c.current,changed=markup!==c.el.querySelector('.state-content').innerHTML;c.el.dispatchEvent(new Event('pointerleave'));results.push({id:c.node.id,name:c.node.name,test:'hover',pass:after===hover.target&&changed&&c.current===before,from:before,to:after});}
  const click=c.supported.find(e=>e.state===before&&e.trigger==='tap'&&e.resolved);
  if(click){c.el.click();const after=c.current;const reverse=c.supported.find(e=>e.state===after&&e.trigger==='tap'&&e.target===before);if(reverse)c.el.click();results.push({id:c.node.id,test:'tap',pass:after===click.target&&(!reverse||c.current===before),from:before,to:after});}
  c.reset(before);
 }
 const report={stats:initialStats,results,pass:results.every(r=>r.pass),brokenImages:[...document.images].filter(i=>!i.complete||!i.naturalWidth).map(i=>i.src.slice(0,100))};
 const pre=document.createElement('pre');pre.id='verification';pre.textContent=JSON.stringify(report);document.body.append(pre);return report;
}
window.xdVerify=verify;

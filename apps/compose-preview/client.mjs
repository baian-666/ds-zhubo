import {Application} from '@pixi/app'
import {extensions} from '@pixi/extensions'
import {BatchRenderer} from '@pixi/core'
import {Ticker,TickerPlugin} from '@pixi/ticker'
import {Live2DModel} from 'pixi-live2d-display/cubism4'

extensions.add(TickerPlugin);extensions.add(BatchRenderer);Live2DModel.registerTicker(Ticker)
const stage=document.querySelector('#stage'),status=document.querySelector('#status')
const app=new Application({width:stage.clientWidth,height:stage.clientHeight,backgroundAlpha:0,antialias:true,preserveDrawingBuffer:true,resolution:devicePixelRatio,autoDensity:true})
stage.appendChild(app.view)
const models={},hidden={old:new Set(),body:new Set(),back:new Set()},defaults={headScale:.82,headX:5,headY:100,zoom:1}
// Verified against the original model: tabletop, board/clip, pen, desktop icons and sundae.
// Keep the separate fingers, sleeves, torso, hair and tail. The sundae mesh includes its small gripping fingers.
const cleanHidden=new Set(['ArtMesh0','ArtMesh107','ArtMesh108','ArtMesh109','ArtMesh103','ArtMesh612','ArtMesh609','ArtMesh607','ArtMesh604','ArtMesh602','ArtMesh599'])
for(const [id,value]of Object.entries(defaults))document.getElementById(id).value=value
try {
 const saved=JSON.parse(localStorage.getItem('whale-compose-preview')||'null')
 for(const id of Object.keys(defaults)) {
  const input=document.getElementById(id),value=saved?.[id]
  if(Number.isFinite(value) && value>=Number(input.min) && value<=Number(input.max))input.value=value
 }
} catch {}
let action='idle',mode=new URLSearchParams(location.search).get('view')==='old-clean'?'old-clean':'compose',fixedTime=null,restNeck=null,headOrigin={x:0,y:0}
document.querySelector('#mode').value=mode
const controls=()=>Object.fromEntries(Object.keys(defaults).map(id=>[id,Number(document.getElementById(id).value)]))
function bounds(model,index) {
 const v=model.internalModel.getDrawableVertices(index),xs=[],ys=[]
 for(let i=0;i<v.length;i+=2){xs.push(v[i]);ys.push(v[i+1])}
 return {x0:Math.min(...xs),x1:Math.max(...xs),y0:Math.min(...ys),y1:Math.max(...ys)}
}
function layout() {
 if(!models.old || !models.body)return
 const w=stage.clientWidth,h=stage.clientHeight,c=controls()
 app.renderer.resize(w,h)
 const body=models.body,old=models.old
 const b=body.internalModel,o=old.internalModel
 const scale=h*.9/b.height*c.zoom
 body.scale.set(scale);body.position.set(w/2-b.width*scale/2,h*.03)
 const oldScale=h*.65/o.height*c.headScale*c.zoom
 old.scale.set(oldScale);old.position.set(w/2-o.width*oldScale/2+c.headX*h/1000*c.zoom,h*.03+(h*.01+c.headY*h/1000)*c.zoom)
 headOrigin={x:old.x,y:old.y}
 if(mode==='old' || mode==='old-clean'){old.visible=true;body.visible=false;old.scale.set(h*.9/o.height*c.zoom);old.position.set(w/2-old.width/2,h*.03)}
 else if(mode==='body'){old.visible=false;body.visible=true}
 else {old.visible=true;body.visible=true}
 models.back.visible=mode==='compose';models.back.scale.copyFrom(old.scale);models.back.position.copyFrom(old.position)
}
function layerList() {
 const name=document.querySelector('#layerModel').value,model=models[name]
 const container=document.querySelector('#layers');container.replaceChildren()
 for(const [i,id] of model.internalModel.getDrawableIDs().entries()) {
  const label=document.createElement('label'),input=document.createElement('input')
  input.type='checkbox';input.checked=!hidden[name].has(id)
  input.onchange=()=>input.checked?hidden[name].delete(id):hidden[name].add(id)
  label.append(input,document.createTextNode(`${i} ${id}`));container.append(label)
 }
}
function set(core,id,value){if(core._model.parameters.ids.includes(id))core.setParameterValueById(id,value)}
async function main() {
 const manifest=await fetch('/manifest.json').then(r=>r.json())
 for(const name of ['back','body','old']) {
  const model=await Live2DModel.from(manifest[name==='back'?'old':name],{autoInteract:false,autoUpdate:false})
  models[name]=model;app.stage.addChild(model)
  const internal=model.internalModel,core=internal.coreModel
  internal.motionManager.stopAllMotions()
  for(const id of internal.getDrawableIDs()) {
    const number=Number(id.replace('ArtMesh',''))
    const keep=name==='back'?id==='YM_hair_B_2':name==='body' ? /^ArtMesh\d+$/.test(id) && ((number>=52 && number<=72) || (number>=82 && number<=90)) :
      (!/^ArtMesh/.test(id) && !id.startsWith('neck_') && id!=='YM_hair_B_2') || ['ArtMesh','ArtMesh3','ArtMesh4','ArtMesh5','ArtMesh6','ArtMesh7','ArtMesh22','ArtMesh23','ArtMesh24','ArtMesh33','ArtMesh34','ArtMesh63','ArtMesh64','ArtMesh65','ArtMesh69','ArtMesh653','ArtMesh654'].includes(id)
    if(!keep)hidden[name].add(id)
  }
  internal.on('beforeModelUpdate',()=>{
   const t=fixedTime??performance.now()/1000
   const turn=action==='turn'?Math.sin(t)*20:0,sway=action==='sway'?Math.sin(t)*6:0
   set(core,'ParamAngleX',turn);set(core,'ParamAngleX2',turn);set(core,'ParamAngleY',0);set(core,'ParamAngleY2',0)
   set(core,'ParamAngleZ',0);set(core,'ParamAngleZ2',0);set(core,'ParamBodyAngleX',name==='body'?sway:0);set(core,'ParamBodyAngleZ',name==='body'?sway:0)
   set(core,'ParamMouthOpenY',name==='old' && action==='talk'?(Math.sin(t*11)+1)*.35:0)
   if(name!=='body') {
    set(core,'ParamCheek76',action==='smile'?1:0)
    set(core,'ParamEyeLOpen',action==='smile'?0:1);set(core,'ParamEyeROpen',action==='smile'?0:1)
   }
  })
  const draw=internal.draw.bind(internal)
  internal.draw=gl=>{
   const mask=mode==='compose'?hidden[name]:mode==='old-clean' && name==='old'?cleanHidden:null
   if(!mask){draw(gl);return}
   const drawable=core._model.drawables,saved=drawable.opacities.slice()
   for(let i=0;i<drawable.count;i++)if(mask.has(drawable.ids[i]))drawable.opacities[i]=0
   try{draw(gl)}finally{drawable.opacities.set(saved)}
  }
 }
 window.preview={models,hidden,cleanHidden,layout,bounds,setMode:value=>{mode=value;document.querySelector('#mode').value=value;layout()},
  setAction:(value,time=null)=>{action=value;fixedTime=time},dump:()=>Object.fromEntries(Object.entries(models).map(([name,m])=>[name,{width:m.internalModel.width,height:m.internalModel.height,
   parameters:m.internalModel.coreModel._model.parameters.ids.map((id,i)=>({id,min:m.internalModel.coreModel._model.parameters.minimumValues[i],max:m.internalModel.coreModel._model.parameters.maximumValues[i]})),
   drawables:m.internalModel.getDrawableIDs().map((id,i)=>({id,...bounds(m,i),opacity:m.internalModel.coreModel.getDrawableOpacity(i)}))}]))}
 for(const m of Object.values(models))m.internalModel.update(16,0)
 const neck=bounds(models.body,'ArtMesh59');restNeck={x:(neck.x0+neck.x1)/2,y:(neck.y0+neck.y1)/2}
 app.ticker.add(()=>{
  const now=fixedTime===null?performance.now():fixedTime*1000
  for(const m of Object.values(models))m.internalModel.update(Math.min(app.ticker.deltaMS,50),now)
  if(mode==='compose') {
   const neck=bounds(models.body,'ArtMesh59')
   const dx=((neck.x0+neck.x1)/2-restNeck.x)*models.body.scale.x
   const dy=((neck.y0+neck.y1)/2-restNeck.y)*models.body.scale.y
   models.old.position.set(headOrigin.x+dx,headOrigin.y+dy);models.back.position.copyFrom(models.old.position)
  }
 })
 layout();layerList();status.textContent='独立形象预览 · 尚未替换正式角色';window.preview.ready=true
}
document.querySelector('#mode').onchange=e=>{mode=e.target.value;layout()}
for(const id of Object.keys(defaults))document.getElementById(id).oninput=layout
document.querySelector('#layerModel').onchange=layerList
document.querySelector('#actions').onclick=e=>{if(e.target.dataset.action){action=e.target.dataset.action;fixedTime=null;for(const b of e.currentTarget.children)b.classList.toggle('active',b===e.target)}}
document.querySelector('#reset').onclick=()=>{for(const [id,value]of Object.entries(defaults))document.getElementById(id).value=value;layout()}
document.querySelector('#save').onclick=()=>{localStorage.setItem('whale-compose-preview',JSON.stringify(controls()));status.textContent='已保存本机比例调整'}
new ResizeObserver(layout).observe(stage)
main().catch(error=>{status.textContent='模型加载失败，请查看本机预览日志';console.error(error)})

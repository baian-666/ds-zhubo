import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {readFileSync,writeFileSync,mkdirSync,existsSync,realpathSync} from 'node:fs'
import {join,dirname,resolve,sep} from 'node:path'
import {createServer} from 'node:http'

const root=fileURLToPath(new URL('../',import.meta.url))
const data=join(root,'data/compose-preview')
const dependencies=join(root,'vendor/airi/packages/stage-ui-live2d/node_modules')
const require=createRequire(join(dependencies,'jszip/package.json'))
const JSZip=require('jszip')
const {build}=require(join(root,'vendor/airi/node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild'))
mkdirSync(data,{recursive:true})
async function extract(archive,name) {
 const zip=await JSZip.loadAsync(readFileSync(archive))
 const destination=join(data,'models',name)
 let modelPath,total=0
 for(const entry of Object.values(zip.files)) {
  if(entry.dir || !/\.(json|png|moc3)$/i.test(entry.name))continue
  if(entry.unsafeOriginalName && entry.unsafeOriginalName!==entry.name)throw Error('Unsafe ZIP path')
  const size=entry._data?.uncompressedSize
  if(!Number.isSafeInteger(size) || size>64*1024*1024 || (total+=size)>256*1024*1024)throw Error('Model archive exceeds preview limits')
  const path=resolve(destination,entry.name)
  if(!path.startsWith(destination+sep) || entry.name.includes('\\'))throw Error('Unsafe ZIP path')
  mkdirSync(dirname(path),{recursive:true})
  if(!existsSync(path))writeFileSync(path,await entry.async('nodebuffer'))
  if(entry.name.endsWith('.model3.json')){if(modelPath)throw Error('Expected one model');modelPath='/models/'+name+'/'+entry.name}
 }
 if(!modelPath)throw Error('Missing model3.json')
 return modelPath
}
const manifest={old:await extract(join(root,'data/live2d/whale-airi.zip'),'old'),
 body:await extract(process.argv[2]||'D:/edge_download/大肥鱼.zip','body')}
writeFileSync(join(data,'manifest.json'),JSON.stringify(manifest))
await build({entryPoints:[join(root,'apps/compose-preview/client.mjs')],outfile:join(data,'client.js'),bundle:true,format:'esm',platform:'browser',nodePaths:[dependencies],logLevel:'warning'})
const assets=new Map([
 ['/',join(root,'apps/compose-preview/index.html')],['/client.js',join(data,'client.js')],['/manifest.json',join(data,'manifest.json')],
 ['/core.js',join(root,'vendor/airi/apps/stage-web/public/assets/js/CubismSdkForWeb-5-r.3/Core/live2dcubismcore.min.js')],
])
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json','.png':'image/png','.moc3':'application/octet-stream'}
const server=createServer((req,res)=>{
 try {
  if(req.method!=='GET' && req.method!=='HEAD'){res.writeHead(405).end();return}
  const name=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname)
  if(name==='/healthz'){res.writeHead(200,{'Content-Type':'application/json'}).end('{"app":"whale-compose-preview"}');return}
  let path=assets.get(name)
  if(!path && name.startsWith('/models/')) {
   const candidate=resolve(data,'.'+name),modelRoot=join(data,'models')+sep
   if(candidate.startsWith(modelRoot) && existsSync(candidate) && realpathSync(candidate).startsWith(modelRoot))path=candidate
  }
  if(!path){res.writeHead(404).end();return}
  const extension=path.slice(path.lastIndexOf('.'))
  if(!mime[extension]){res.writeHead(404).end();return}
  res.writeHead(200,{'Content-Type':mime[extension],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
   'Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"})
  res.end(req.method==='HEAD'?undefined:readFileSync(path))
 } catch {res.writeHead(404).end()}
})
server.listen(8790,'127.0.0.1',()=>console.log('Independent Live2D preview: http://127.0.0.1:8790'))

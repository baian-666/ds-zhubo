import { createApp } from '../../apps/cohost/server.mjs'
const server=createApp({sessionPath:process.argv[2],apiKey:'fixture-only',token:'',reply:async function*(){yield '第一句。第二句。'}})
server.listen(0,'127.0.0.1',()=>process.send({base:`http://127.0.0.1:${server.address().port}`}))

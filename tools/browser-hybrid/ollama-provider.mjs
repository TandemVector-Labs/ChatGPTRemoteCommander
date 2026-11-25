// Stagehand v4 BYO-LLM adapter for a host-local Ollama daemon.
// No provider token, remote model endpoint, or implicit data disclosure.
const LOOPBACK='http://127.0.0.1:11434/api/chat';
const MAX_MESSAGES=48, MAX_PROMPT_CHARS=110000;
export function createOllamaGenerate({model='qwen3:4b-instruct',url=LOOPBACK,timeoutMs=25000,fetchFn=fetch}={}){
 const endpoint=new URL(url);
 if(endpoint.protocol!=='http:' || endpoint.hostname!=='127.0.0.1'||endpoint.port!=='11434'||endpoint.pathname!=='/api/chat'
  || endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw Error('OLLAMA_ONLY_HOST_LOCAL_LOOPBACK');
 if(!/^[a-zA-Z0-9][a-zA-Z0-9._:\/-]{0,120}$/.test(model))throw Error('OLLAMA_MODEL_INVALID');
 if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>120000)throw Error('OLLAMA_TIMEOUT_INVALID');
 return async params=>{
  if(params?.responseFormat?.type!=='json_schema'||!params.responseFormat.schema)throw Error('STAGEHAND_STRUCTURED_ONLY');
  if(!Array.isArray(params.messages)||params.messages.length>MAX_MESSAGES)throw Error('OLLAMA_MESSAGE_COUNT');
  const parseBlocks=(content)=>{
   const blocks=Array.isArray(content)?content:[content];
   if(!blocks.length)return '';
   return blocks.map(b=>{
    if(!b||b.type!=='text'||typeof b.text!=='string')throw Error('OLLAMA_TEXT_ONLY_NO_IMAGES');
    return b.text;
   }).join('\n');
  };
  let budget=String(params.systemPrompt||'').length;
  const messages=[];
  if(params.systemPrompt)messages.push({role:'system',content:String(params.systemPrompt)});
  for(const msg of params.messages){
   if(!['user','assistant'].includes(msg.role))throw Error('OLLAMA_ROLE_DENIED');
   const c=parseBlocks(msg.content);budget+=c.length;
   messages.push({role:msg.role,content:c});
  }
  if(budget>MAX_PROMPT_CHARS)throw Error('OLLAMA_PROMPT_TOO_LARGE');
  const abort=new AbortController();
  const guard=setTimeout(()=>abort.abort(),timeoutMs);
  try{
   const response=await fetchFn(endpoint.href,{
    method:'POST',signal:abort.signal,headers:{'content-type':'application/json'},
    body:JSON.stringify({model,messages,stream:false,think:false,format:params.responseFormat.schema,
      options:{temperature:0,num_predict:1024,num_ctx:8192}})
   });
   if(!response.ok)throw Error('OLLAMA_HTTP_'+response.status);
   const body=await response.json(),text=body?.message?.content;
   if(typeof text!=='string'||!text.trim()||text.length>150000)throw Error('OLLAMA_EMPTY_OR_OVERSIZE');
   const parsed=JSON.parse(text);
   if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('OLLAMA_NOT_STRUCTURED_OBJECT');
   return {role:'assistant',content:{type:'text',text},outputFormat:'json_schema',structuredContent:parsed};
  }finally{clearTimeout(guard)}
 };
}

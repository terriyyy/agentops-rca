import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Link} from 'react-router-dom';
import {ArrowLeft,ArrowUpRight,Check,ChevronDown,Eye,EyeOff,KeyRound,Loader2,Pencil,Plus,ShieldCheck,Trash2,X} from 'lucide-react';
import {api} from './api';
import {useData} from './read-data';
import './model-settings.css';

interface Connection {name:string;base_url:string;model:string;token_parameter:string;source:string;updated_at:string|null}
export interface ModelSettings {configured:boolean;revision:string|null;connection:Connection|null;key_configured:boolean;scope:string;protocol:string;protection:string;call_status:string}
export const modelConnectionStatus=(status:string)=>({configured:'已保存 · 尚未验证',last_call_succeeded:'最近调用成功',last_call_failed:'最近调用失败',unconfigured:'未配置'} as Record<string,string>)[status]||'状态未知';

function ConnectionDialog({settings,onSaved,onClose}:{settings:ModelSettings;onSaved:(value:ModelSettings)=>void;onClose:()=>void}) {
  const current=settings.connection,dialog=useRef<HTMLDialogElement>(null),alive=useRef(true);
  const [name,setName]=useState(current?.name||''),[url,setUrl]=useState(current?.base_url||''),[model,setModel]=useState(current?.model||'');
  const [key,setKey]=useState(''),[visible,setVisible]=useState(false),[parameter,setParameter]=useState(current?.token_parameter||'max_tokens');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const changedEndpoint=!!current&&url.trim().replace(/\/+$/,'')!==current.base_url;
  useEffect(()=>{alive.current=true;const trigger=document.activeElement as HTMLElement|null,node=dialog.current;node?.showModal();return()=>{alive.current=false;node?.close();if(trigger?.isConnected)trigger.focus({preventScroll:true});};},[]);
  async function save(event:FormEvent){
    event.preventDefault();if(busy)return;setBusy(true);setError('');
    try{
      const result=await api<ModelSettings>('/settings/rca-model',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,base_url:url,model,api_key:key,token_parameter:parameter,expected_revision:settings.revision})});
      setKey('');if(alive.current)onSaved(result);
    }catch(e){if(alive.current)setError((e as Error).message.replaceAll(key||'\u0000','[密钥已隐藏]'));}
    finally{if(alive.current)setBusy(false);}
  }
  return <dialog ref={dialog} className="model-connection-dialog" aria-labelledby="connection-dialog-title" onCancel={event=>{event.preventDefault();if(!busy)onClose();}} onClick={event=>{if(event.target===event.currentTarget&&!busy)onClose();}}>
    <form onSubmit={save} autoComplete="off">
      <header><div className="model-dialog-title"><KeyRound size={19}/><h2 id="connection-dialog-title">{current?'编辑模型连接':'添加模型连接'}</h2></div><button type="button" className="icon-button" aria-label="关闭模型配置" disabled={busy} onClick={onClose}><X size={19}/></button></header>
      <div className="model-dialog-fields">
        <p className="model-form-intro">仅用于 RCA 原因分析。保存后仍需在 Run 中预览并确认发送。</p>
        <label>连接名称<input value={name} onChange={event=>setName(event.target.value)} required maxLength={80} placeholder="例如：团队测试代理" disabled={busy}/></label>
        <div className="model-protocol"><span>接口协议</span><strong>OpenAI-compatible <small>Chat Completions</small></strong><span>当前支持此协议；模型名称以你的服务商为准。</span></div>
        <label>服务地址 <span className="field-hint">API Base URL</span><input aria-label="服务地址" aria-describedby="model-endpoint-hint" type="url" value={url} onChange={event=>setUrl(event.target.value)} required maxLength={500} placeholder="https://api.example.com/v1" disabled={busy}/><small id="model-endpoint-hint">填写基础地址，不包含 /chat/completions。HTTPS 或本机 HTTP。</small></label>
        <label>API Key <span className="field-hint">{current?'已有凭据已保存':'你的服务商密钥'}</span><div className="model-key-input"><input aria-label="API Key" type={visible?'text':'password'} value={key} onChange={event=>setKey(event.target.value)} required={!current||changedEndpoint} minLength={8} maxLength={4096} autoComplete="new-password" spellCheck={false} placeholder={current&&!changedEndpoint?'留空保留现有密钥':'输入 API Key'} disabled={busy}/><button type="button" aria-label={visible?'隐藏新密钥':'显示新密钥'} aria-pressed={visible} onClick={()=>setVisible(value=>!value)} disabled={busy}>{visible?<EyeOff size={16}/>:<Eye size={16}/>}</button></div><small>{changedEndpoint?'服务地址已改变，请提供该服务的密钥。':'保存的密钥不会回填到页面；可输入新密钥替换。'}</small></label>
        <label>默认分析模型<input aria-label="默认分析模型" aria-describedby="model-id-hint" value={model} onChange={event=>setModel(event.target.value)} required maxLength={150} placeholder="填写服务商接受的模型 ID" disabled={busy}/><small id="model-id-hint">与被监控 Agent 使用的模型独立，不限定为某个 GPT 型号。</small></label>
        <details className="model-advanced"><summary>高级设置<ChevronDown size={13}/></summary><label>输出上限参数<select value={parameter} onChange={event=>setParameter(event.target.value)} disabled={busy}><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></label><p>单次输出上限为 2,500 token；按服务商协议选择。不会自动切换参数重试模型。</p></details>
        {error&&<p className="model-form-error" role="alert">{error}</p>}
      </div>
      <footer><span><ShieldCheck size={13}/>密钥加密保存在本地后端</span><div><button type="button" className="button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={busy}>{busy?<Loader2 size={14} className="spin"/>:<Check size={14}/>}保存配置</button></div></footer>
    </form>
  </dialog>;
}

function DeleteDialog({settings,onDeleted,onClose}:{settings:ModelSettings;onDeleted:()=>void;onClose:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{const trigger=document.activeElement as HTMLElement|null,node=dialog.current;node?.showModal();return()=>{node?.close();if(trigger?.isConnected)trigger.focus({preventScroll:true});};},[]);
  async function remove(){if(busy)return;setBusy(true);setError('');try{await api<ModelSettings>('/settings/rca-model',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({expected_revision:settings.revision})});onDeleted();}catch(e){setError((e as Error).message);setBusy(false);}}
  return <dialog ref={dialog} className="model-delete-dialog" aria-labelledby="delete-connection-title" onCancel={event=>{event.preventDefault();if(!busy)onClose();}}><h2 id="delete-connection-title">删除模型连接？</h2><p>删除「{settings.connection?.name}」的已保存凭据并停用原因分析模型。历史报告和任务检查记录保留。</p>{settings.connection?.source==='environment'&&<p>原 .env 文件保留，但此工作区不会再自动使用其中的模型密钥。</p>}<p>已发送的模型调用不会因此撤回。后续分析需要重新配置。</p>{error&&<p role="alert" className="model-form-error">{error}</p>}<footer><button className="button" disabled={busy} onClick={onClose}>取消</button><button className="button model-delete-confirm" disabled={busy} onClick={remove}>{busy?<Loader2 size={14} className="spin"/>:<Trash2 size={14}/>}确认删除</button></footer></dialog>;
}

export function ModelSettingsPage(){
  const [revision,setRevision]=useState(0),data=useData<ModelSettings>('/settings/rca-model',revision);
  const [editor,setEditor]=useState<ModelSettings|null>(null),[deleting,setDeleting]=useState(false),[feedback,setFeedback]=useState('');
  const settings=data.data,current=settings?.connection;
  const recovery:ModelSettings={configured:true,revision:null,connection:{name:'无法读取的连接',base_url:'',model:'',token_parameter:'max_tokens',source:'managed',updated_at:null},key_configured:true,scope:'local_workspace',protocol:'openai_chat_completions',protection:'',call_status:'unconfigured'};
  function saved(){setEditor(null);setFeedback('配置已保存。尚未调用模型，请在 Run 中重新预览发送内容。');setRevision(value=>value+1);}
  return <div className="model-settings-page"><div className="model-page-heading"><div><Link className="model-back" to="/system"><ArrowLeft size={13}/>运行环境</Link><h1>模型连接</h1><p>配置 RCA 分析使用的服务、模型与凭据。</p></div><button className="button primary" disabled={!settings||!!data.error||data.loading} onClick={()=>{setFeedback('');setEditor(settings);}}>{current?<Pencil size={14}/>:<Plus size={14}/>} {current?'编辑连接':'添加连接'}</button></div>
    <div className="model-workspace-note"><ShieldCheck size={17}/><div><strong>当前本地工作区</strong><span>此连接仅供 RCA 原因分析使用，被监控 Agent 的模型配置由接入方管理。</span></div></div>
    {feedback&&<p className="model-save-feedback" role="status"><Check size={15}/>{feedback}</p>}
    {data.error&&<div className="model-load-error" role="alert"><span>{data.error}</span><button className="text-button" onClick={()=>setRevision(value=>value+1)}>重新读取</button>{data.error.includes('模型凭据存储无法读取')&&<button className="text-button" onClick={()=>setDeleting(true)}>删除损坏连接并重新配置</button>}</div>}
    <section className="model-connections" aria-label="分析模型连接"><div className="model-list-heading"><h2>RCA 默认连接</h2><span>当前支持 1 个连接</span></div>
      {data.loading&&!settings?<p className="model-loading"><Loader2 size={16} className="spin"/>读取模型配置…</p>:current?<>
        <div className="model-connection-columns" aria-hidden="true"><span>连接 / 服务地址</span><span>默认分析模型</span><span>状态</span><span>凭据</span><span>操作</span></div>
        <div className="model-connection-row"><div className="model-connection-name"><span className="model-connection-icon"><KeyRound size={18}/></span><div><strong>{current.name}</strong><code title={current.base_url}>{current.base_url}</code></div></div><div className="model-default-model"><span>{current.model}</span><small>Chat Completions</small></div><span className={'model-call-status '+settings?.call_status}>{modelConnectionStatus(settings?.call_status||'')}</span><span className="model-key-saved"><ShieldCheck size={14}/>已保存</span><div className="model-row-actions"><button className="model-icon-button" aria-label="编辑模型连接" onClick={()=>{setFeedback('');setEditor(settings);}} disabled={!!data.error}><Pencil size={15}/></button><button className="model-icon-button" aria-label="删除模型连接" onClick={()=>setDeleting(true)} disabled={!!data.error}><Trash2 size={15}/></button></div></div>
        <div className="model-connection-source"><span>{current.source==='environment'?'来源：本机 .env · 尚未由页面接管':'来源：工作区保存的连接'}</span><span>{current.updated_at?'更新于 '+new Date(current.updated_at).toLocaleString('zh-CN'):'保存后使用加密凭据存储'}</span></div>
      </>:!data.error?<div className="model-empty"><KeyRound size={25}/><strong>还没有分析模型连接</strong><p>添加你自己的 API Key 和模型。监控、查看历史记录与本机定位不依赖这份密钥。</p><button className="button" disabled={!settings} onClick={()=>setEditor(settings)}><Plus size={14}/>添加第一个连接</button></div>:null}
    </section>
    <div className="model-settings-notes"><section><h2>配置后如何使用</h2><ol><li>打开某次 Run，进入“原因分析”。</li><li>完成本机异常定位，核对发送预览。</li><li>确认连接、模型和证据后，手动发送。</li></ol><Link to="/">返回运行工作台<ArrowUpRight size={13}/></Link></section><section><h2>凭据与调用范围</h2><p>密钥不回填、不写入浏览器持久存储，也不进入诊断报告。{settings?.protection==='windows_user_encryption'?'本机加密密钥受 Windows 用户保护。':'服务端文件加密并限制文件访问权限。'}</p><p>保存配置不验证连接、不产生模型调用。更换配置后，旧发送预览失效。模型费用由该连接的服务商账户承担。</p><details><summary>团队共用与兼容范围</summary><p>当前是本地工作区配置，尚无账户级私有凭据隔离。共用同一后端时应明确团队共享范围。本版仅支持 OpenAI-compatible Chat Completions，不包含原生 Anthropic 或 Responses 协议。</p></details></section></div>
    {editor&&<ConnectionDialog settings={editor} onSaved={saved} onClose={()=>setEditor(null)}/>}{deleting&&<DeleteDialog settings={settings||recovery} onDeleted={()=>{setDeleting(false);setFeedback('连接已删除。重新配置前不会调用原因分析模型。');setRevision(value=>value+1);}} onClose={()=>setDeleting(false)}/>}
  </div>;
}

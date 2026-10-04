import {useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {Check,Copy,Hash,Maximize2,WrapText,X} from 'lucide-react';
import './run-controls.css';

interface Choice<T extends string>{value:T;label:string;title?:string;disabled?:boolean}
// Preserve the existing view state; this component only supplies control behaviour.
export function SegmentedControl<T extends string>({label,value,options,onChange,className=''}:{label:string;value:T;options:Choice<T>[];onChange:(value:T)=>void;className?:string}){
  const ref=useRef<HTMLSpanElement>(null);
  return <span ref={ref} className={'control-segment '+className} role="group" aria-label={label}>
    {options.map(option=><button key={option.value} type="button" disabled={option.disabled} title={option.title} aria-pressed={value===option.value}
      tabIndex={value===option.value?0:-1} onClick={()=>onChange(option.value)} onKeyDown={event=>{
        if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
        event.preventDefault();const enabled=options.filter(item=>!item.disabled),index=enabled.findIndex(item=>item.value===option.value);
        const next=enabled[event.key==='Home'?0:event.key==='End'?enabled.length-1:(index+(event.key==='ArrowLeft'?-1:1)+enabled.length)%enabled.length];
        if(next){onChange(next.value);ref.current?.querySelectorAll<HTMLButtonElement>('button')[options.indexOf(next)]?.focus();}
      }}>{option.label}</button>)}
  </span>;
}

function ExpandedCode({label,children,close}:{label:string;children:ReactNode;close:()=>void}){
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const trigger=document.activeElement as HTMLElement|null;const node=ref.current;node?.showModal();return()=>{node?.close();if(trigger?.isConnected)trigger.focus({preventScroll:true});};},[]);
  return <dialog ref={ref} className="code-dialog" aria-label={'展开阅读 '+label} onCancel={event=>{event.preventDefault();close();}} onClick={event=>{if(event.target===event.currentTarget)close();}}>
    <div className="code-dialog-heading"><strong>{label}</strong><span>只读内容</span><button type="button" aria-label="关闭展开阅读" onClick={close}><X size={18}/></button></div>{children}
  </dialog>;
}

// Presentation is read-only. Copy exactly the displayed string, without line numbers.
export function CodeViewer({text,label,className=''}:{text:string;label:string;className?:string}){
  const lines=useMemo(()=>text.split('\n'),[text]);
  const [wrap,setWrap]=useState(true),[numbers,setNumbers]=useState(false),[expanded,setExpanded]=useState(false);
  const [copy,setCopy]=useState<'idle'|'done'|'error'>('idle');const version=useRef(0);
  useEffect(()=>{version.current++;setCopy('idle');setExpanded(false);return()=>{version.current++;};},[text]);
  useEffect(()=>{if(copy!=='done')return;const timer=window.setTimeout(()=>setCopy('idle'),2000);return()=>window.clearTimeout(timer);},[copy]);
  async function copyText(){const request=version.current;try{await navigator.clipboard.writeText(text);if(request===version.current)setCopy('done');}catch{if(request===version.current)setCopy('error');}}
  function content(large=false){return <div className={'code-viewer'+(wrap?' wrap':'')+(numbers?' numbered':'')} role="group" aria-label={label+' 阅读工具'}>
    <div className="code-toolbar"><span className="code-line-count">{lines.length.toLocaleString()} 行</span><span className="code-actions">
      <button type="button" aria-label="自动换行" aria-pressed={wrap} title="自动换行，不改变原文" onClick={()=>setWrap(value=>!value)}><WrapText size={14}/><span>换行</span></button>
      <button type="button" aria-label="显示行号" aria-pressed={numbers} title="显示行号" onClick={()=>setNumbers(value=>!value)}><Hash size={14}/></button>
      <button type="button" aria-label={copy==='done'?'已复制内容':'复制内容'} title={copy==='done'?'已复制':'复制当前展示内容'} onClick={()=>void copyText()}>{copy==='done'?<Check size={14}/>:<Copy size={14}/>}</button>
      {!large&&<button type="button" aria-label="展开阅读" title="展开阅读" onClick={()=>setExpanded(true)}><Maximize2 size={14}/></button>}
    </span></div>
    {copy==='error'&&<p className="code-copy-error" role="alert">未能复制，请选择文本手动复制。<button type="button" onClick={()=>void copyText()}>重试</button></p>}
    <pre className={'code-content '+className}><code>{lines.map((line,index)=><span className="code-line" key={index}>{numbers&&<span className="code-line-number" aria-hidden="true">{index+1}</span>}<span className="code-line-text">{line||'\u200B'}</span>{index<lines.length-1?'\n':null}</span>)}</code></pre>
    <span className="code-feedback" aria-live="polite" aria-atomic="true">{copy==='done'?'已复制内容':''}</span>
  </div>;}
  return <>{content()}{expanded&&<ExpandedCode label={label} close={()=>setExpanded(false)}>{content(true)}</ExpandedCode>}</>;
}

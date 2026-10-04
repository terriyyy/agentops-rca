import {useRef,type CSSProperties,type PointerEvent} from 'react';
import {rowFailure,type TraceRow} from './trace-model';
import './run-interactions.css';

export type TracePreferences={preset:'steps'|'all';query:string;kind:string;onlyErrors:boolean;tree:boolean;timeScope:'page'|'run';width:number};
const defaults:TracePreferences={preset:'steps',query:'',kind:'',onlyErrors:false,tree:true,timeScope:'page',width:60};
const key=(id:string)=>'agentops.trace-view.'+id;
export function readTracePreferences(id:string):TracePreferences {
  try {
    const value=JSON.parse(sessionStorage.getItem(key(id))||'{}');
    return {preset:value.preset==='all'?'all':'steps',query:typeof value.query==='string'?value.query.slice(0,500):'',kind:['','tool','llm','log','event'].includes(value.kind)?value.kind:'',onlyErrors:value.onlyErrors===true,tree:value.tree!==false,timeScope:value.timeScope==='run'?'run':'page',width:typeof value.width==='number'&&Number.isFinite(value.width)?Math.max(35,Math.min(75,value.width)):60};
  } catch {return {...defaults};}
}
export function saveTracePreferences(id:string,value:TracePreferences){try{sessionStorage.setItem(key(id),JSON.stringify(value));}catch{/* A blocked browser store does not prevent investigation. */}}
export function isExecutionStep(row:TraceRow){return row.events.some(event=>event.kind!=='log')||rowFailure(row);}
export function splitStyle(width:number,minDetail=310):CSSProperties{return {'--trace-width':width+'%','--detail-min':minDetail+'px'} as CSSProperties;}

// Preview the split directly in the DOM while dragging; commit once on release.
export function TraceDivider({width,onChange,minDetail=310}:{width:number;onChange:(value:number)=>void;minDetail?:number}){
  const drag=useRef<{start:number;width:number;value:number;total:number;min:number;max:number}|null>(null);
  function start(event:PointerEvent<HTMLDivElement>){
    if(event.button!==0)return;
    const total=event.currentTarget.parentElement!.getBoundingClientRect().width;
    drag.current={start:event.clientX,width,value:width,total,min:Math.max(35,440/total*100),max:Math.min(75,100-minDetail/total*100)};
    event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault();
  }
  function finish(event:PointerEvent<HTMLDivElement>,cancel=false){
    const state=drag.current;if(!state)return;drag.current=null;
    const value=cancel?state.width:state.value;
    event.currentTarget.parentElement!.style.setProperty('--trace-width',value+'%');onChange(value);
  }
  return <div className="trace-divider" role="separator" aria-label="调整轨迹与详情宽度" aria-orientation="vertical" title="拖动调整分栏；左右键微调，Home 恢复默认宽度" aria-valuemin={35} aria-valuemax={75} aria-valuenow={Math.round(width)} tabIndex={0}
    onPointerDown={start} onPointerMove={event=>{const state=drag.current;if(!state)return;state.value=Math.max(state.min,Math.min(state.max,state.width+(event.clientX-state.start)/state.total*100));event.currentTarget.parentElement!.style.setProperty('--trace-width',state.value+'%');}}
    onPointerUp={event=>finish(event)} onPointerCancel={event=>finish(event,true)} onLostPointerCapture={event=>finish(event)}
    onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home'].includes(event.key)){event.preventDefault();const total=event.currentTarget.parentElement!.getBoundingClientRect().width;const min=Math.max(35,440/total*100),max=Math.min(75,100-minDetail/total*100);onChange(Math.max(min,Math.min(max,event.key==='Home'?60:width+(event.key==='ArrowRight'?2:-2))));}}}/>;
}

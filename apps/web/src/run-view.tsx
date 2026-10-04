import {createContext,useContext,useEffect,useId,useRef,useState,type ToggleEvent} from 'react';
import {ArrowLeftToLine,Check,ChevronDown,Expand,Settings2} from 'lucide-react';
import {SegmentedControl} from './run-controls';
import './run-view.css';

type Density='comfortable'|'compact';
interface RunView{density:Density;setDensity:(value:Density)=>void;focus:boolean;setFocus:(value:boolean)=>void}
const preferenceKey='agentops.run-reading';
function readDensity():Density{try{return sessionStorage.getItem(preferenceKey)==='compact'?'compact':'comfortable';}catch{return 'comfortable';}}
export const RunViewContext=createContext<RunView|null>(null);
export function useRunViewState():RunView{
  const [density,setDensity]=useState<Density>(readDensity),[focus,setFocus]=useState(false);
  useEffect(()=>{try{sessionStorage.setItem(preferenceKey,density);}catch{/* View controls work when browser storage is unavailable. */}},[density]);
  return {density,setDensity,focus,setFocus};
}
export function useRunView(){const context=useContext(RunViewContext);if(!context)throw new Error('Run view requires the workspace context');return context;}

export function RunViewControls(){
  const view=useRunView(),id=useId(),panel=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const [open,setOpen]=useState(false);
  function position(){const button=trigger.current,node=panel.current;if(!button||!node)return;const box=button.getBoundingClientRect();node.style.setProperty('--view-popover-left',Math.max(12,Math.min(box.right-node.offsetWidth,window.innerWidth-node.offsetWidth-12))+'px');node.style.setProperty('--view-popover-top',Math.max(12,Math.min(box.bottom+8,window.innerHeight-node.offsetHeight-12))+'px');}
  useEffect(()=>{if(!open)return;position();window.addEventListener('resize',position);window.addEventListener('scroll',position,true);return()=>{window.removeEventListener('resize',position);window.removeEventListener('scroll',position,true);};},[open,view.focus,view.density]);
  function close(restore=false){panel.current?.hidePopover();if(restore)trigger.current?.focus({preventScroll:true});}
  function toggleFocus(){view.setFocus(!view.focus);close(true);}
  function toggled(event:ToggleEvent<HTMLDivElement>){const opening=event.newState==='open';setOpen(opening);if(opening){position();panel.current?.querySelector<HTMLButtonElement>('[aria-pressed=true]')?.focus({preventScroll:true});}}
  return <span className="run-view-controls">
    {view.focus&&<button type="button" className="trace-control focus-exit" onClick={()=>{view.setFocus(false);queueMicrotask(()=>trigger.current?.focus({preventScroll:true}));}} title="恢复导航，保留当前调查位置"><ArrowLeftToLine size={14}/>退出专注</button>}
    <button ref={trigger} type="button" className="trace-control view-settings-trigger" aria-label="视图设置" aria-expanded={open} aria-controls={id} aria-haspopup="dialog" popoverTarget={id}><Settings2 size={14}/>视图<ChevronDown size={12}/></button>
    <div ref={panel} id={id} popover="auto" className="run-view-popover" role="dialog" aria-label="运行视图设置" onToggle={toggled}
      onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);}}}>
      <div className="view-popover-heading"><Settings2 size={14}/><strong>视图设置</strong></div>
      <div className="view-density"><label>阅读密度</label><SegmentedControl label="阅读密度" value={view.density} options={[{value:'comfortable',label:'舒适'},{value:'compact',label:'紧凑'}]} onChange={view.setDensity}/><p>{view.density==='comfortable'?'更宽松的行距，适合阅读和调查。':'同屏查看更多步骤，保留可读字号。'}</p></div>
      <button className="view-focus-option" type="button" aria-label="专注模式" aria-pressed={view.focus} onClick={toggleFocus}><Expand size={15}/><span><strong>专注模式</strong><small>收起导航，扩大调查空间</small></span>{view.focus&&<Check size={14}/>}</button>
      <span className="view-preference-note">阅读密度在本次浏览器会话中保留</span>
    </div>
  </span>;
}

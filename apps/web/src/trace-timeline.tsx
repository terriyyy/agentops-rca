import {useState} from 'react';
import {ChevronLeft,ChevronRight,LocateFixed,Maximize2,Minus,Plus} from 'lucide-react';
import {callInterval,durationLabel,eventTime,rowPrimary,timelineTicks,type TraceRow} from './trace-model';

interface TimeView {start:number;end:number}
const clamp=(value:number,min:number,max:number)=>Math.min(Math.max(value,min),max);

// Only the viewport changes. Coordinates always remain linear source timestamps.
export function useTimelineView(start:number|null,end:number|null,key:string) {
  const [state,setState]=useState<{key:string;view:TimeView|null}>({key,view:null});
  const base={start:start??0,end:end??0},range=base.end-base.start;
  function bound(view:TimeView):TimeView {
    if(range<=0)return base;
    const length=clamp(view.end-view.start,Math.min(range,Math.max(1,range/128)),range);
    const left=clamp(view.start,base.start,base.end-length);
    return {start:left,end:left+length};
  }
  const view=state.key===key&&state.view?bound(state.view):base;
  const length=view.end-view.start,zoom=length>0?range/length:1;
  function zoomBy(factor:number,time?:number) {
    if(range<=0)return;
    const fraction=time!==undefined&&time>=view.start&&time<=view.end?(time-view.start)/length:.5;
    const anchor=view.start+fraction*length,newLength=length/factor;
    setState({key,view:bound({start:anchor-fraction*newLength,end:anchor+(1-fraction)*newLength})});
  }
  function focus(row:TraceRow) {
    const interval=row.kind==='tool_span'?callInterval(row.call,row.returned):null;
    const time=eventTime(rowPrimary(row));if(time===null||range<=0)return;
    const center=interval?(interval.start+interval.end)/2:time;
    const extent=Math.max(interval?(interval.end-interval.start)*1.5:0,range/32,1);
    setState({key,view:bound({start:center-extent/2,end:center+extent/2})});
  }
  return {...view,zoom,zoomBy,focus,fit:()=>setState({key,view:null}),
    pan:(direction:number)=>setState({key,view:bound({start:view.start+direction*length*.5,end:view.end+direction*length*.5})}),
    canPanLeft:view.start>base.start+.5,canPanRight:view.end<base.end-.5};
}
export type TimelineView=ReturnType<typeof useTimelineView>;
export type TimelineTick=ReturnType<typeof timelineTicks>[number];

export function TimelineNavigation({view,selected}:{view:TimelineView;selected:TraceRow|null}) {
  const selectedTime=selected?eventTime(rowPrimary(selected)):null;
  return <span className="timeline-navigation" role="group" aria-label="时间轴导航">
    <button aria-label="时间窗向前" title="向前移动半个时间窗" disabled={!view.canPanLeft} onClick={()=>view.pan(-1)}><ChevronLeft size={14}/></button>
    <button aria-label="缩小时间轴" title="缩小" disabled={view.zoom<=1.001} onClick={()=>view.zoomBy(.5)}><Minus size={14}/></button>
    <span className="timeline-zoom" title="当前时间窗的放大倍数">{Number(view.zoom.toFixed(1))}×</span>
    <button aria-label="放大时间轴" title="放大；选中步骤可见时以其为锚点" disabled={view.zoom>=127.9} onClick={()=>view.zoomBy(2,selectedTime??undefined)}><Plus size={14}/></button>
    <button aria-label="时间窗向后" title="向后移动半个时间窗" disabled={!view.canPanRight} onClick={()=>view.pan(1)}><ChevronRight size={14}/></button>
    <span className="timeline-nav-divider" aria-hidden="true"/>
    <button aria-label="适配时间范围" title="恢复本页或整轮完整时间范围" onClick={view.fit}><Maximize2 size={13}/></button>
    <button aria-label="聚焦选中步骤时间" title="聚焦选中步骤的真实时间；也可双击步骤" disabled={!selected||selectedTime===null} onClick={()=>selected&&view.focus(selected)}><LocateFixed size={14}/></button>
  </span>;
}

export function TimelineRuler({ticks,view}:{ticks:TimelineTick[];view:TimelineView}) {
  return <div className="time-ruler" aria-label="相对时间刻度" data-view-start={view.start} data-view-end={view.end}>
    {ticks.map(tick=><span className={'ruler-tick'+(tick.percent<8?' first':'')+(tick.percent>88?' last':'')} style={{left:tick.percent+'%'}} key={tick.offset}><span>{tick.label}</span></span>)}
  </div>;
}

// One continuous grid behind every row, including expanded failure context.
export function TimelineGrid({ticks}:{ticks:TimelineTick[]}) {
  return <div className="timeline-guides" aria-hidden="true"><span/><div className="timeline-guides-axis">{ticks.map(tick=><span className="timeline-gridline" style={{left:tick.percent+'%'}} key={tick.offset}/>)}</div><span/></div>;
}

export function TimelineMark({row,view,origin,failed}:{row:TraceRow;view:TimelineView;origin:number|null;failed:boolean}) {
  const time=eventTime(rowPrimary(row)),range=view.end-view.start;
  const interval=row.kind==='tool_span'?callInterval(row.call,row.returned):null;
  if(time===null||range<=0)return <div className="event-timing"><span className="missing-time" title="来源未提供可靠时间">—</span></div>;
  const end=interval?.end??time,start=interval?.start??time;
  const outside=end<view.start?'before':start>view.end?'after':null;
  const title=interval?`起点 +${durationLabel(start-(origin??start))} · 区间 ${durationLabel(end-start)} · 明确关联的调用至返回`:`+${durationLabel(time-(origin??time))} · 仅来源事件时刻；未推断持续时间`;
  const left=clamp((start-view.start)/range*100,0,100);
  const width=(Math.min(end,view.end)-Math.max(start,view.start))/range*100;
  return <div className={'event-timing type-'+(row.kind==='tool_span'?'span':rowPrimary(row).kind)} title={title} data-timeline-kind={interval?'span':'point'}>
    {outside?<span className={'timeline-offscreen '+outside+(failed?' failed':'')} title={outside==='before'?'位于当前时间窗之前；双击步骤聚焦':'位于当前时间窗之后；双击步骤聚焦'}>{outside==='before'?<ChevronLeft size={14}/>:<ChevronRight size={14}/>}</span>
      :interval?<span className={'duration-bar'+(failed?' failed':'')} data-clipped-start={start<view.start||undefined} data-clipped-end={end>view.end||undefined} style={{left:left+'%',width:Math.max(0,width)+'%'}}/>
      :<span className={'time-point'+(failed?' failed':'')} style={{left:`clamp(4px, ${left}%, calc(100% - 4px))`}}/>}
  </div>;
}

export function TraceBranch({depth,guides,last}:{depth:number;guides:boolean[];last:boolean}) {
  const visibleDepth=Math.min(depth,6);if(!visibleDepth)return null;
  return <span className="trace-tree-branch" style={{width:visibleDepth*14}} aria-hidden="true" title={depth>6?`来源层级深度 ${depth}`:undefined}>
    {Array.from({length:visibleDepth-1},(_,index)=>guides[index]&&<i className="tree-continuation" key={index} style={{left:index*14+6}}/>)}
    <i className={'tree-elbow'+(last?' last':'')} style={{left:(visibleDepth-1)*14+6}}/>
  </span>;
}

export function TraceType({row}:{row:TraceRow}) {
  const event=rowPrimary(row),type=row.kind==='tool_span'?'SPAN':({tool_call:'CALL',tool_return:'RETURN',llm:'LLM',log:'LOG',verification:'CHECK',agent:'AGENT'} as Record<string,string>)[event.kind]||'EVENT';
  return <span className={'trace-type type-'+(row.kind==='tool_span'?'span':event.kind)} title={row.kind==='tool_span'?'Tool Execution · 明确关联的调用和返回':event.kind}>{type}</span>;
}

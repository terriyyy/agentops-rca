import {useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {AlertCircle,Check,ChevronDown,ClipboardCheck,FileJson,Loader2,X} from 'lucide-react';
import type {Run} from './api';
import {
  editableSections,feedbackStateNames,sectionOrder,useFeedback,
  type FeedbackRecord,type FeedbackSection,type SectionKey,
} from './feedback';
import './feedback-panel.css';

const timeLabel=(iso?:string|null)=>iso?new Date(iso).toLocaleString('zh-CN'):'—';
const short=(value:unknown,n=12)=>{const text=String(value??'');return text.length>n?text.slice(0,n)+'…':text;};

const sectionStatusNames:Record<string,string>={
  no_diagnosis:'未选择诊断 · 仅基于失败事实',hypothesis:'待验证假设',
  from_diagnosis:'来自诊断建议',placeholder:'诊断未提供具体指导',
};

function IndexItems({section}:{section:FeedbackSection}) {
  const items=section.items||[];
  if(!items.length)return null;
  const metaKeys=['severity','resolution_status','source','position','basis','summary','error_signature','detail','description','exit_code','event_id','evidence_id'];
  return <ul className="feedback-index" aria-label="自动生成的事实索引（不可通过编辑删除）">
    {items.map((item,index)=>{
      const kind=String(item.type||item.kind||'item');
      const title=String(item.title??item.label??('条目 '+(index+1)));
      const metas=metaKeys.filter(key=>item[key]!==undefined&&item[key]!==null&&item[key]!=='')
        .map(key=><span key={key}><em>{key}</em>{String(item[key]).slice(0,180)}</span>);
      return <li key={index}>
        <span className={'feedback-index-badge kind-'+kind}>{kind==='check_failure'?'任务检查失败':kind==='tool_failure'?'工具失败':kind==='execution_error'?'执行异常':kind==='rerun_original'?'重跑原检查':kind}</span>
        <strong title={title}>{title}</strong>
        {!!metas.length&&<small>{metas}</small>}
      </li>;
    })}
  </ul>;
}

function SectionCard({record,sectionKey,busy,onSave}:{record:FeedbackRecord;sectionKey:SectionKey;busy:boolean;onSave:(key:SectionKey,text:string)=>void}) {
  const section=record.sections[sectionKey];
  const editable=record.state==='draft'&&editableSections.includes(sectionKey);
  const [text,setText]=useState(section.text);
  useEffect(()=>setText(section.text),[section.text,record.feedback_id]);
  const dirty=text!==section.text;
  return <section className="feedback-section">
    <div className="feedback-section-head"><strong>{section.title}</strong>{section.status&&<span className="feedback-section-status">{sectionStatusNames[section.status]||section.status}</span>}</div>
    {editable?<>
      <textarea className="feedback-section-input" value={text} maxLength={8000} aria-label={'编辑'+section.title} onChange={e=>setText(e.target.value)}/>
      <div className="feedback-section-tools"><span className="feedback-char-count">{text.length}/8000</span><button className="text-button" disabled={!dirty||busy} onClick={()=>onSave(sectionKey,text)}>保存本段修改</button></div>
    </>:<p className="feedback-section-text">{section.text}</p>}
    <IndexItems section={section}/>
  </section>;
}

function QualityLedger({record}:{record:FeedbackRecord}) {
  const t=record.truncation;
  const has=!!(t.items.length||t.omissions.length||record.redaction.matches||record.data_quality.length||record.unresolved_refs.length);
  if(!has)return <p className="feedback-quality-clear"><Check size={13}/>无截断、脱敏告警或未解析引用。</p>;
  return <details className="feedback-quality"><summary><AlertCircle size={13}/>内容处理留痕{record.redaction.matches?` · 脱敏 ${record.redaction.matches} 处`:''}{t.items.length?` · 截断 ${t.items.length} 项`:''}{record.unresolved_refs.length?` · 未解析引用 ${record.unresolved_refs.length}`:''}</summary>
    {!!record.data_quality.length&&<div className="feedback-quality-group"><strong>数据质量</strong><ul>{record.data_quality.map((q,i)=><li key={i}>{q}</li>)}</ul></div>}
    {!!t.items.length&&<div className="feedback-quality-group"><strong>截断条目</strong><ul>{t.items.map((item,i)=><li key={i}>{item.section}.{item.field}：{item.original_bytes}→{item.kept_bytes} 字节（{item.reason}）</li>)}</ul></div>}
    {!!t.omissions.length&&<div className="feedback-quality-group"><strong>省略条目</strong><ul>{t.omissions.map((item,i)=><li key={i}><code>{String(item.kind)}</code> {JSON.stringify(item)}</li>)}</ul></div>}
    {!!record.unresolved_refs.length&&<div className="feedback-quality-group"><strong>未解析引用（仅供线索，非已证实证据）</strong><ul>{record.unresolved_refs.map((item,i)=><li key={i}>{String(item.label||item.evidence_id||JSON.stringify(item))}</li>)}</ul></div>}
  </details>;
}

export function FeedbackPanel({run,diagnosisId}:{run:Run;diagnosisId?:string|null}) {
  const model=useFeedback(run);
  const [linkDiagnosis,setLinkDiagnosis]=useState(Boolean(diagnosisId));
  useEffect(()=>{if(diagnosisId)setLinkDiagnosis(true);},[diagnosisId]);
  const [confirmArmed,setConfirmArmed]=useState(false);
  const [cancelOpen,setCancelOpen]=useState(false);
  const [cancelReason,setCancelReason]=useState('');
  const record=model.selected;
  useEffect(()=>{setConfirmArmed(false);setCancelOpen(false);setCancelReason('');},[record?.feedback_id]);
  const diagnosisRef=record?.source_diagnosis_id?short(record.source_diagnosis_id,16):null;

  return <section className="feedback-panel" aria-label="下一轮修复反馈">
    <div className="feedback-heading"><ClipboardCheck size={16}/><div><span>RCA 反馈</span><strong>下一轮修复反馈</strong></div><small>六段结构 · 人工预览编辑 · 哈希锁定</small></div>

    {model.loading&&<p className="feedback-loading"><Loader2 size={15} className="spin"/>读取反馈记录…</p>}
    {model.error&&<p className="feedback-error" role="alert">{model.error}</p>}

    {!model.loading&&<>
      <div className="feedback-compose">
        <label className="feedback-diagnosis-option">
          <input type="checkbox" checked={Boolean(linkDiagnosis&&diagnosisId)} disabled={!diagnosisId}
            onChange={e=>setLinkDiagnosis(e.target.checked)}/>
          {diagnosisId?<>关联当前查看的诊断报告 <code>{short(diagnosisId,12)}</code>（RCA 段引用其结论，仍标注待验证）</>:<>当前无可关联的诊断报告；草稿将仅基于失败事实生成（RCA 候选原因留空待排查）</>}
        </label>
        <button className="button secondary" disabled={model.busy||!model.eligible} onClick={()=>void model.create(linkDiagnosis&&diagnosisId?diagnosisId:null)}>
          {model.records.length?'生成新的反馈草稿':'生成反馈草稿'}
        </button>
        {!model.eligible&&<p className="feedback-hint">执行结束且状态明确后，才能生成反馈。</p>}
        {model.eligible&&!model.hasFailureSignals&&<p className="feedback-hint">当前未发现失败事实（执行异常、失败工具或失败任务检查）；若无失败事实，平台将拒绝生成。</p>}
      </div>

      {!!model.records.length&&<>
        <div className="feedback-tabs" role="tablist" aria-label="反馈记录">
          {model.records.map(item=><button key={item.feedback_id} role="tab" aria-selected={record?.feedback_id===item.feedback_id}
            className={'feedback-tab state-'+item.state+(record?.feedback_id===item.feedback_id?' active':'')}
            onClick={()=>model.select(item.feedback_id)}>
            <span className="feedback-tab-dot"/>
            {feedbackStateNames[item.state]}<time>{timeLabel(item.created_at)}</time>
          </button>)}
        </div>

        {record&&<div className="feedback-detail">
          <div className="feedback-statusbar">
            <span className={'feedback-state-badge state-'+record.state}>{feedbackStateNames[record.state]}</span>
            <span>来源 <code>{record.iteration_source}</code></span>
            {diagnosisRef&&<span>诊断 <code>{diagnosisRef}</code></span>}
            <span>创建 {timeLabel(record.created_at)}</span>
            {record.confirmed_at&&<span>确认 {timeLabel(record.confirmed_at)}</span>}
            {record.cancelled_at&&<span>取消 {timeLabel(record.cancelled_at)}</span>}
          </div>

          {record.state==='confirmed'&&<div className="feedback-banner confirmed">
            <Check size={15}/><div><strong>内容已哈希锁定并固化为平台只读证据</strong>
              {record.content_ref&&<span>证据文件 <code>{record.content_ref.filename}</code></span>}
              {record.to_run_id
                ?<Link to={'/runs/'+record.to_run_id}>查看接续执行的 Run<ChevronDown size={12}/></Link>
                :<span>P2 投递通道尚未上线：该反馈暂不会投递给任何 Agent，也不会启动执行或模型调用。</span>}
            </div>
          </div>}
          {record.state==='cancelled'&&<div className="feedback-banner cancelled"><X size={15}/><div><strong>此反馈已取消，不会投递</strong>{record.cancel_reason&&<span>原因：{record.cancel_reason}</span>}</div></div>}

          {sectionOrder.map(key=><SectionCard key={key} record={record} sectionKey={key} busy={model.busy} onSave={(sectionKey,text)=>void model.saveEdit(record.feedback_id,sectionKey,text)}/>)}

          <QualityLedger record={record}/>

          <details className="feedback-rendered"><summary><FileJson size={13}/>实际投递正文预览（六段拼接，含自动索引）</summary><pre>{record.rendered_text}</pre></details>

          <dl className="feedback-hash"><dt>Content SHA-256</dt><dd>{record.content_sha256}</dd><dt>From Run Snapshot</dt><dd>{record.from_run_snapshot_hash??'—'}</dd>{Boolean(record.delivery)&&<><dt>Delivery（P2 写入）</dt><dd><code>{JSON.stringify(record.delivery)}</code></dd></>}</dl>

          {record.state==='draft'&&<div className="feedback-actions">
            {!confirmArmed?<>
              <p>确认后六段内容按当前预览哈希锁定，固化为只读证据（artifact + evidence）；在 P2 投递通道上线前，确认<b>不会</b>启动 Agent 或产生模型调用。</p>
              <div className="feedback-action-buttons">
                <button className="button primary" disabled={model.busy} onClick={()=>setConfirmArmed(true)}>确认锁定反馈内容</button>
                {!cancelOpen?<button className="text-button" disabled={model.busy} onClick={()=>setCancelOpen(true)}>取消此草稿</button>:
                  <span className="feedback-cancel-form"><input aria-label="取消原因（可选）" placeholder="取消原因（可选，200 字以内）" maxLength={200} value={cancelReason} onChange={e=>setCancelReason(e.target.value)}/>
                    <button className="button secondary" disabled={model.busy} onClick={()=>void model.cancel(record.feedback_id,cancelReason)}>确认取消</button>
                    <button className="text-button" onClick={()=>{setCancelOpen(false);setCancelReason('');}}>返回</button></span>}
              </div>
            </>:<div className="feedback-confirm-arm">
              <AlertCircle size={15}/><div><strong>最终确认：锁定后文本不可再修改</strong><span>仍可在确认后取消并重新生成草稿；取消不会产生后续执行。</span></div>
              <button className="button primary" disabled={model.busy} onClick={()=>void model.confirm(record)}>再次点击 · 确认锁定</button>
              <button className="text-button" disabled={model.busy} onClick={()=>setConfirmArmed(false)}>返回检查内容</button>
            </div>}
          </div>}

          {record.state==='confirmed'&&<div className="feedback-actions">
            {!cancelOpen?<div className="feedback-action-buttons">
              <button className="text-button" disabled={model.busy} onClick={()=>setCancelOpen(true)}>取消此反馈（将删除其固化证据）</button>
            </div>:<span className="feedback-cancel-form"><input aria-label="取消原因（可选）" placeholder="取消原因（可选，200 字以内）" maxLength={200} value={cancelReason} onChange={e=>setCancelReason(e.target.value)}/>
              <button className="button secondary" disabled={model.busy} onClick={()=>void model.cancel(record.feedback_id,cancelReason)}>确认取消</button>
              <button className="text-button" onClick={()=>{setCancelOpen(false);setCancelReason('');}}>返回</button></span>}
          </div>}
        </div>}
      </>}
    </>}
  </section>;
}

import {GitBranch} from 'lucide-react';
import {Link} from 'react-router-dom';
import '@fontsource/dm-sans/latin-600.css';
import './brand.css';

export function Brand(){
  return <Link to="/" className="brand product-brand" aria-label="AgentOps RCA · 返回运行工作台" title="AgentOps RCA · 运行工作台"><span className="product-brand-mark" aria-hidden="true"><GitBranch size={21} strokeWidth={1.8}/></span><span className="product-brand-copy" aria-hidden="true"><span className="product-brand-name">Agent<span>Ops</span></span><span className="product-brand-caption"><span>RCA</span>工作台</span></span></Link>;
}

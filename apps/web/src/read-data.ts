import {useEffect,useState} from 'react';
import {api} from './api';

export function useData<T>(url:string,refresh=0){
  const [state,setState]=useState<{url:string;data:T|null;error:string;loading:boolean}>({url,data:null,error:'',loading:true});
  useEffect(()=>{const controller=new AbortController();setState(previous=>previous.url===url?({...previous,error:'',loading:previous.data===null}):({url,data:null,error:'',loading:true}));
    api<T>(url,{signal:controller.signal}).then(data=>setState({url,data,error:'',loading:false})).catch(error=>{if(error.name!=='AbortError')setState(previous=>({url,data:previous.url===url?previous.data:null,error:error.message,loading:false}));});
    return()=>controller.abort();
  },[url,refresh]);
  return state.url===url?state:{url,data:null,error:'',loading:true};
}

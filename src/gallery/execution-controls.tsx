import {Select} from "./select";
import {useState} from "react";
import {galleryTool} from "./hosted";

type Schedule = {interval_seconds?:number;cron?:string;timezone?:string;paused:boolean;next_run_at:number|null;request:{path:string;method:string;headers:[string,string][];body?:string}};
type Run = {id:string;revision:string;trigger:string;started_at:string;duration_ms:number|null;status:string;http_status:number|null};
const unpack=(value:unknown):any=>typeof value==="string"?JSON.parse(value):value;
export function ExecutionControls({workspace,name,kind="script"}:{workspace:string;name:string;kind?:"script"|"artifact"}) {
  const [schedule,setSchedule]=useState<Schedule|null>(null),[loaded,setLoaded]=useState(false);
  const [mode,setMode]=useState("interval"),[interval,setInterval]=useState("3600"),[cron,setCron]=useState("0 * * * *"),[timezone,setTimezone]=useState("UTC");
  const [path,setPath]=useState("/"),[method,setMethod]=useState("GET"),[headers,setHeaders]=useState("[]"),[body,setBody]=useState("");
  const [runs,setRuns]=useState<Run[]>([]),[logs,setLogs]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  async function perform(work:()=>Promise<void>) {setBusy(true);setError("");try{await work();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  async function control(action:string) {
    const request=action==="set"?{path,method,headers:JSON.parse(headers),...(body?{body:btoa(Array.from(new TextEncoder().encode(body),b=>String.fromCharCode(b)).join(""))}:{})}:undefined;
    const result=unpack(await galleryTool(workspace,`${kind}_schedule`,{name,action,...(action==="set"?{...(mode==="interval"?{interval_seconds:Number(interval)}:{cron,timezone}),request}:{})}));
    setSchedule(result.schedule);setLoaded(true);
    if(action==="get"&&result.schedule){const s=result.schedule as Schedule;setMode(s.cron?"cron":"interval");setInterval(String(s.interval_seconds??3600));setCron(s.cron??"0 * * * *");setTimezone(s.timezone??"UTC");setPath(s.request.path);setMethod(s.request.method);setHeaders(JSON.stringify(s.request.headers));setBody(s.request.body?new TextDecoder().decode(Uint8Array.from(atob(s.request.body),c=>c.charCodeAt(0))):"");}
  }
  return <>
    {error?<p role="alert">{error}</p>:null}
    <details><summary>Schedule</summary>
      <button disabled={busy} onClick={()=>void perform(()=>control("get"))}>Load schedule</button>
      {loaded?<p>{schedule?(schedule.paused?"Paused":`Next run: ${new Date(schedule.next_run_at!).toISOString()} (UTC)`):"No schedule configured"}</p>:null}
      <form onSubmit={event=>{event.preventDefault();void perform(()=>control("set"));}}>
        <label>Repeat <Select aria-label="Schedule mode" value={mode} onChange={e=>setMode(e.target.value)}><option value="interval">Interval</option><option value="cron">Cron</option></Select></label>
        {mode==="interval"?<label>Every (seconds) <input aria-label="Schedule interval" type="number" min="60" max="31536000" required value={interval} onChange={e=>setInterval(e.target.value)}/></label>:<><label>Cron <input aria-label="Schedule cron" required value={cron} onChange={e=>setCron(e.target.value)}/></label><label>Timezone <input aria-label="Schedule timezone" required value={timezone} onChange={e=>setTimezone(e.target.value)}/></label></>}
        <label>Method <Select aria-label="Schedule method" value={method} onChange={e=>setMethod(e.target.value)}>{["GET","POST","PUT","PATCH","DELETE","HEAD"].map(m=><option key={m}>{m}</option>)}</Select></label>
        <label>Path <input aria-label="Schedule path" required value={path} onChange={e=>setPath(e.target.value)}/></label>
        <label>Headers (JSON pairs) <textarea aria-label="Schedule headers" value={headers} onChange={e=>setHeaders(e.target.value)}/></label>
        <label>Body <textarea aria-label="Schedule body" value={body} onChange={e=>setBody(e.target.value)}/></label>
        <button disabled={busy}>Save schedule</button>
      </form>
      {schedule?<><button disabled={busy} onClick={()=>void perform(()=>control(schedule.paused?"resume":"pause"))}>{schedule.paused?"Resume schedule":"Pause schedule"}</button><button disabled={busy} onClick={()=>void perform(()=>control("run_now"))}>Run schedule now</button></>:null}
      <p>Runs the latest validated revision. Missed occurrences are skipped. Failed or interrupted runs require an explicit retry.</p>
    </details>
    <details><summary>Run history</summary>
      <button disabled={busy} onClick={()=>void perform(async()=>setRuns(unpack(await galleryTool(workspace,`${kind}_runs`,{name})).runs))}>Load runs</button>
      <p>HTTP-handler outcomes; background tasks and streamed response completion are separate. Latest 100 of up to 1,000 retained runs.</p>
      <table><thead><tr><th>Started (UTC)</th><th>Trigger</th><th>Status</th><th>HTTP</th><th>Duration</th><th>Revision</th>{kind==="script"?<th>Logs</th>:null}</tr></thead><tbody>{runs.map(run=><tr key={run.id}><td>{run.started_at}</td><td>{run.trigger}</td><td>{run.status}</td><td>{run.http_status??"—"}</td><td>{run.duration_ms===null?"—":`${run.duration_ms} ms`}</td><td title={run.revision}>{run.revision.slice(0,12)}</td>{kind==="script"?<td><button disabled={busy} onClick={()=>void perform(async()=>setLogs(JSON.stringify(unpack(await galleryTool(workspace,"script_logs",{name,run_id:run.id})),null,2)))}>View logs</button></td>:null}</tr>)}</tbody></table>
      {logs?<pre aria-label="Run logs">{logs}</pre>:null}
    </details>
  </>;
}

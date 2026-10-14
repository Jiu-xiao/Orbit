/** Experimental RMLink owner. Uses the public SDK; target execution stays in Connector.
 * SDK source in clients/rmlink is vendored from @rmlink/client 0.2.2 (Apache-2.0).
 */
import { RMLinkClient, CaptureSample, SubscriptionConfig } from '../../clients/rmlink/rmlink-client.mjs';
import type { SessionTargetOwner, SessionTargetConnectConfig, TargetChannelInfo } from './session-target-channel';
import type { CppJLinkResult, NativeStepIntoDiagnostics, NativeStepIntoSourceLineRequest, NativeStepOverDiagnostics, NativeStepOverRequest, NativeStepOutDiagnostics } from './cpp-jlink-channel';
import { NativeScheduler } from './native-scheduler';
import {readFile} from 'node:fs/promises';
import {parseElf32LoadSegments,resolveFlashTarget,CmsisDapFlashOptions,CmsisDapFlashResult,FlashTargetDefinition} from './cmsis-dap-flasher';

export class RMLinkTargetChannel implements SessionTargetOwner {
  readonly kind = 'cmsis-dap' as const;
  readonly supportsSubscriptions = true;
  flashTarget:FlashTargetDefinition|null=null;
  private readonly client: RMLinkClient;
  private readonly scheduler = new NativeScheduler();
  private connected = false;
  private readonly breakpoints = new Set<number>();
  private streamAbort: AbortController | null = null;
  private streamTask: Promise<void> | null = null;
  private readonly listeners = new Set<(sample: CaptureSample) => void>();
  private readonly rttData = new Map<number, Buffer>();
  private readonly rttIds = new Set<number>();
  private readonly activeCaptures=new Map<number,number>();
  private rttCacheDropped=0;
  constructor(client = new RMLinkClient()) { this.client = client; }
  get usingNative() { return this.connected; }
  async connect(config: SessionTargetConnectConfig): Promise<CppJLinkResult<TargetChannelInfo>> {
    if (!config.rmlinkDeviceId) return this.failure('rmlinkDeviceId required','InvalidConfiguration');
    try {
      await this.client.init(); await this.client.open(config.rmlinkDeviceId);
      await this.client.target('connect',{clock_hz: config.speedKHz ? config.speedKHz*1000 : 4000000});
      this.connected = true;
      this.flashTarget=resolveFlashTarget(config.device) || null;
      return this.success({channel:'cmsis-dap',diagnostics:{transport:'rmlink-service',subscriptions:true}});
    } catch (error) { await this.client.close().catch(()=>{}); return this.failure(String(error),'RMLinkConnectFailed'); }
  }
  private success<T>(data:T):CppJLinkResult<T> { return {ok:true,message:'RMLink',targetState:this.connected?'Unknown':'Disconnected',elapsedMs:0,data}; }
  private failure<T>(message:string,errorCode='UnsupportedCapability'):CppJLinkResult<T> { return {ok:false,message,errorCode,targetState:'Error',elapsedMs:0}; }
  private async control<T>(command:string,params:Record<string,unknown>={}):Promise<CppJLinkResult<T>> {
    if(!this.connected) return this.failure('RMLink owner unavailable','NativeOwnerLost');
    try { return await this.scheduler.schedule(async()=>this.success(await this.client.target<T>(command,params)),{priority:'control'}); }
    catch(error) {
      const response=error as {httpStatus?:number;errorCode?:string};
      if(response.httpStatus && response.httpStatus<500)return this.failure(String(error),response.errorCode || 'RMLinkRequestFailed');
      this.connected=false;return this.failure(String(error),'NativeOwnerLost');
    }
  }
  halt() { return this.control('halt'); }
  run() { return this.control('run'); }
  step() { return this.control('step'); }
  reset() { return this.control('reset'); }
  getState() { return this.control<{state:string}>('state'); }
  readRegister(index:number) { return this.control<{value:number}>('read_register',{index}); }
  async readMemory(address:number,size:number):Promise<CppJLinkResult<{bytes:Uint8Array}>> {
    const r=await this.control<{data:string}>('read_memory',{address,byte_length:size});
    return r.ok && r.data?{...r,data:{bytes:Buffer.from(r.data.data,'hex')}}:this.failure(r.message,r.errorCode);
  }
  async readMemoryBatch(reads:Array<{address:number;size:number}>):Promise<CppJLinkResult<{reads:Array<{address:number;bytes:Uint8Array}>}>> {
    const r=await this.control<{reads:Array<{address:number;data:string}>}>('read_batch',{reads:reads.map(r=>({address:r.address,byte_length:r.size}))});
    return r.ok && r.data?{...r,data:{reads:r.data.reads.map(v=>({address:v.address,bytes:Buffer.from(v.data,'hex')}))}}:this.failure(r.message,r.errorCode);
  }
  async writeMemory(address:number,bytes:Uint8Array):Promise<CppJLinkResult<{address:number;bytesWritten:number}>> {
    const r=await this.control<{bytes_written:number}>('write_memory',{address,data:Buffer.from(bytes).toString('hex')});
    return r.ok && r.data?{...r,data:{address,bytesWritten:r.data.bytes_written}}:this.failure(r.message,r.errorCode);
  }
  async setBreakpoint(address:number) {
    const r=await this.control<{id:number}>('set_breakpoint',{address});if(r.ok && r.data)this.breakpoints.add(r.data.id);return r;
  }
  async clearBreakpoint(id:number) { const r=await this.control('clear_breakpoint',{id});if(r.ok)this.breakpoints.delete(id);return r; }
  async clearAllBreakpoints() { for(const id of this.breakpoints){const r=await this.clearBreakpoint(id);if(!r.ok)return r;}return this.success({}); }
  async subscribe(kind:'memory_series'|'memory_snapshot'|'rtt_stream',config:SubscriptionConfig) {
    if(!this.connected)throw new Error('RMLink owner unavailable');
    const r=await this.client.subscribe(kind,config);
    this.activeCaptures.set(r.subscription_id,r.capture_id);
    if(!this.streamTask) {
      this.streamAbort=new AbortController();
      this.streamTask=(async()=>{
        try { for await(const record of this.client.stream({signal:this.streamAbort!.signal})) {
          const sample=record.sample;
          if(this.activeCaptures.get(sample.subscriptionId)!==sample.captureId)continue;
          if(sample.kind===3 && sample.data) {
            const channel=sample.channel || 0, previous=this.rttData.get(channel) || Buffer.alloc(0);
            const combined=Buffer.concat([previous,Buffer.from(sample.data)]);
            this.rttCacheDropped+=Math.max(0,combined.length-65536);
            this.rttData.set(channel,combined.subarray(-65536));
          }
          for(const listener of this.listeners) {
            try{listener(sample);}catch{this.listeners.delete(listener);}
          }
        } } catch(error) { if(!this.streamAbort?.signal.aborted)this.connected=false; }
      })();
    }
    return r;
  }
  onCapture(listener:(sample:CaptureSample)=>void) { this.listeners.add(listener);return ()=>this.listeners.delete(listener); }
  async unsubscribe(id:number) {
    await this.client.unsubscribe(id);this.activeCaptures.delete(id);
  }
  async startRtt(controlBlockAddress?:number) {
    if(controlBlockAddress===undefined)return this.failure('RTT control block address required','InvalidConfiguration');
    try {const r=await this.subscribe('rtt_stream',{control_block_address:controlBlockAddress});this.rttIds.add(r.subscription_id);return this.success({});}
    catch(error){return this.failure(String(error),'RMLinkRttFailed');}
  }
  async stopRtt() { for(const id of this.rttIds)await this.unsubscribe(id);this.rttIds.clear();this.rttData.clear();return this.success({}); }
  async readRtt(channel:number,size:number) { const data=this.rttData.get(channel)||Buffer.alloc(0);const bytes=data.subarray(0,size);this.rttData.set(channel,data.subarray(bytes.length));return this.success({bytes}); }
  async flash(elfPath:string,device:string,options:CmsisDapFlashOptions={}):Promise<CppJLinkResult<CmsisDapFlashResult>> {
    if(!this.connected)return this.failure('RMLink owner unavailable','NativeOwnerLost');
    try {
      const target=resolveFlashTarget(device);
      if(!target || target.algorithm!=='stm32f103c8')return this.failure('RMLink enhanced Flash supports registered F103C8 only','TargetMismatch');
      if(options.signal?.aborted)return this.failure('Flash cancelled','RequestCancelled');
      const segments=parseElf32LoadSegments(await readFile(elfPath)).filter(s=>s.fileSize>0);
      if(!segments.length || segments.some(s=>s.loadAddress<target.flashBase || s.loadAddress+s.fileSize>target.flashBase+target.flashSize))
        return this.failure('ELF contains unsupported load ranges','InvalidConfiguration');
      const begin=Math.floor(Math.min(...segments.map(s=>s.loadAddress))/1024)*1024;
      const end=Math.ceil(Math.max(...segments.map(s=>s.loadAddress+s.fileSize))/1024)*1024;
      const image=Buffer.alloc(end-begin,0xff);for(const segment of segments)image.set(segment.bytes,segment.loadAddress-begin);
      const cancel=()=>{void this.client.request('POST',`/sessions/${this.client.session}/flash`,{action:'cancel'}).catch(()=>{});};
      options.signal?.addEventListener('abort',cancel,{once:true});
      try {
        const result=await this.scheduler.schedule(()=>this.client.flashImage(image,begin,options.signal),{priority:'control'});
        this.breakpoints.clear();this.rttIds.clear();this.rttData.clear();
        this.activeCaptures.clear();
        return this.success({success:true,message:'RMLink service programmed and independently verified the image',
          reports:[],erasedSectors:target.sectors.filter(s=>s.address>=begin && s.address<end),target,diagnostics:result});
      }finally{options.signal?.removeEventListener('abort',cancel);}
    }catch(error){return this.failure(String(error),'OutcomeUnknown');}
  }
  async stepIntoInstruction():Promise<CppJLinkResult<NativeStepIntoDiagnostics>> {
    const begin=performance.now(),before=await this.readRegister(15);
    if(!before.ok || !before.data)return this.failure(before.message,before.errorCode);
    const step=await this.step();if(!step.ok)return this.failure(step.message,step.errorCode);
    const after=await this.readRegister(15);if(!after.ok || !after.data)return this.failure(after.message,after.errorCode);
    return this.success({pcBefore:before.data.value,pcAfter:after.data.value,classification:'instruction',instructions:1,cleanupOk:true,
      phase:'instruction',timings:{haltMs:0,readPcMs:0,decodeMs:0,executeMs:0,waitMs:0,cleanupMs:0,totalMs:performance.now()-begin}});
  }
  async stepIntoSourceLine(request:NativeStepIntoSourceLineRequest={}):Promise<CppJLinkResult<NativeStepIntoDiagnostics>> {
    const max=Math.min(256,Math.max(1,request.maxInstructionSteps||128));let first:number|undefined;
    for(let i=0;i<max;i++) {
      const step=await this.stepIntoInstruction();if(!step.ok || !step.data)return step;
      first??=step.data.pcBefore;const pc=step.data.pcAfter;
      if(request.lineStart===undefined || request.lineEnd===undefined || pc<request.lineStart || pc>=request.lineEnd)
        return {...step,data:{...step.data,pcBefore:first,instructions:i+1,phase:'sourceLine'}};
    }
    return this.failure('Source stepping exceeded the instruction budget','ExecutionDeadline');
  }
  async stepOverSourceLine(_request:NativeStepOverRequest={}):Promise<CppJLinkResult<NativeStepOverDiagnostics>> { return this.failure('Step-over decoding and temporary-breakpoint execution are pending'); }
  async stepOut():Promise<CppJLinkResult<NativeStepOutDiagnostics>> { return this.failure('Source stepping is pending'); }
  async disconnect() { await this.dispose();return this.success({}); }
  async dispose() {
    this.streamAbort?.abort();if(this.streamTask)await this.streamTask;
    await this.client.close().catch(()=>{});this.connected=false;this.scheduler.dispose();
    this.listeners.clear();this.rttData.clear();
    this.activeCaptures.clear();
  }
  getPerformanceDiagnostics() { return {transport:'rmlink-service',boardSubscriptions:true,rttCacheDroppedBytes:this.rttCacheDropped}; }
  getSchedulerSnapshot() { return {...this.scheduler.snapshot()}; }
}

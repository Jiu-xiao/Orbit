import {describe,it,expect,vi} from 'vitest';
import {DapSession} from './dap-session';

function backendModel() {
  const listeners:Array<(sample:any)=>void>=[],stops=vi.fn(async()=>{});
  const backend={supportsProbeSubscriptions:true,
    execute:vi.fn(async(c:any)=>({ok:true,data:c.cmd==='prepareFastDataSampling'?
      c.expressions.map((expression:string)=>({expression,spec:{expression,address:0x20000100,size:4}})): {}})),
    subscribeProbeSamples:vi.fn(async(_kind:any,_specs:any,_period:any,listener:any)=>{listeners.push(listener);return stops;}),
    dispose:async()=>{},
  };
  return {backend,listeners,stops};
}
const req=(seq:number,command:string,args:any)=>({type:'request' as const,seq,command,arguments:args});
describe('DAP RMLink probe subscriptions',()=>{
  it('Timeline accepts probe timestamps without launching host read loops and fences old callbacks',async()=>{
    const m=backendModel(),session=new DapSession(m.backend as any),s=session as any;
    s.phase='connected';s.setTargetRunning(true);
    try {
      await s.handleDataSamplingStart(req(1,'dataSamplingStart',{entries:[{expression:'counter'}],sampleIntervalMs:1}));
      expect(s.dataSamplingTimer).toBeNull();expect(m.backend.execute.mock.calls).toHaveLength(1);
      m.listeners[0]({values:[1],validBitmap:1,sequence:0,timestampUs:1000000n});
      m.listeners[0]({values:[2],validBitmap:1,sequence:1,timestampUs:1001000n});
      const pending=s.dataSamplingPending.get('counter');expect(pending).toHaveLength(2);
      expect(pending[1].timestamp-pending[0].timestamp).toBeCloseTo(1,5);
      await s.handleDataSamplingStop(req(2,'dataSamplingStop',{}));expect(m.stops).toHaveBeenCalledOnce();
      await s.handleDataSamplingStart(req(3,'dataSamplingStart',{entries:[{expression:'counter'}],sampleIntervalMs:1}));
      m.listeners[0]({values:[999],validBitmap:1,sequence:2,timestampUs:1002000n});
      expect(s.dataSamplingPending.get('counter')).toHaveLength(0);
    }finally{s.stopDataSampling();await s.probeSamplingCleanup;}
  });
  it('Watch consumes pushed values and marks invalid fields instead of reading the target again',async()=>{
    const m=backendModel(),session=new DapSession(m.backend as any),s=session as any;
    s.phase='connected';s.setTargetRunning(true);
    await s.handleWatchEvaluate(req(1,'watchEvaluate',{expressions:['counter']}));
    expect(m.backend.subscribeProbeSamples).toHaveBeenCalledWith('memory_snapshot',expect.any(Array),100000,expect.any(Function));
    m.listeners[0]({values:[123],validBitmap:1});
    expect(s.cachedOrRunningWatchValue('counter').value).toBe(123);
    await s.handleWatchEvaluate(req(2,'watchEvaluate',{expressions:['counter']}));
    expect(m.backend.execute).toHaveBeenCalledOnce();
    m.listeners[0]({values:[0],validBitmap:0});
    expect(s.cachedOrRunningWatchValue('counter').errorCode).toBe('RMLinkInvalidField');
    await s.probeWatchStop();
  });
  it('concurrent Watch evaluations share one subscription instead of replacing the same slot',async()=>{
    const m=backendModel(),session=new DapSession(m.backend as any),s=session as any;
    s.phase='connected';s.setTargetRunning(true);
    let ready!:()=>void;
    const gate=new Promise<void>(resolve=>ready=resolve);
    m.backend.execute.mockImplementation(async(c:any)=>{
      await gate;return {ok:true,data:c.expressions.map((expression:string)=>({expression,spec:{expression,address:0x20000100,size:4}}))};
    });
    const first=s.handleWatchEvaluate(req(1,'watchEvaluate',{expressions:['counter']}));
    const second=s.handleWatchEvaluate(req(2,'watchEvaluate',{expressions:['counter']}));
    ready();await Promise.all([first,second]);
    expect(m.backend.execute).toHaveBeenCalledOnce();
    expect(m.backend.subscribeProbeSamples).toHaveBeenCalledOnce();
    await s.probeWatchStop();
  });
});

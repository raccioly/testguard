import {it,expect} from 'vitest';
import {assertionProject} from './helpers/probe-assertions.mjs';

it('a negative-control load error proves reach, while an unexecuted subject remains unproven',async()=>{
  const missed=assertionProject({reached:false});try{
    const ev=await missed.run({mode:'in-place'});
    expect(ev.records[0]).toMatchObject({verdict:'unverifiable',detail:{negativeControl:'not-reached',reason:'subject-not-executed'}});
  }finally{missed.cleanup();}
  const reached=assertionProject({escalation:true});try{
    const ev=await reached.run({mode:'in-place'});
    const record=ev.records[0];
    expect(record.verdict).toBe('survived');
    expect(record.detail.negativeControl).toBe('reached');
    expect(record.detail.escalated).toBe(true);
    expect(record.detail.escalationRuns.length).toBeGreaterThan(0);
    for(const run of record.detail.escalationRuns){expect(run.outcome).toBe('pass');expect(run.tests.total).toBe(2);}
  }finally{reached.cleanup();}
});

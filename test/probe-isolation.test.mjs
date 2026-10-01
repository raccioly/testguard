import {it,expect} from 'vitest';
import {readFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {assertionProject} from './helpers/probe-assertions.mjs';

it('restores an applied fault in place before returning',async()=>{
  const p=assertionProject();try{
    const ev=await p.run({mode:'in-place'});
    expect(ev.records[0].verdict).toBe('killed');
    expect(readFileSync(join(p.dir,'src/a.mjs'),'utf8')).toBe(p.original);
  }finally{p.cleanup();}
});

it('executes every baseline and fault in the scratch tree, leaving the source intact throughout',async()=>{
  const p=assertionProject();try{
    const ev=await p.run({mode:'worktree'});
    expect(ev.records[0].verdict).toBe('killed');
    const observations=readFileSync(p.observations,'utf8').trim().split('\n').map(JSON.parse);
    expect(observations).toHaveLength(2);
    for(const run of observations){expect(realpathSync(p.dir)).not.toBe(run.cwd);expect(run.source).toBe(p.original);}
    expect(readFileSync(join(p.dir,'src/a.mjs'),'utf8')).toBe(p.original);
  }finally{p.cleanup();}
});

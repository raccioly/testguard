import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {probe} from '../../src/probe/probe.mjs';
import { FIXTURE_GIT } from './git.mjs';

/** Real Node assertions and imports, behind the existing custom-report boundary. */
export function assertionProject({reached=true, escalation=false}={}) {
  const dir=mkdtempSync(join(tmpdir(),'tg-probe-assertions-'));
  mkdirSync(join(dir,'src'));mkdirSync(join(dir,'test'));
  writeFileSync(join(dir,'src/a.mjs'),'export const a = () => 1;\n');
  writeFileSync(join(dir,'src/b.mjs'),'export const b = () => 2;\n');
  const statement=reached ? escalation ? "assert.equal(typeof a(),'number');" : 'assert.equal(a(),1);' : 'assert.equal(b(),2);';
  writeFileSync(join(dir,'test/a.test.mjs'),`import assert from 'node:assert/strict';import {${reached?'a':'b'}} from '../src/${reached?'a':'b'}.mjs';${statement}`);
  if(escalation) writeFileSync(join(dir,'test/c.test.mjs'),"import assert from 'node:assert/strict';import {a} from '../src/a.mjs';assert.equal(typeof a,'function');");
  const observations=join(dir,'observations.jsonl');
  writeFileSync(join(dir,'.gitignore'),'observations.jsonl\n');
  writeFileSync(join(dir,'runner.mjs'),`import fs from 'node:fs';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';
fs.appendFileSync(${JSON.stringify(observations)},JSON.stringify({cwd:process.cwd(),source:fs.readFileSync(${JSON.stringify(join(dir,'src/a.mjs'))},'utf8')})+String.fromCharCode(10));
const files=process.argv.slice(2,-1);let total=0,failed=0,loaded=true;const testResults=[];
for(const file of files){try{await import(pathToFileURL(resolve(file)));total++;testResults.push({name:file,status:'passed',assertionResults:[{status:'passed',fullName:'real assertion'}]});}catch(error){if(error.code==='ERR_ASSERTION'){total++;failed++;testResults.push({name:file,status:'failed',assertionResults:[{status:'failed',fullName:'real assertion',failureMessages:[error.stack]}]});}else{loaded=false;testResults.push({name:file,status:'failed',message:error.stack,assertionResults:[]});}}}
fs.writeFileSync(process.argv.at(-1),JSON.stringify({success:loaded&&failed===0,numTotalTests:total,numPassedTests:total-failed,numFailedTests:failed,testResults}));`);
  for(const args of [['init','-q'],['add','.'],['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']]) execFileSync('git',[...FIXTURE_GIT, ...args],{cwd:dir,timeout:5000});
  const claims={schemaVersion:1,claims:[{id:'C',statement:'The source stays intact.',severity:'high',source:{kind:'manual'},producedBy:{producer:'human'},defendedBy:['test/a.test.mjs'],faults:[{id:'F1',description:'Change the value.',faultClass:'literal-changed',file:'src/a.mjs',find:'=> 1',replace:'=> 2',producedBy:{producer:'human'}}]}]};
  return {dir,claims, observations, original:readFileSync(join(dir,'src/a.mjs'),'utf8'), run:(extra={})=>probe({projectDir:dir,claims,runnerCommand:`${JSON.stringify(process.execPath)} runner.mjs {files} {out}`,confirmRuns:1,budgetMs:3000,escalate:escalation,...extra}),cleanup:()=>{rmSync(dir,{recursive:true,force:true});}};
}

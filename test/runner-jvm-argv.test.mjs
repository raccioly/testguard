// The command lines of the maven and gradle adapters, as data (#329). Each flag
// here is one the adapters cannot do without: see the comments in maven.mjs and
// gradle.mjs. Nothing starts a process.
import { describe, it, expect } from 'vitest';
import { mavenArgv } from '../src/probe/runners/maven.mjs';
import { gradleArgv, taskPrefix } from '../src/probe/runners/gradle.mjs';

describe('mavenArgv', () => {
  const groups = (...entries) => new Map(entries);
  it('selects classes and tells Surefire an unmatched class is not a failure', () => {
    expect(mavenArgv({ tool: '/p/mvnw', groups: groups(['', ['a']]), classes: ['demo.ATest', 'demo.BTest'] })).toEqual([
      '/p/mvnw', '-B', 'test', '-Dtest=demo.ATest,demo.BTest', '-Dsurefire.failIfNoSpecifiedTests=false', '-DfailIfNoTests=false',
    ]);
  });

  it('selects the modules below the project, with what they need, and the root as .', () => {
    const argv = mavenArgv({ tool: 'mvn', groups: groups(['', ['x']], ['billing', ['y']], ['billing/api', ['z']]), classes: ['A'] });
    expect(argv.slice(-3)).toEqual(['-pl', '.,billing,billing/api', '-am']);
    expect(mavenArgv({ tool: 'mvn', groups: groups(['billing', ['y']]), classes: ['A'] }).slice(-3)).toEqual(['-pl', 'billing', '-am']);
  });
});

describe('gradleArgv', () => {
  it('runs a fresh, daemon-free, uncached test task per module with --tests per class', () => {
    const groups = new Map([['', ['src/test/java/demo/ATest.java']], ['billing/api', ['billing/api/src/test/java/x/BTest.java', 'billing/api/src/test/kotlin/x/CTest.kt']]]);
    expect(gradleArgv({ tool: '/p/gradlew', groups })).toEqual([
      '/p/gradlew', '--no-daemon', '--console=plain', '--no-build-cache', '--continue',
      ':cleanTest', ':test', '--tests', 'demo.ATest',
      ':billing:api:cleanTest', ':billing:api:test', '--tests', 'x.BTest', '--tests', 'x.CTest',
    ]);
  });

  it('writes a Gradle path from a directory path', () => {
    expect(taskPrefix('')).toBe(':');
    expect(taskPrefix('a')).toBe(':a:');
    expect(taskPrefix('a/b')).toBe(':a:b:');
  });
});


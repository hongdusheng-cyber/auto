import assert from 'node:assert/strict';
import test from 'node:test';
import { createJobRunner } from '../scripts/job-runner.mjs';

function deferred() {
  return Promise.withResolvers();
}

function makeRunner(options = {}) {
  return createJobRunner({
    rootDir: process.cwd(),
    profilePoolDir: '/tmp/office-test-profiles-unused',
    prepareProfile: async () => ({ state: 'created' }),
    stopGraceMs: 30,
    killGraceMs: 30,
    ...options,
  });
}

function command(source = '') {
  return { label: 'local test', executable: process.execPath, args: ['-e', source] };
}

test('failed profile initialization releases its slot and does not start a child', async () => {
  const runner = makeRunner({ prepareProfile: async () => { throw new Error('disk unavailable'); } });
  const job = runner.run(command(), 'failed');
  await job.completion;
  assert.equal(job.status, 'failed');
  assert.match(job.error.message, /disk unavailable/);
  assert.equal(job.processCompletions.length, 0);
  assert.equal(runner.jobs.size, 0);
});

test('stopping during setup reserves the profile until setup finishes', async () => {
  const setup = deferred();
  const runner = makeRunner({ prepareProfile: () => setup.promise });
  const first = runner.run(command(), 'first');
  runner.stop(first);
  const second = runner.run(command(), 'second');
  assert.equal(first.profileName, 'profile-1');
  assert.equal(second.profileName, 'profile-2');
  assert.equal(runner.jobs.size, 2);
  runner.stop(second);
  setup.resolve();
  await Promise.all([first.completion, second.completion]);
  assert.equal(first.status, 'stopped');
  assert.equal(first.processCompletions.length, 0);
  assert.equal(second.processCompletions.length, 0);
  assert.equal(runner.jobs.size, 0);
});

test('capacity includes stopped jobs while their setup is still pending', async () => {
  const setup = deferred();
  const runner = makeRunner({ maxJobs: 1, prepareProfile: () => setup.promise });
  const first = runner.run(command(), 'first');
  runner.stop(first);
  assert.throws(() => runner.run(command(), 'second'), { statusCode: 429 });
  setup.resolve();
  await first.completion;
  const next = runner.run(command(), 'next');
  await next.completion;
  assert.equal(next.profileName, 'profile-1');
  assert.equal(next.status, 'completed');
});

test('failed commands and spawn errors cancel subsequent workflow steps', async () => {
  for (const step of [command('process.exit(1)'), { ...command(), executable: '/missing-office-test-executable' }]) {
    let ranNext = false;
    const runner = makeRunner();
    const job = runner.run({ label: 'workflow', steps: [step, { resolve() { ranNext = true; return command(); } }] }, 'failed');
    await job.completion;
    assert.equal(job.status, 'failed');
    assert.equal(ranNext, false);
    assert.equal(job.children.size, 0);
    assert.equal(runner.jobs.size, 0);
  }
});

test('a late parallel resolver cannot spawn after a sibling fails', { timeout: 5000 }, async () => {
  const resolver = deferred();
  const failed = deferred();
  const runner = makeRunner({ writeLog(message) { if (message.includes('[错误]')) failed.resolve(); } });
  const job = runner.run({ label: 'parallel', steps: [{ parallel: [command('process.exit(1)'), { resolve: () => resolver.promise }] }] }, 'parallel');
  await failed.promise;
  assert.equal(runner.jobs.size, 1, 'the pending resolver still owns the slot');
  resolver.resolve(command());
  await job.completion;
  assert.equal(job.processCompletions.length, 1);
  assert.equal(job.status, 'failed');
  assert.equal(runner.jobs.size, 0);
});

test('stop escalates for an unresponsive child and waits before releasing its slot', { timeout: 5000 }, async () => {
  const ready = deferred();
  const runner = makeRunner({ handleOutput(_job, message) { if (message.includes('ready')) ready.resolve(); } });
  const job = runner.run(command("process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"), 'unresponsive');
  await ready.promise;
  runner.stop(job);
  assert.equal(runner.jobs.size, 1);
  await job.completion;
  assert.equal(job.status, 'stopped');
  assert.equal(job.children.size, 0);
  assert.equal(job.stopTimers.size, 0);
  assert.equal(runner.jobs.size, 0);
});

test('stop escalates to surviving descendants after the direct child exits', {
  timeout: 5000,
  skip: process.platform === 'win32',
}, async () => {
  const ready = deferred();
  const runner = makeRunner({ handleOutput(_job, message) { if (message.includes('descendant ready')) ready.resolve(); } });
  const descendant = "process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); console.log('descendant ready'); setInterval(() => {}, 1000);";
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'inherit', 'inherit'] }); setInterval(() => {}, 1000);`;
  const job = runner.run(command(parent), 'descendant');
  await ready.promise;
  const processGroup = job.child.pid;
  let timer;
  try {
    runner.stop(job);
    await Promise.race([
      job.completion,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The surviving descendant kept the job open')), 1000); }),
    ]);
    assert.equal(job.status, 'stopped');
    assert.equal(job.children.size, 0);
    assert.equal(runner.jobs.size, 0);
  } finally {
    clearTimeout(timer);
    // Clean up the controlled process tree even when the regression reappears.
    try { process.kill(-processGroup, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await job.completion;
  }
});

test('UTF-8 output split across child stream chunks is preserved', async () => {
  let output = '';
  const runner = makeRunner({ handleOutput(_job, message) { output += message; } });
  const job = runner.run(command("const b=Buffer.from('任务成功'); process.stdout.write(b.subarray(0, 1)); setTimeout(() => process.stdout.write(b.subarray(1)), 20);"), 'utf8');
  await job.completion;
  assert.equal(output, '任务成功');
});

test('interleaved stdout and stderr chunks retain their source for independent line parsing', { timeout: 5000 }, async (t) => {
  const output = [];
  const resultLine = 'ACCOUNT_RESULT {"status":"success","password":"Abc2345xyz"}\n';
  const runner = makeRunner({
    handleOutput(job, message, source) {
      output.push({ message, source });
      // Acknowledge each write so stderr definitely arrives between the two
      // stdout fragments, without depending on timer or pipe scheduling.
      if (message === 'ACCO' || message.includes('diagnostic warning')) job.child.stdin.write('\n');
    },
  });
  const job = runner.run(command(`
    process.stdin.once('data', () => {
      process.stdin.once('data', () => {
        process.stdout.write(${JSON.stringify(resultLine.slice(4))});
        process.stdin.destroy();
      });
      process.stderr.write('diagnostic warning\\n');
    });
    process.stdout.write('ACCO');
  `), 'interleaved-output');
  t.after(() => runner.stop(job));
  await job.completion;
  assert.equal(job.status, 'completed');
  assert.deepEqual(output.map(({ source }) => source), ['stdout', 'stderr', 'stdout']);
  const streamText = (source) => output.filter((entry) => entry.source === source).map((entry) => entry.message).join('');
  assert.equal(streamText('stdout'), resultLine);
  assert.equal(streamText('stderr'), 'diagnostic warning\n');
});

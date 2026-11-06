import { spawn } from 'node:child_process';
import path from 'node:path';

// A profile remains reserved until initialization and every child have settled.
export function createJobRunner({
  rootDir,
  profilePoolDir,
  prepareProfile,
  prepareCommand = async () => {},
  environment = () => ({}),
  writeLog = () => {},
  handleOutput = () => {},
  sendStatus = () => {},
  maxJobs = 8,
  stopGraceMs = 5000,
  killGraceMs = 2000,
}) {
  const jobs = new Map();
  let nextJobNumber = 1;

  function assertCapacity() {
    if (jobs.size >= maxJobs) {
      const error = new Error(`最多同时运行 ${maxJobs} 个任务，请等待任务结束或先停止任务。`);
      error.statusCode = 429;
      throw error;
    }
  }

  function allocateSlots(count) {
    const busy = new Set([...jobs.values()].flatMap((job) => job.profileNames));
    const slots = [];
    for (let index = 1; slots.length < count; index += 1) {
      const profileName = `profile-${index}`;
      if (!busy.has(profileName)) {
        slots.push({ profileName, userDataDir: path.join(profilePoolDir, profileName) });
      }
    }
    return slots;
  }

  function ensureActive(job) {
    if (job.stopped || job.aborting) throw new Error('任务已停止。');
  }

  function signalChild(child, signal) {
    try {
      // Signal the group even after its leader exits: descendants may hold pipes open.
      // Playwright handles SIGINT to close browsers, which use their own process groups.
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    } catch (error) {
      if (error.code !== 'ESRCH') writeLog(`[停止失败] ${error.message}\n`);
    }
  }

  function stopChildren(job) {
    for (const child of job.children) {
      if (job.stopTimers.has(child)) continue;
      signalChild(child, 'SIGINT');
      const terminate = setTimeout(() => signalChild(child, 'SIGTERM'), stopGraceMs);
      const kill = setTimeout(() => signalChild(child, 'SIGKILL'), stopGraceMs + killGraceMs);
      terminate.unref();
      kill.unref();
      job.stopTimers.set(child, [terminate, kill]);
    }
  }

  function stop(job) {
    job.stopped = true;
    stopChildren(job);
    sendStatus();
  }

  function runProcess(job, slots, step) {
    ensureActive(job);
    const slot = slots[step.profileIndex ?? 0] ?? slots[0];
    writeLog(`\n[子任务] ${step.label}，浏览器槽位：${slot.profileName}\n`);
    // Arguments can contain proxy credentials; log the script name only.
    writeLog(`脚本：${path.basename(step.args[0] ?? step.executable)}\n\n`);
    const child = spawn(step.executable, step.args, {
      cwd: rootDir,
      env: { ...process.env, ...environment(slot) },
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    job.children.add(child);
    job.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (message) => handleOutput(job, message, 'stdout'));
    child.stderr.on('data', (message) => handleOutput(job, message, 'stderr'));
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') {
        writeLog(`[输入失败] ${error.message}\n`);
      }
    });
    let spawnError;
    child.once('error', (error) => { spawnError = error; });
    const completion = new Promise((resolve, reject) => {
      child.once('close', (code, signal) => {
        job.children.delete(child);
        job.child = [...job.children][0] ?? null;
        for (const timer of job.stopTimers.get(child) ?? []) clearTimeout(timer);
        job.stopTimers.delete(child);
        writeLog(`\n--- 任务#${job.number} 结束子任务：${step.label}，退出码 ${code ?? 'null'}${signal ? `，信号 ${signal}` : ''} ---\n`);
        if (spawnError) reject(spawnError);
        else if (code === 0) resolve();
        else reject(new Error(`${step.label} 失败（退出码 ${code ?? 'null'}）。`));
      });
    });
    job.processCompletions.push(completion);
    return completion;
  }

  function run(command, runToken) {
    assertCapacity();
    const slots = allocateSlots(command.profileCount ?? 1);
    const job = {
      id: runToken,
      number: nextJobNumber++,
      task: command.label,
      child: null,
      children: new Set(),
      stopTimers: new Map(),
      processCompletions: [],
      pendingSteps: [],
      stopped: false,
      aborting: false,
      status: 'preparing',
      atLineStart: true,
      outputBuffer: '',
      networkAccelerationServiceId: null,
      lastDetectedNetworkAccelerationServiceId: null,
      ...slots[0],
      profileNames: slots.map((slot) => slot.profileName),
      userDataDirs: slots.map((slot) => slot.userDataDir),
    };
    jobs.set(job.id, job);
    sendStatus();
    job.completion = (async () => {
      try {
        writeLog(`\n\n===== 开始：任务#${job.number} ${command.label} =====\n`);
        for (const slot of slots) {
          ensureActive(job);
          writeLog(`浏览器槽位：${slot.profileName}\n`);
          const state = await prepareProfile(slot.userDataDir);
          if (state?.state === 'reused') writeLog(`已复用登录状态：${slot.userDataDir}\n`);
          if (state?.state === 'copied') writeLog(`已复制登录状态来源：${state.source}\n`);
          if (state?.state === 'shared') writeLog('已创建轻量浏览器目录，将直接复用共享登录态。\n');
          if (state?.state === 'created') writeLog('已创建新的浏览器目录。\n');
        }
        ensureActive(job);
        await prepareCommand(command);
        ensureActive(job);
        job.status = 'running';
        const steps = command.steps ?? [command];
        for (const [index, step] of steps.entries()) {
          ensureActive(job);
          writeLog(`\n--- 任务#${job.number} 步骤 ${index + 1}/${steps.length}：${step.label} ---\n`);
          const execute = async (entry) => {
            const resolved = entry.resolve ? { ...entry, ...await entry.resolve(job) } : entry;
            await runProcess(job, slots, resolved);
          };
          const pending = (step.parallel ?? [step]).map(execute);
          job.pendingSteps.push(...pending);
          await Promise.all(pending);
          ensureActive(job);
          if (step.after) await step.after(job);
        }
        ensureActive(job);
        job.status = 'completed';
        writeLog(`\n===== 结束：任务#${job.number} ${command.label}，全部步骤完成 =====\n`);
      } catch (error) {
        job.aborting = true;
        job.status = job.stopped ? 'stopped' : 'failed';
        job.error = error;
        stopChildren(job);
        writeLog(`\n[错误] ${error.message}\n`);
        writeLog(`\n===== ${job.stopped ? '已停止' : '中断'}：任务#${job.number} ${command.label} =====\n`);
      } finally {
        await Promise.allSettled(job.pendingSteps);
        await Promise.allSettled(job.processCompletions);
        jobs.delete(job.id);
        sendStatus();
      }
    })();
    return job;
  }

  return { jobs, run, stop, assertCapacity };
}

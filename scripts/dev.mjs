import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { root, loadState, dsh, dshEnv, profile, run, writeRuntimePatch } from './environment.mjs'
const { values } = parseArgs({ options: { mock: { type: 'boolean' }, jev: { type: 'boolean' }, direct: { type: 'boolean' } } })
const state = await loadState()
if (!state.setupAt) throw new Error(`请先运行 pnpm run setup${values.mock ? ' --mock' : ''}。`)
const withoutDebugger = env => {
  const clean = { ...env }
  delete clean.NODE_OPTIONS
  delete clean.VSCODE_INSPECTOR_OPTIONS
  return clean
}
const buildEnv = withoutDebugger(process.env)
await run(process.execPath, ['scripts/build.mjs'], { env: buildEnv })
await writeRuntimePatch(state, { mock: values.mock, jev: values.jev ?? state.jevEnabled })
console.log(`星露谷：${values.mock ? '模拟农场' : '真实游戏'}；Jev：${(values.jev ?? state.jevEnabled) ? '开启' : '关闭'}。`)
console.log('打开 dsh 地址后的 /stardew 页面，输入目标并开始；Jev 模式无需配置聊天模型。')
let mock
let host
let stopping = false
async function stop() {
  if (stopping) return; stopping = true
  for (const child of [host, mock]) if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void stop())
try {
  if (values.mock) {
    mock = spawn(process.execPath, ['--import', 'tsx', 'scripts/mock.mts'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], env: withoutDebugger(process.env) })
    mock.stdout.pipe(process.stdout)
    await new Promise((resolve, reject) => {
      const lines = createInterface({ input: mock.stdout })
      const timer = setTimeout(() => { lines.close(); reject(new Error('模拟服务启动超时。')) }, 5000)
      lines.on('line', line => { if (line.startsWith('[mock]')) { clearTimeout(timer); lines.close(); resolve() } })
      mock.once('error', reject); mock.once('exit', code => { clearTimeout(timer); reject(new Error(`模拟服务退出：${code}`)); if (host) void stop() })
    })
  }
  const dshArgs = ['--profile', profile, '--patch', state.patch]
  if (values.direct) {
    if (!isAbsolute(dsh)) throw new Error('--direct 需要通过 DSH_PATH 指定 dsh 源码构建入口。')
    process.env.DSH_HOME = dshEnv().DSH_HOME
    process.argv = [process.execPath, dsh, ...dshArgs]
    const cli = await import(pathToFileURL(dsh).href)
    if (typeof cli.runCli !== 'function') throw new Error('DSH_PATH 未导出 runCli，无法直接调试。')
    await cli.runCli()
  } else {
    host = spawn(dsh, dshArgs, { cwd: root, stdio: 'inherit', env: withoutDebugger(dshEnv()) })
    await new Promise((resolve, reject) => { host.once('error', reject); host.once('exit', (code, signal) => { process.exitCode = stopping || signal === 'SIGINT' ? 0 : code ?? 1; resolve() }) })
  }
} finally { await stop() }

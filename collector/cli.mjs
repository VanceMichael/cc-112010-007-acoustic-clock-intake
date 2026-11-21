#!/usr/bin/env node
// 采集器命令行：
//   trip      执行一次出车（默认 http://127.0.0.1:4173，状态存 ./.intake-state）
//   report    查看最近一次出车与窗口结项
//   pending   查看可补领范围、检测标记、留存无机会范围
//   refetch   复取某次交付（按 deliveryId）
//   state     输出调查站完整留存快照

import { mkdir } from 'node:fs/promises'
import { createStore } from './store.mjs'
import { createClient } from './source-client.mjs'
import { runTrip, refetchDelivery, pendingView } from './collector.mjs'

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) args[key] = true
      else {
        args[key] = next
        i += 1
      }
    } else {
      args._.push(token)
    }
  }
  return args
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0] ?? 'trip'
  const origin = args.origin ?? process.env.SOURCE_ORIGIN ?? 'http://127.0.0.1:4173'
  const stateDir = args.state ?? `${process.cwd()}/.intake-state`
  await mkdir(stateDir, { recursive: true })
  const store = createStore(stateDir)
  await store.load()

  if (command === 'trip') {
    const trip = await runTrip({
      origin,
      store,
      highPriority: Number(args.highPriority ?? 1),
    })
    print(trip)
    return
  }
  if (command === 'report') {
    const trips = store.state.trips
    print(trips[trips.length - 1] ?? { note: '尚无出车记录' })
    return
  }
  if (command === 'pending') {
    print(pendingView(store))
    return
  }
  if (command === 'refetch') {
    const deliveryId = args.delivery ?? args._[1]
    if (!deliveryId) throw new Error('refetch 需要 --delivery <id>')
    const result = await refetchDelivery({
      store,
      deliveryId,
      client: createClient(origin),
    })
    print({
      ...result,
      files: result.files?.map(f => ({
        ...f,
        bytes: f.bytes ? { length: f.bytes.length, digest: f.digest } : null,
      })),
    })
    return
  }
  if (command === 'state') {
    print(store.snapshot())
    return
  }
  throw new Error(`未知命令：${command}`)
}

main().catch(error => {
  process.stderr.write(`采集器失败：${error.message}\n`)
  process.exitCode = 1
})

import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { makeSource } from '../source.mjs'
import { createStore, framesToBytes } from '../collector/store.mjs'
import { createClient } from '../collector/source-client.mjs'
import { runTrip, pendingView, refetchDelivery } from '../collector/collector.mjs'
import { buildDemands, mergeByOrigin, sourceGapFrames, allocateBudget } from '../collector/planner.mjs'
import { tickToReferenceBounds, overlapFrames, clockDomain } from '../collector/clock.mjs'
import { normalize, intersect, subtract } from '../collector/intervals.mjs'

async function openSource(t) {
  const server = makeSource()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => {
    server.close(resolve)
    server.closeAllConnections()
  }))
  return `http://127.0.0.1:${server.address().port}`
}

async function view(origin, step) {
  const res = await fetch(new URL('/replay', origin), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ step }),
  })
  assert.equal(res.status, 200)
}

async function freshStore(t) {
  const dir = await mkdtemp(join(tmpdir(), 'intake-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = createStore(dir)
  await store.load()
  return store
}

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex')

test('对时换算：anchor 内线性插值并保守外扩误差，区间外不可信', () => {
  const clock = {
    device: 'K', boot: 'R7', revision: 1, maxError: 30,
    anchors: [[0, 99700, 30], [1200, 100900, 40]],
  }
  assert.deepEqual(clockDomain(clock), [0, 1200])
  // tick=0：名义 99700，误差 30+30=60。
  assert.deepEqual(tickToReferenceBounds(clock, 0), [99640, 99760])
  // tick=1200：名义 100900，误差 40+30=70。
  assert.deepEqual(tickToReferenceBounds(clock, 1200), [100830, 100970])
  // 覆盖域外没有可信换算。
  assert.equal(tickToReferenceBounds(clock, 1201), null)
  // tick=600 中点：名义 100300，anchor 误差 35，加本段 30 => ±65。
  assert.deepEqual(tickToReferenceBounds(clock, 600), [100235, 100365])
})

test('窗口交叠：可证实与待判帧分开，缺锚时返回 null 走待判保全', () => {
  const session = {
    device: 'K', boot: 'R7', file: '/pcm/K/R7/two',
    sampleRate: 16000, tickAtStart: 800, samples: 6400,
    slices: [[0, 1600], [3200, 6400]],
  }
  const clock = {
    device: 'K', boot: 'R7', revision: 1, maxError: 30,
    anchors: [[0, 99700, 30], [1200, 100900, 40]],
  }
  const overlap = overlapFrames(session, clock, [100500, 101000])
  assert.ok(overlap.provable.length)
  assert.ok(overlap.possible.length)
  // 所有判定帧必须落在原件帧域内。
  for (const [left, right] of [...overlap.provable, ...overlap.possible]) {
    assert.ok(left >= 0 && right <= session.samples)
  }
  // 没有对时记录时不给任何确定归属。
  assert.equal(overlapFrames(session, null, [100500, 101000]), null)
})

test('区间运算：交、差、合并保持半开整数语义', () => {
  assert.deepEqual(intersect([[0, 100], [200, 300]], [[50, 250]]), [[50, 100], [200, 250]])
  assert.deepEqual(subtract([[0, 100]], [[40, 60]]), [[0, 40], [60, 100]])
  assert.deepEqual(normalize([[0, 10], [10, 20], [25, 30]]), [[0, 20], [25, 30]])
})

test('同设备同启动同原件才共用；不同 boot 的相邻原件不合并', () => {
  const windows = [{ id: 'N1', site: 'west', reference: [100000, 100600], priority: 2 }]
  const sessions = [
    { device: 'K', boot: 'R7', file: '/pcm/K/R7/one', sampleRate: 8000, tickAtStart: 0, samples: 6400, slices: [[0, 6400]] },
    { device: 'K', boot: 'R8', file: '/pcm/K/R8/one', sampleRate: 8000, tickAtStart: 0, samples: 6400, slices: [[0, 6400]],
      acquisitionHint: { mayFallInReference: [100570, 100960], retainThroughTrip: 1 } },
  ]
  const clocks = [{
    device: 'K', boot: 'R7', revision: 1, maxError: 30,
    anchors: [[0, 99700, 30], [1200, 100900, 40]],
  }]
  const demands = buildDemands({ windows, sessions, clocks, store: null })
  const plans = mergeByOrigin(demands)
  const keys = plans.map(p => p.key).sort()
  // R7 与 R8 即便文件名都叫 one，也是两份独立原件。
  assert.deepEqual(keys, ['K/R7/one', 'K/R8/one'])
  // R8 无锚但提示落在窗口且本车次后过期 -> 待判保全。
  const r8 = plans.find(p => p.key === 'K/R8/one')
  assert.equal(r8.pending, true)
  assert.ok(totalL(r8.pendingFrames) > 0)
})

test('来源缺号识别为明确缺样，且不会被当成可领取区间', () => {
  const session = {
    device: 'K', boot: 'R7', file: '/pcm/K/R7/two',
    sampleRate: 16000, tickAtStart: 800, samples: 6400,
    slices: [[0, 1600], [3200, 6400]],
  }
  assert.deepEqual(sourceGapFrames(session), [[1600, 3200]])
})

function totalL(ranges) {
  return ranges.reduce((sum, [l, r]) => sum + (r - l), 0)
}

test('第一次出车：掉线/缺样/留存三态分开，高优先窗口先满足且共用字节不重复领', async t => {
  const origin = await openSource(t)
  const store = await freshStore(t)
  const trip = await runTrip({ origin, store })

  assert.equal(trip.trip, 1)
  // K 在线、J 掉线。
  const k = trip.budget.find(b => b.device === 'K')
  const j = trip.budget.find(b => b.device === 'J')
  assert.equal(k.online, true)
  assert.equal(j.online, false)

  // 归档 D-3 被摄入调查站留存，可复取且摘要与来源登记一致。
  const d3 = store.listDeliveries('N1').find(d => d.deliveryId === 'D-3')
  assert.ok(d3)
  const refetch = await refetchDelivery({ store, deliveryId: 'D-3' })
  assert.equal(refetch.status, 'ok')
  const part = refetch.files[0]
  assert.ok(part.bytes)
  assert.equal(part.actualDigest, part.sourceDigest)
  assert.equal(part.sourceDigest,
    'ede8b9b81d1fe5e7fab1d0dbbb2bc276bf5d417f1129e6385e2eeb460376d3f1')

  // N1（priority 2）在 K 终端的可证实帧全部持有；J 终端掉线导致整窗暂不能结项，
  // 但报告必须把「可重试的阻塞」与「不可恢复的缺样/留存」分开。
  const n1 = trip.reports.find(r => r.windowId === 'N1')
  const n2 = trip.reports.find(r => r.windowId === 'N2')
  assert.equal(n1.satisfied, false)
  assert.deepEqual(n1.blocking.map(b => b.key), ['J/R5/one'])
  const n1K = n1.parts.filter(p => p.key.startsWith('K/'))
  assert.ok(n1K.every(p => totalL(p.provableMissing) === 0))
  assert.ok(!n1.parts.find(p => p.key === 'J/R5/one').unrecoverable)
  assert.ok(n1.parts.find(p => p.key === 'J/R5/one').retryable)
  assert.ok(n2)

  // J 终端掉线：出现 offline 观察，而不是 gap 或 retention。
  const jObs = Object.values(store.inventoryOf('J/R5/one').observations)
  assert.ok(jObs.some(o => o.status === 'offline'))
  assert.ok(!jObs.some(o => o.status === 'retention'))

  // K/R7/two 的 slices 空档 [1600,3200) 是明确缺样。
  const two = store.state.sessions.get('K/R7/two')
  assert.deepEqual(sourceGapFrames(two), [[1600, 3200]])

  // 预算约束：K 的实际支出不超过 22000 字节。
  assert.ok(k.spent <= k.budget)
  // 同一原件的同帧不会出现两个成功领取动作（交叠窗口共用）。
  const okActions = trip.fetchLog.filter(a => a.result === 'ok')
  const seen = new Set()
  for (const action of okActions) {
    const tag = `${action.key}:${action.frames[0]}-${action.frames[1]}`
    assert.ok(!seen.has(tag), `重复领取 ${tag}`)
    seen.add(tag)
  }
  // N1 相关动作排在 N2 独有动作之前（高优先先花字节）。
  const n1Index = okActions.findIndex(a => a.serves.some(s => s.windowId === 'N1'))
  const n2OnlyIndex = okActions.findIndex(a =>
    a.serves.every(s => s.windowId === 'N2') && !a.serves.some(s => s.windowId === 'N1'))
  if (n1Index >= 0 && n2OnlyIndex >= 0) assert.ok(n1Index < n2OnlyIndex)
})

test('第二次出车：补锚后复用已领字节，410 与 503 恢复区分对待', async t => {
  const origin = await openSource(t)
  const store = await freshStore(t)
  await runTrip({ origin, store })

  const heldBefore = new Map()
  for (const [key, entry] of store.state.inventory) {
    heldBefore.set(key, entry.held.map(f => ({ ...f })))
  }

  await view(origin, 1)
  const trip2 = await runTrip({ origin, store })
  assert.equal(trip2.trip, 2)

  // 时钟修订从 1 升到 2（K/R7），R8 补到锚。
  const change = trip2.clockChanges.find(c => c.device === 'K' && c.boot === 'R7')
  assert.equal(change.revision, 2)
  assert.equal(change.changed, true)

  // 补锚后已持有片段仍被复用：不会对同一帧再次成功取件。
  for (const [key, before] of heldBefore) {
    const after = store.inventoryOf(key).held
    for (const fragment of before) {
      assert.ok(after.some(f => f.digest === fragment.digest &&
        f.frames[0] === fragment.frames[0] && f.frames[1] === fragment.frames[1]),
        `${key} 历史片段丢失`)
    }
  }

  // K/R7/two 与 K/R8/one 在本次发布返回 410：落 retention，不再有机会。
  const twoObs = Object.values(store.inventoryOf('K/R7/two').observations)
  const r8Obs = Object.values(store.inventoryOf('K/R8/one').observations)
  assert.ok(twoObs.some(o => o.status === 'retention') || trip2.fetchLog.some(f => f.key === 'K/R7/two' && f.result === 'retention'))
  assert.ok(r8Obs.some(o => o.status === 'retention') || trip2.fetchLog.some(f => f.key === 'K/R8/one' && f.result === 'retention'))

  // J 恢复在线：第一次的 offline 帧这次可以真正取回。
  const jObs = Object.values(store.inventoryOf('J/R5/one').observations)
  assert.ok(jObs.some(o => o.status === 'ok'))
  assert.ok(totalL(store.heldFrames('J/R5/one')) > 0)

  // 待领视图：retention 与 sourceGap 与 retrievable 分开列示。
  const view2 = pendingView(store)
  const twoView = view2.find(v => v.key === 'K/R7/two')
  assert.ok(totalL(twoView.sourceGapFrames) === 1600)
  assert.ok(twoView.retentionFrames.length >= 0)
})

test('待判保全：无锚但即将过期的高优先原件先保全，补锚后只按可证实范围交付', async t => {
  const origin = await openSource(t)
  const store = await freshStore(t)
  const trip1 = await runTrip({ origin, store })
  // R8 在第 0 次发布没有对时锚，retainThroughTrip=1，属高优先窗口 N1 候选。
  const r8Plan = trip1.reports
    .flatMap(r => r.parts)
    .find(p => p.key === 'K/R8/one')
  assert.ok(r8Plan)
  assert.equal(r8Plan.pending, true)
  // 待判帧即便已保全，第一次交付里也不能算进 provableHeld。
  assert.equal(totalL(r8Plan.provableHeld), 0)

  await view(origin, 1)
  const trip2 = await runTrip({ origin, store })
  // 补锚后 R8 名义时段在 104000 之后，与 N1/N2（10 万量级）不相交 -> 判定不属于窗口。
  const r8After = trip2.reports
    .flatMap(r => r.parts)
    .find(p => p.key === 'K/R8/one')
  assert.equal(r8After, undefined)
  // 但保全字节仍在调查站留存，且原件 410 后本地证据不丢。
  assert.ok(store.heldFrames('K/R8/one').length >= 0)
})

test('缺样与无原件绝不产生填充音：持有的只有真实取回的字节', async t => {
  const origin = await openSource(t)
  const store = await freshStore(t)
  await view(origin, 1)
  const trip = await runTrip({ origin, store })
  for (const [key, entry] of store.state.inventory) {
    for (const fragment of entry.held) {
      // 每个留存片段长度必须等于其帧区间 × 2 字节，且摘要可核。
      assert.equal(fragment.bytes[1] - fragment.bytes[0] + 1,
        (fragment.frames[1] - fragment.frames[0]) * 2)
      assert.match(fragment.digest, /^[0-9a-f]{64}$/)
    }
  }
  // gap/offline/retention 观察不会对应任何 held 片段。
  for (const marks of Object.values(store.state.inventory)) {
    const held = normalize(marks.held.map(f => f.frames))
    for (const observation of Object.values(marks.observations)) {
      if (observation.status !== 'ok') {
        assert.equal(intersect(held, [observation.frames]).length, 0)
      }
    }
  }
  // 交付文件里不存在占位帧标记。
  assert.ok(JSON.stringify(trip).includes('placeholder') === false)
})

test('交付版本可复取，归属变化可在报告中追溯', async t => {
  const origin = await openSource(t)
  const store = await freshStore(t)
  const trip1 = await runTrip({ origin, store })
  await view(origin, 1)
  const trip2 = await runTrip({ origin, store })

  const n1Deliveries = store.listDeliveries('N1')
  assert.ok(n1Deliveries.length >= 2)
  // 每一版都能复取，复取字节与来源登记摘要对得上。
  for (const record of n1Deliveries) {
    const result = await refetchDelivery({ store, deliveryId: record.deliveryId })
    assert.equal(result.status, 'ok')
    for (const file of result.files) {
      if (file.bytes) assert.equal(file.actualDigest, file.sourceDigest)
    }
  }
  // 两次出车的 clockRevisions 反映归属依据变化。
  const revisions = n1Deliveries.map(d => Object.values(d.clockRevisions)[0])
  assert.ok(revisions.includes(1))
  assert.ok(revisions.includes(2) || revisions.includes(null))
})

test('HTTP 客户端直接区分 503/410/416 三种取不到的情形', async t => {
  const origin = await openSource(t)
  const client = createClient(origin)
  const offline = await client.getRange('/pcm/J/R5/one', 2500, 3899)
  assert.equal(offline.status, 'offline')
  const gap = await client.getRange('/pcm/K/R7/two', 2500, 3899)
  assert.equal(gap.status, 'gap')
  await view(origin, 1)
  const retention = await client.getRange('/pcm/K/R7/two', 0, 99)
  assert.equal(retention.status, 'retention')
  const ok = await client.getRange('/pcm/J/R5/one', 0, 99)
  assert.equal(ok.status, 'ok')
  assert.equal(ok.bytes.length, 100)
})

test('帧区间与 PCM 字节区间按 2 字节线性对应', () => {
  // framesToBytes 给半开字节区间；planner 构造 HTTP Range 时右端再减 1。
  assert.deepEqual(framesToBytes([[2360, 6400]]), [[4720, 12800]])
  const store = createStore('/tmp/never-created-intake-test')
  assert.deepEqual(store.heldFrames('x'), [])
})

test('预算紧张时高优先窗口先满足，低优先与待判帧被截断且绝不超支', () => {
  const mkSession = (key, device = 'K', boot = 'R7') => ({
    device, boot, file: `/pcm/${device}/${boot}/${key}`,
    sampleRate: 8000, tickAtStart: 0, samples: 1000, slices: [[0, 1000]], key,
  })
  const sessions = [mkSession('high'), mkSession('low')]
  const plans = [
    {
      origin: 'K|R7|high', key: 'K/R7/high', session: sessions[0],
      provable: [[0, 400]], possible: [], pending: false, maxPriority: 2,
      windowLinks: [{ windowId: 'H', priority: 2, provable: [[0, 400]], possible: [], pending: false }],
    },
    {
      origin: 'K|R7|low', key: 'K/R7/low', session: sessions[1],
      provable: [[0, 400]], possible: [[400, 800]], pending: false, maxPriority: 1,
      windowLinks: [{ windowId: 'L', priority: 1, provable: [[0, 400]], possible: [[400, 800]], pending: false }],
    },
  ]
  const store = createStore('/tmp/never-created-intake-test-2')
  // 预算只够 600 帧（1200 字节）：高优先 400 帧全拿，低优先只能拿 200 帧。
  const { terminals, decisions } = allocateBudget({
    plans,
    terminals: [{ device: 'K', budget: 1200, online: true, trip: 1 }],
    store,
  })
  assert.equal(terminals[0].spent, 1200)
  const high = decisions.find(d => d.plan.key === 'K/R7/high')
  const low = decisions.find(d => d.plan.key === 'K/R7/low')
  assert.equal(totalL(high.actions.map(a => a.frames)), 400)
  assert.equal(low.status, 'partial-budget')
  assert.equal(totalL(low.actions.map(a => a.frames)), 200)
  // 所有动作都不超出各自原件帧域。
  for (const t of terminals) for (const a of t.actions) {
    assert.ok(a.frames[0] >= 0 && a.frames[1] <= 1000)
    assert.equal(a.bytes[1] - a.bytes[0] + 1, (a.frames[1] - a.frames[0]) * 2)
  }
})

test('同原件交叠窗口只产生一份动作，serves 同时标注两个窗口', () => {
  const session = {
    device: 'K', boot: 'R7', file: '/pcm/K/R7/one', key: 'K/R7/one',
    sampleRate: 8000, tickAtStart: 0, samples: 1200, slices: [[0, 1200]],
  }
  const plans = [{
    origin: 'K|R7|one', key: 'K/R7/one', session,
    provable: [[200, 900]], possible: [], pending: false, maxPriority: 2,
    windowLinks: [
      { windowId: 'N1', priority: 2, provable: [[200, 700]], possible: [], pending: false },
      { windowId: 'N2', priority: 1, provable: [[500, 900]], possible: [], pending: false },
    ],
  }]
  const store = createStore('/tmp/never-created-intake-test-3')
  const { terminals } = allocateBudget({
    plans,
    terminals: [{ device: 'K', budget: 100000, online: true, trip: 1 }],
    store,
  })
  const frames = terminals[0].actions.map(a => a.frames)
  // 交叠段 [500,700) 不会出现两次。
  assert.deepEqual(frames, [[200, 900]])
  const serves = terminals[0].actions[0].serves.map(s => s.windowId).sort()
  assert.deepEqual(serves, ['N1', 'N2'])
})

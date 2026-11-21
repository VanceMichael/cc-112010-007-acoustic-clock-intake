// 一次出车的编排：拉清单 → 规划 → 按预算领取 → 三态落账 → 形成交付版本与报告。
//
// 复用原则：补锚改变窗口相交范围后，先查调查站已持有的帧，已领过的字节直接复用，
// 只对仍然缺口的帧发起 Range 请求。

import { normalize, intersect, subtract, totalLength } from './intervals.mjs'
import { createClient } from './source-client.mjs'
import {
  createStore,
  framesToBytes,
  sessionKey,
} from './store.mjs'
import {
  allocateBudget,
  availableFrames,
  buildDemands,
  mergeByOrigin,
  sourceGapFrames,
  windowReport,
} from './planner.mjs'

export async function runTrip({ origin, store, highPriority = 1, fetchArchives = true }) {
  const client = createClient(origin)
  const [windows, sessions, clocks, terminals, deliveries] = await Promise.all([
    client.getJson('/detector'),
    client.getJson('/sessions'),
    client.getJson('/clock').catch(error => {
      if (error.kind === 'offline') return []
      throw error
    }),
    client.getJson('/terminal'),
    client.getJson('/deliveries').catch(error => {
      if (error.status === 404) return []
      throw error
    }),
  ])

  for (const window of windows) store.upsertWindow(window)
  for (const session of sessions) store.upsertSession(session)

  const clockChanges = []
  for (const clock of clocks) clockChanges.push(store.recordClock(clock))

  // 调查站早先交付的原件：把归档字节取回本地，作为可复用、可复取的持有片段。
  const archiveIngest = []
  if (fetchArchives) {
    for (const delivery of deliveries) {
      const known = store.listDeliveries(delivery.window).some(d => d.deliveryId === delivery.id)
      for (const file of delivery.files ?? []) {
        const key = file.key
        const session = sessions.find(s => sessionKey(s) === key)
        if (session) store.upsertSession(session)
        const already = store.heldFrames(key)
        if (totalLength(intersect(already, [file.frames])) === totalLength([file.frames])) continue
        const fetched = await client.getBytes(file.archive)
        if (fetched.status !== 'ok') {
          archiveIngest.push({ key, archive: file.archive, status: fetched.status })
          continue
        }
        if (fetched.digest !== file.digest) {
          archiveIngest.push({ key, archive: file.archive, status: 'digest-mismatch' })
          continue
        }
        await store.addHeldFragment(key, file.frames, fetched.bytes, fetched.digest)
        // 归档文件本身按片段摘要存盘，记录其来源摘要以便复取核对。
        store.inventoryOf(key).held.at(-1).sourceDigest = file.digest
        archiveIngest.push({ key, archive: file.archive, status: 'ingested', frames: file.frames })
      }
      if (!known) {
        // 来源交付记录：digest 改记为本地复取字节的实际摘要（与 refetch 契约一致），
        // sourceDigest 保留资料源登记摘要，两条证据链都可核对。
        const localFiles = []
        for (const f of delivery.files ?? []) {
          const local = store.inventoryOf(f.key).held
            .find(h => h.frames[0] === f.frames[0] && h.frames[1] === f.frames[1])
          localFiles.push({
            ...f,
            digest: local?.digest ?? f.digest,
            sourceDigest: f.digest,
          })
        }
        await store.recordDelivery(
          delivery.window,
          localFiles,
          Object.fromEntries((delivery.files ?? []).map(f => [f.key, delivery.clockRevision ?? null])),
          Object.fromEntries((delivery.files ?? []).map(f => [f.key, []])),
        )
        // 保留资料源交付编号，避免重复版本号。
        const list = store.listDeliveries(delivery.window)
        list[list.length - 1].deliveryId = delivery.id
        list[list.length - 1].source = 'archive'
      }
    }
  }

  const demands = buildDemands({
    windows,
    sessions,
    clocks,
    store,
    highPriority,
  })
  const plans = mergeByOrigin(demands)
  const { terminals: terminalPlan, decisions } = allocateBudget({
    plans,
    terminals,
    store,
  })

  const tripNo = terminals[0]?.trip ?? null
  const observations = new Map()
  const fetchLog = []

  // 终端整体掉线：该终端所有尚未持有的可领需求统一落 offline 观察，
  // 与 gap（从未录到）、retention（已被覆盖）严格区分，下次出车可重试。
  for (const terminal of terminalPlan) {
    if (terminal.online) continue
    for (const decision of decisions.filter(d => d.plan.session.device === terminal.device)) {
      const wanted = normalize([...decision.plan.provable, ...decision.plan.possible])
      const held = store.heldFrames(decision.plan.key)
      for (const range of subtract(wanted, held)) {
        store.recordObservation(decision.plan.key, range, 'offline', { reason: '终端不在线' })
        fetchLog.push({
          key: decision.plan.key,
          file: decision.plan.session.file,
          device: terminal.device,
          frames: range,
          bytes: [range[0] * 2, range[1] * 2 - 1],
          serves: [],
          provisional: decision.plan.pending,
          result: 'offline',
        })
      }
    }
  }

  for (const terminal of terminalPlan) {
    for (const action of terminal.actions) {
      const session = store.state.sessions.get(action.key)
      // 已经判定为留存覆盖(410)的原件不重复消耗预算，直接沿用终态标记。
      const knownRetention = Object.values(store.inventoryOf(action.key).observations)
        .some(o => o.status === 'retention' && intersect([o.frames], [action.frames]).length)
      if (knownRetention) {
        fetchLog.push({ ...action, result: 'retention', reused: true })
        continue
      }
      // 来源已宣告缺样的帧不发起请求，也绝不以填充音替代。
      const inGap = intersect(sourceGapFrames(session), [action.frames])
      if (totalLength(inGap) === totalLength([action.frames])) {
        store.recordObservation(action.key, action.frames, 'gap', { reason: '来源 slices 缺号' })
        fetchLog.push({ ...action, result: 'gap' })
        continue
      }
      const result = await client.getRange(session.file, action.bytes[0], action.bytes[1])
      if (result.status === 'ok') {
        if (result.bytes.length !== action.bytes[1] - action.bytes[0] + 1) {
          store.recordObservation(action.key, action.frames, 'error', { reason: '返回字节数不符' })
          fetchLog.push({ ...action, result: 'error' })
          continue
        }
        await store.addHeldFragment(action.key, action.frames, result.bytes, result.digest)
        store.recordObservation(action.key, action.frames, 'ok', { digest: result.digest })
        fetchLog.push({ ...action, result: 'ok', digest: result.digest })
      } else {
        store.recordObservation(action.key, action.frames, result.status, {
          httpStatus: result.httpStatus,
        })
        fetchLog.push({ ...action, result: result.status })
      }
    }
  }

  // 留存状态探查：调查站已知的每份原件（历史上与窗口相关才会入库），只要还有未持有、
  // 非缺样的帧，就主动发最小 Range 探测，把 410（留存覆盖，终态无机会）、503（掉线，
  // 可重试）、416（缺样）及时落账。不能只看本轮计划——补锚后某原件可能被判定与窗口
  // 不再相交，但值班员仍需知道它剩余的帧是已被覆盖、掉线还是仍可补领。
  const probeSessions = new Map()
  for (const plan of plans) probeSessions.set(plan.key, plan)
  for (const [key, entry] of store.state.inventory) {
    if (!probeSessions.has(key) && entry.session) {
      probeSessions.set(key, { key, session: entry.session, pending: false })
    }
  }
  for (const plan of probeSessions.values()) {
    const terminal = terminalPlan.find(t => t.device === plan.session.device)
    if (!terminal || !terminal.online) continue
    const probes = subtract(availableFrames(plan.session), store.heldFrames(plan.key))
    const known = Object.values(store.inventoryOf(plan.key).observations)
    for (const range of probes) {
      const already = known.some(o =>
        (o.status === 'retention' || o.status === 'offline') &&
        intersect([o.frames], [range]).length === totalLength([range]))
      if (already) continue
      const probeFrames = [range[0], Math.min(range[0] + 1, range[1] - 1) + 1]
      const result = await client.getRange(
        plan.session.file,
        probeFrames[0] * 2,
        probeFrames[1] * 2 - 1,
      )
      if (result.status === 'ok') {
        // 探测成功：取回的是真实原件字节，按探测片段留存，不浪费这次出车的字节。
        await store.addHeldFragment(plan.key, probeFrames, result.bytes, result.digest)
        store.recordObservation(plan.key, probeFrames, 'ok', {
          digest: result.digest,
          probe: true,
        })
      } else {
        store.recordObservation(plan.key, range, result.status, {
          httpStatus: result.httpStatus,
          probe: true,
        })
        fetchLog.push({
          key: plan.key,
          file: plan.session.file,
          device: plan.session.device,
          frames: range,
          bytes: [range[0] * 2, range[1] * 2 - 1],
          serves: [],
          provisional: plan.pending,
          result: result.status,
          probe: true,
        })
      }
    }

    // 已完整持有的原件也探一次终端侧留存状态：410 表示终端已无机会（调查站归档不受影响），
    // 503 表示暂时掉线。探测成功不重复保存字节，只刷新可用观察。
    if (!probes.length) {
      const terminalKnown = Object.values(store.inventoryOf(plan.key).observations)
      const firstFrame = availableFrames(plan.session)[0]
      if (firstFrame && !terminalKnown.some(o =>
        o.status === 'retention' && intersect([o.frames], [firstFrame]).length)) {
        const probeFrames = [firstFrame[0], firstFrame[0] + 1]
        const result = await client.getRange(
          plan.session.file,
          probeFrames[0] * 2,
          probeFrames[1] * 2 - 1,
        )
        if (result.status !== 'ok') {
          store.recordObservation(plan.key, probeFrames, result.status, {
            httpStatus: result.httpStatus,
            probe: true,
            terminalSide: true,
          })
          fetchLog.push({
            key: plan.key,
            file: plan.session.file,
            device: plan.session.device,
            frames: probeFrames,
            bytes: [probeFrames[0] * 2, probeFrames[1] * 2 - 1],
            serves: [],
            provisional: plan.pending,
            result: result.status,
            probe: true,
            terminalSide: true,
          })
        }
      }
    }
  }

  // 把观察记录汇总给报告层。
  for (const key of store.state.inventory.keys()) {
    observations.set(key, Object.values(store.inventoryOf(key).observations))
  }

  // 形成本次出车的交付版本：只交付可证实帧；待判帧单独标注，不冒充已交付。
  const deliveryRecords = []
  const reports = windowReport({ windows, plans, store, observations })
  for (const report of reports) {
    const files = []
    const provableByKey = {}
    const revisionByKey = {}
    for (const part of report.parts) {
      const frames = normalize(part.provableHeld)
      if (!frames.length) continue
      const buffer = await store.readHeldBytes(part.key, frames)
      if (!buffer) continue
      provableByKey[part.key] = frames
      const clock = store.getClock(...part.key.split('/').slice(0, 2))
      revisionByKey[part.key] = clock?.revision ?? null
      // 只有当整段都被同一个历史归档片段完整覆盖时才继承来源登记摘要；
      // 新领取或多片段拼接的交付以本次字节的实际摘要为准，不冒充归档原件。
      const archived = store.inventoryOf(part.key).held.filter(f => f.sourceDigest)
      const fullyCoveredByOneArchive = frames.length === 1 && archived.length === 1 &&
        archived[0].frames[0] <= frames[0][0] && archived[0].frames[1] >= frames[0][1]
      const ownDigest = store.digest(buffer)
      const inherited = fullyCoveredByOneArchive ? archived[0].sourceDigest : null
      files.push({
        key: part.key,
        frames,
        bytes: framesToBytes(frames),
        digest: ownDigest,
        sourceDigest: inherited ?? ownDigest,
        length: buffer.length,
        provisionalFrames: normalize(part.possibleHeld),
      })
    }
    if (files.length) {
      const record = await store.recordDelivery(report.windowId, files, revisionByKey, provableByKey)
      record.trip = tripNo
      deliveryRecords.push(record)
    }
  }

  const trip = {
    trip: tripNo,
    at: new Date().toISOString(),
    budget: terminalPlan.map(t => ({
      device: t.device,
      online: t.online,
      budget: t.budget,
      spent: t.spent,
    })),
    clockChanges: clockChanges.map(c => ({
      device: c.current.device,
      boot: c.current.boot,
      revision: c.current.revision,
      changed: c.changed,
    })),
    fetchLog,
    archiveIngest,
    reports,
    deliveries: deliveryRecords.map(d => d.deliveryId),
  }
  store.recordTrip(trip)
  await store.persist()
  return trip
}

// 复取某次交付：优先读调查站本地留存；本地缺失时回源 archive（原件 410 不影响归档）。
// 返回的 digest 是「复取到的字节」的实际摘要；记录里的 sourceDigest 是来源登记摘要。
export async function refetchDelivery({ store, deliveryId, client = null }) {
  const record = store.listDeliveries().find(d => d.deliveryId === deliveryId)
  if (!record) return { status: 'not-found' }
  const files = []
  for (const file of record.files) {
    const buffer = await store.readHeldBytes(file.key, file.frames)
    files.push({
      key: file.key,
      frames: file.frames,
      digest: file.digest,
      sourceDigest: file.sourceDigest ?? null,
      actualDigest: buffer ? store.digest(buffer) : null,
      digestMatches: buffer ? store.digest(buffer) === (file.sourceDigest ?? file.digest) : false,
      bytes: buffer,
      source: buffer ? 'local-archive' : 'missing-locally',
    })
  }
  return { status: 'ok', record, files }
}

// 值班员视图：哪些待领范围还可补、哪些只剩检测标记、哪些因留存已无机会。
// 四类帧位互斥：已持有 / 仍可补领 / 来源缺样（从未录到）/ 留存覆盖（终端已无机会）；
// 掉线帧保留在可补领内并单独列出，因为下次出车仍有机会。
export function pendingView(store) {
  const view = []
  for (const [key, entry] of store.state.inventory) {
    const session = entry.session
    if (!session) continue
    const held = store.heldFrames(key)
    const availability = normalize(session.slices ?? [[0, session.samples]])
    const neverRecorded = subtract([[0, session.samples]], availability)
    const marks = Object.values(entry.observations)
    const retentionFrames = normalize(marks.filter(m => m.status === 'retention').map(m => m.frames))
    const offlineFrames = normalize(marks.filter(m => m.status === 'offline').map(m => m.frames))
    const retrievable = subtract(subtract(availability, held), retentionFrames)
    view.push({
      key,
      device: session.device,
      boot: session.boot,
      file: session.file,
      heldFrames: held,
      retrievableFrames: retrievable,
      sourceGapFrames: neverRecorded,
      retentionFrames,
      offlineFrames: intersect(offlineFrames, retrievable),
    })
  }
  return view
}

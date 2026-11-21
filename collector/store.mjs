// 调查站本地留存：持久化已经领到的原始片段、交付版本、对时修订与出车台账。
//
// 设计要点：
//   - 片段只按「设备 + 启动 + 原件文件」定位；终端重启复用旧文件名时，boot 不同即视为不同原件。
//   - 已领取字节按片段保存，补锚改变窗口相交范围后直接复用，不重复出车领取。
//   - 任何情况下都不写填充音：缺样、掉线、留存覆盖只落状态标记。
//   - 交付留版本，鉴听员可复取早先一版并查看归属变化。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { normalize, intersect, subtract, totalLength } from './intervals.mjs'

export function sessionKey(session) {
  return `${session.device}/${session.boot}/${session.file.split('/').pop()}`
}

export function framesToBytes(frameRanges) {
  // PCM 有符号 16 位、小端、单声道：每帧 2 字节，帧区间与字节区间线性对应。
  return normalize(frameRanges).map(([left, right]) => [left * 2, right * 2])
}

export function bytesToFrames(byteRanges) {
  return normalize(byteRanges).map(([left, right]) => [Math.floor(left / 2), Math.ceil(right / 2)])
}

export function createStore(dir) {
  const statePath = `${dir}/state.json`
  const fragmentDir = `${dir}/fragments`
  let state = {
    version: 1,
    windows: new Map(),
    sessions: new Map(),
    clocks: new Map(),
    // key -> { session, held: [{ frames, bytes:[start,end], digest, file }], observations: {frameRange: status} }
    inventory: new Map(),
    // windowId -> [{ deliveryId, at, clockRevision, files, provableFramesByKey }]
    deliveries: new Map(),
    trips: [],
  }

  function clockKeyOf(device, boot) {
    return `${device}/${boot}`
  }

  async function load() {
    await mkdir(dir, { recursive: true })
    await mkdir(fragmentDir, { recursive: true })
    try {
      const raw = JSON.parse(await readFile(statePath, 'utf8'))
      state.windows = new Map(raw.windows)
      state.sessions = new Map(raw.sessions)
      state.clocks = new Map(raw.clocks)
      state.inventory = new Map(raw.inventory)
      state.deliveries = new Map(raw.deliveries)
      state.trips = raw.trips ?? []
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  async function persist() {
    const raw = {
      version: state.version,
      windows: [...state.windows],
      sessions: [...state.sessions],
      clocks: [...state.clocks],
      inventory: [...state.inventory],
      deliveries: [...state.deliveries],
      trips: state.trips,
    }
    await mkdir(dir, { recursive: true })
    await writeFile(statePath, JSON.stringify(raw, null, 2))
  }

  function upsertWindow(window) {
    const prev = state.windows.get(window.id)
    state.windows.set(window.id, { ...prev, ...window })
    return state.windows.get(window.id)
  }

  function upsertSession(session) {
    const key = sessionKey(session)
    const prev = state.sessions.get(key)
    // 同一 boot 下清单可能刷新（例如切片状态变化），以新清单为准但保留已观察状态。
    state.sessions.set(key, { ...prev, ...session, key })
    if (!state.inventory.has(key)) {
      state.inventory.set(key, { session: state.sessions.get(key), held: [], observations: {} })
    } else {
      state.inventory.get(key).session = state.sessions.get(key)
    }
    return state.sessions.get(key)
  }

  function recordClock(clock) {
    const key = clockKeyOf(clock.device, clock.boot)
    const previous = state.clocks.get(key)
    state.clocks.set(key, clock)
    return { previous, current: clock, changed: !previous || previous.revision !== clock.revision }
  }

  function getClock(device, boot) {
    return state.clocks.get(clockKeyOf(device, boot)) ?? null
  }

  function inventoryOf(key) {
    if (!state.inventory.has(key)) {
      state.inventory.set(key, {
        session: state.sessions.get(key) ?? null,
        held: [],
        observations: {},
      })
    }
    return state.inventory.get(key)
  }

  // 已持有字节覆盖到的帧区间。
  function heldFrames(key) {
    return normalize(inventoryOf(key).held.map(item => item.frames))
  }

  function heldBytes(key) {
    return normalize(inventoryOf(key).held.map(item => item.bytes))
  }

  // 记录一次取件观察。gap/offline/retention 都只落标记，绝不产生替代字节。
  function recordObservation(key, frameRange, status, detail = {}) {
    const entry = inventoryOf(key)
    const tag = `${frameRange[0]}-${frameRange[1]}`
    const previous = entry.observations[tag]
    entry.observations[tag] = {
      frames: frameRange,
      status,
      detail,
      at: new Date().toISOString(),
      // retention 是终态；offline 可被后续成功覆盖；gap 也是终态（来源明确缺样）。
      supersedes: previous ? previous.status : null,
    }
  }

  function observationsIn(key, frameRanges) {
    const entry = inventoryOf(key)
    const result = []
    for (const item of Object.values(entry.observations)) {
      if (intersect([item.frames], frameRanges).length) result.push(item)
    }
    return result
  }

  // 保存一段真实取回的原始字节。frameRange 为该字节在原件中的帧位置，buffer 为字节本体。
  // 绝不接收任何填充音：调用方只能传 HTTP 实际取回或归档复取的字节。
  // 同一帧区间（例如归档在两次出车间重复摄入）只保留一份，避免复取时重复拼接。
  async function addHeldFragment(key, frameRange, buffer, digest = createHash('sha256').update(buffer).digest('hex')) {
    const entry = inventoryOf(key)
    const frames = normalize([frameRange])[0]
    const byteRange = [frames[0] * 2, frames[1] * 2 - 1]
    if (buffer.length !== byteRange[1] - byteRange[0] + 1) {
      throw new Error(`片段字节长度 ${buffer.length} 与帧区间 ${frames.join('-')} 不符`)
    }
    const duplicate = entry.held.find(f =>
      f.frames[0] === frames[0] && f.frames[1] === frames[1] && f.digest === digest)
    if (duplicate) return duplicate
    const file = `${key.replaceAll('/', '_')}_${byteRange[0]}-${byteRange[1]}.pcm`
    await mkdir(fragmentDir, { recursive: true })
    await writeFile(`${fragmentDir}/${file}`, buffer)
    const fragment = {
      frames,
      bytes: byteRange,
      digest,
      file,
      at: new Date().toISOString(),
    }
    entry.held.push(fragment)
    entry.held.sort((a, b) => a.frames[0] - b.frames[0])
    return fragment
  }

  async function readHeldBytes(key, frameRanges) {
    // 按已持有片段拼出请求帧区间的字节；若有缺口返回 null，由调用方决定先补领。
    // 对片段重叠/重复入库保持安全：每个目标帧位最多取一次。
    const wanted = normalize(Array.isArray(frameRanges[0]) ? frameRanges : [frameRanges])
    const covered = intersect(heldFrames(key), wanted)
    if (totalLength(covered) !== totalLength(wanted)) return null
    const chunks = []
    for (const [left, right] of wanted) {
      for (let frame = left; frame < right;) {
        const fragment = inventoryOf(key).held.find(f => frame >= f.frames[0] && frame < f.frames[1])
        if (!fragment) return null
        const take = Math.min(right, fragment.frames[1]) - frame
        const offset = (frame - fragment.frames[0]) * 2
        const all = await readFile(`${fragmentDir}/${fragment.file}`)
        chunks.push(all.subarray(offset, offset + take * 2))
        frame += take
      }
    }
    return Buffer.concat(chunks)
  }

  // 登记一次交付（同一窗口可多次交付，保留全部版本）。
  async function recordDelivery(windowId, files, clockRevisionByKey, provableByKey) {
    const list = state.deliveries.get(windowId) ?? []
    const deliveryId = `D-${windowId}-r${list.length + 1}`
    const record = {
      deliveryId,
      window: windowId,
      at: new Date().toISOString(),
      clockRevision: Object.values(clockRevisionByKey)[0] ?? null,
      clockRevisions: clockRevisionByKey,
      files,
      provableFramesByKey: provableByKey,
    }
    list.push(record)
    state.deliveries.set(windowId, list)
    return record
  }

  function listDeliveries(windowId) {
    if (windowId) return state.deliveries.get(windowId) ?? []
    return [...state.deliveries.values()].flat()
  }

  function recordTrip(trip) {
    state.trips.push(trip)
  }

  function snapshot() {
    return {
      windows: [...state.windows.values()],
      sessions: [...state.sessions.values()],
      clocks: [...state.clocks.values()],
      inventory: [...state.inventory.entries()].map(([key, entry]) => [
        key,
        {
          held: entry.held.map(({ frames, bytes, digest, file, at }) => ({ frames, bytes, digest, file, at })),
          observations: entry.observations,
        },
      ]),
      deliveries: [...state.deliveries.values()].flat(),
      trips: state.trips,
    }
  }

  return {
    load,
    persist,
    upsertWindow,
    upsertSession,
    recordClock,
    getClock,
    sessionKey,
    inventoryOf,
    heldFrames,
    heldBytes,
    recordObservation,
    observationsIn,
    addHeldFragment,
    readHeldBytes,
    recordDelivery,
    listDeliveries,
    recordTrip,
    snapshot,
    digest: buffer => createHash('sha256').update(buffer).digest('hex'),
    get state() {
      return state
    },
  }
}

// 计算还需领取的帧区间：目标帧 - 已持有帧。
export function missingFrames(store, key, wantedFrames) {
  return subtract(wantedFrames, store.heldFrames(key))
}

// 资料源 HTTP 客户端：拉取清单、按 Range 领取字节，并区分三种取不到的情形。
//
// 状态语义（值班员必须能区分，三者对下一次出车的意义不同）：
//   offline   取件暂时掉线（HTTP 503）——原件还在，下次出车值得重试
//   retention 已被留存覆盖（HTTP 410）——该原件已无机会，重试没有意义
//   gap       来源明确缺样（切片空档 / 416 超保留范围）——该段从未录到，不能用填充音代替
//   ok        实际取回了原始字节

import { createHash } from 'node:crypto'

export class SourceError extends Error {
  constructor(kind, message, { status, path } = {}) {
    super(message)
    this.name = 'SourceError'
    this.kind = kind
    this.status = status
    this.path = path
  }
}

export function createClient(origin, { timeoutMs = 5000, retriesOn503 = 1 } = {}) {
  const base = new URL(origin)

  async function getJson(path) {
    const response = await fetch(new URL(path, base), {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status === 503) {
      throw new SourceError('offline', `资料源暂时不可用：${path}`, { status: 503, path })
    }
    if (!response.ok) {
      throw new SourceError('error', `读取 ${path} 失败：HTTP ${response.status}`, {
        status: response.status,
        path,
      })
    }
    return response.json()
  }

  // 按字节范围领取原件。返回 { status, bytes, contentRange, digest }。
  // 410 与 503 不抛错，由调用方按业务状态落账；其它非 2xx/2xx 状态抛出。
  async function getRange(path, firstByte, lastByte) {
    const doFetch = async () => fetch(new URL(path, base), {
      headers: { range: `bytes=${firstByte}-${lastByte}` },
      signal: AbortSignal.timeout(timeoutMs),
    })

    let response = await doFetch()
    let attempts = 0
    while (response.status === 503 && attempts < retriesOn503) {
      attempts += 1
      response = await doFetch()
    }

    if (response.status === 503) {
      return { status: 'offline', httpStatus: 503, path, bytes: null }
    }
    if (response.status === 410) {
      return { status: 'retention', httpStatus: 410, path, bytes: null }
    }
    if (response.status === 416) {
      return { status: 'gap', httpStatus: 416, path, bytes: null }
    }
    if (response.status !== 206 && response.status !== 200) {
      throw new SourceError('error', `领取 ${path} 失败：HTTP ${response.status}`, {
        status: response.status,
        path,
      })
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    const digest = createHash('sha256').update(bytes).digest('hex')
    return {
      status: 'ok',
      httpStatus: response.status,
      path,
      bytes,
      contentRange: response.headers.get('content-range'),
      digest,
    }
  }

  async function getBytes(path) {
    const result = await getRange(path, 0, 0)
    if (result.status !== 'ok') return result
    // 无 Range 的整取，用于调查站归档复取。
    const response = await fetch(new URL(path, base), {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status === 503) return { status: 'offline', httpStatus: 503, path, bytes: null }
    if (response.status === 410) return { status: 'retention', httpStatus: 410, path, bytes: null }
    if (!response.ok) {
      throw new SourceError('error', `读取 ${path} 失败：HTTP ${response.status}`, {
        status: response.status,
        path,
      })
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    return {
      status: 'ok',
      httpStatus: response.status,
      path,
      bytes,
      digest: createHash('sha256').update(bytes).digest('hex'),
    }
  }

  return { getJson, getRange, getBytes, origin: base.toString() }
}

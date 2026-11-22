import { describe, expect, it } from 'vitest'
import { decodeChildOutput, pythonUtf8Env } from '../bridge/child-output.mjs'

/**
 * Python 子进程输出的解码。
 *
 * 中文 Windows 上 Python 把 stdout 写成控制台代码页（cp936/GBK），Node 默认按 UTF-8
 * 解 —— 收割器的报错于是变成一片乱码（"AI空间" 会显示成 "AI��n��"）。
 * 这里固定住两条约定：UTF-8 原样通过，GBK 能还原成中文。
 */

/** 「空间」两个字的 GBK 编码（cp936，代码页 936 的标准编码）。 */
const SPACE_GBK = Buffer.from([0xbf, 0xd5, 0xbc, 0xe4])

describe('decodeChildOutput', () => {
  it('passes UTF-8 text through unchanged', () => {
    const text = '{"ok": false, "error": "AI空间 的 WebView2 没在跑"}'
    expect(decodeChildOutput(Buffer.from(text, 'utf8'))).toBe(text)
  })

  it('recovers Chinese text from a GBK payload', () => {
    expect(decodeChildOutput(SPACE_GBK)).toBe('空间')
  })

  it('recovers a GBK payload that mixes ASCII and Chinese', () => {
    // 「AI空间 的 WebView2 没在跑」的 cp936 编码。
    const payload = Buffer.from([
      0x41, 0x49, 0xbf, 0xd5, 0xbc, 0xe4, 0x20, 0xb5, 0xc4, 0x20,
      0x57, 0x65, 0x62, 0x56, 0x69, 0x65, 0x77, 0x32, 0x20,
      0xc3, 0xbb, 0xd4, 0xda, 0xc5, 0xdc,
    ])
    expect(decodeChildOutput(payload)).toBe('AI空间 的 WebView2 没在跑')
  })

  it('accepts a string as well as a buffer', () => {
    expect(decodeChildOutput('纯 ASCII')).toBe('纯 ASCII')
  })

  it('keeps the UTF-8 reading when neither encoding fits', () => {
    const broken = Buffer.from([0xff, 0xfe, 0xfd])
    expect(decodeChildOutput(broken)).toBe(broken.toString('utf8'))
  })
})

describe('pythonUtf8Env', () => {
  it('makes the child write UTF-8', () => {
    const env = pythonUtf8Env()
    expect(env.PYTHONIOENCODING).toBe('utf-8')
    expect(env.PYTHONUTF8).toBe('1')
  })

  it('keeps the rest of the environment', () => {
    expect(pythonUtf8Env()).toHaveProperty('PATH')
  })
})
